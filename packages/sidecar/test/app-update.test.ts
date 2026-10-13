import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppUpdateState } from "@forge/protocol";
import { AppUpdateService, changeRange, compareVersions, installedRuntimeKey, MAX_CHANGE_RELEASES, pickRelease, UPDATE_REPO, type Release } from "../src/update/app-update.js";

const INSTALLER = Buffer.from("MZ fake installer");
const DIGEST = `sha256:${createHash("sha256").update(INSTALLER).digest("hex")}`;

const KEY = "node-24.21.0_git-2.56.0.2_gh-2.102.0";

/** A release as the releases list returns it; by default a full installer only (like 0.1.1 to 0.1.6). */
function rel(tag: string, assets: string[] = [`FORGE_${tag.slice(1)}_x64-setup.exe`], digest: string | null = DIGEST): Release {
  return { tag_name: tag, body: "- feat: Update-Funktion", published_at: "2026-10-12T10:00:00Z", assets: assets.map((name) => ({ name, size: INSTALLER.length, digest })) };
}

/** The answer of the releases list with one release. */
function release(tag: string, digest: string | null = DIGEST) {
  return JSON.stringify([rel(tag, undefined, digest)]);
}

/** Own file per test: the real one in the temp folder belongs to the installed app. */
function chainFile() {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "forge-chain-")), "chain.json");
}

function service(answer: (args: string[]) => { code: number; stdout?: string; stderr?: string }, version = "0.1.0", opts: { runtimeKey?: string | null; chainFile?: string } = {}) {
  const calls: string[][] = [];
  const states: AppUpdateState[] = [];
  const svc = new AppUpdateService({
    emit: (s) => states.push(s),
    enabled: () => true,
    log: () => {},
    currentVersion: version,
    installable: true,
    runtimeKey: () => (opts.runtimeKey === undefined ? KEY : opts.runtimeKey),
    chainFile: opts.chainFile ?? chainFile(),
    gh: async (args) => {
      calls.push(args);
      if (args[0] === "release" && args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1]!;
        const name = args[args.indexOf("--pattern") + 1]!;
        writeFileSync(path.join(dir, name), INSTALLER);
      }
      const a = answer(args);
      return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
    },
  });
  return { svc, calls, states };
}

describe("app updates", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("v0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.2.0-beta", "0.2.0")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
  });

  it("offers a newer release, downloads the installer and checks its SHA-256", async () => {
    const { svc, calls } = service(() => ({ code: 0, stdout: release("v0.1.7") }));
    const checked = await svc.check();
    expect(calls[0]).toEqual(["api", `repos/${UPDATE_REPO}/releases?per_page=100`]);
    expect(checked).toMatchObject({ phase: "available", autoInstall: false, latest: { version: "0.1.7", tag: "v0.1.7", notes: "- feat: Update-Funktion", since: "0.1.0", kind: "full", via: null } });
    const ready = await svc.download();
    expect(ready.phase).toBe("ready");
    expect(readFileSync(ready.installerPath!)).toEqual(INSTALLER);
    expect(calls[1]).toEqual(expect.arrayContaining(["release", "download", "v0.1.7", "--repo", UPDATE_REPO, "--pattern", "FORGE_0.1.7_x64-setup.exe"]));
    // Checking again keeps the downloaded installer of the same release.
    expect((await svc.check()).phase).toBe("ready");
  });

  it("drops an installer whose checksum does not match", async () => {
    const { svc } = service(() => ({ code: 0, stdout: release("v0.1.8", "sha256:" + "0".repeat(64)) }));
    await svc.check();
    const r = await svc.download();
    expect(r).toMatchObject({ phase: "error", message: expect.stringMatching(/Prüfsumme/) });
    expect(r.installerPath).toBeNull();
  });

  it("says up to date for the same or an older release and explains a missing GitHub login", async () => {
    expect((await service(() => ({ code: 0, stdout: release("v0.1.0") })).svc.check()).phase).toBe("uptodate");
    expect((await service(() => ({ code: 0, stdout: release("v0.0.9") })).svc.check()).phase).toBe("uptodate");
    const noLogin = await service(() => ({ code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login" })).svc.check();
    expect(noLogin).toMatchObject({ phase: "error", message: expect.stringMatching(/bei GitHub anmelden/) });
    const none = await service(() => ({ code: 1, stderr: "HTTP 404: Not Found" })).svc.check();
    expect(none).toMatchObject({ phase: "uptodate", message: "Noch kein Release veröffentlicht." });
  });

  it("lets Claude write the changelog from notes and commits, and says why there is none", async () => {
    const prompts: string[] = [];
    let ready: "ok" | "no-login" = "no-login";
    const svc = new AppUpdateService({
      emit: () => {},
      enabled: () => true,
      log: () => {},
      currentVersion: "0.1.0",
      installable: true,
      chainFile: chainFile(),
      gh: async (args) =>
        args[1]?.includes("/compare/")
          ? { code: 0, stdout: "feat: Backups\nfix: Telefon\n", stderr: "" }
          : { code: 0, stdout: release("v0.2.0"), stderr: "" },
      claudeReady: async () => ready,
      writeChangelog: async (prompt) => {
        prompts.push(prompt);
        return "- Backups der Einstellungen\n";
      },
    });
    expect(svc.changelog()).toBeNull();
    await svc.check();
    // Returns at once while Claude writes; the commit messages are there right away.
    expect(svc.changelog()).toMatchObject({ tag: "v0.2.0", status: "writing", text: null });
    expect(await svc.changelogDone()).toMatchObject({ status: "unavailable", unavailable: "no-login", commits: ["feat: Backups", "fix: Telefon"] });
    // Reported once, then tried again: signing in later works.
    expect(svc.changelog()).toMatchObject({ unavailable: "no-login" });
    ready = "ok";
    svc.changelog();
    expect(await svc.changelogDone()).toMatchObject({ status: "ready", text: "- Backups der Einstellungen", unavailable: null });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("- feat: Backups");
    expect(prompts[0]).toContain("- feat: Update-Funktion");
    expect(svc.changelog()?.status).toBe("ready");
    expect(prompts).toHaveLength(1);
  });

  it("lists every release since the installed version, at most the newest MAX_CHANGE_RELEASES", () => {
    const list = [rel("v0.1.15"), rel("v0.1.13"), rel("v0.1.14"), rel("v0.1.12"), { ...rel("v0.1.16"), draft: true }];
    const range = changeRange(list, "0.1.12")!;
    expect(range.releases.map((r) => r.tag_name)).toEqual(["v0.1.15", "v0.1.14", "v0.1.13"]);
    expect(range).toMatchObject({ since: "0.1.12", sinceTag: "v0.1.12", capped: false });
    expect(changeRange(list, "0.1.15")).toBeNull();

    // A local build (0.1.0) would get every release ever made: only the newest ones, from the release before them.
    const many = Array.from({ length: MAX_CHANGE_RELEASES + 10 }, (_, i) => rel(`v0.1.${i + 1}`));
    const capped = changeRange(many, "0.1.0")!;
    expect(capped.releases).toHaveLength(MAX_CHANGE_RELEASES);
    expect(capped.releases[0]!.tag_name).toBe(`v0.1.${MAX_CHANGE_RELEASES + 10}`);
    expect(capped).toMatchObject({ since: "0.1.10", sinceTag: "v0.1.10", capped: true });
  });

  it("writes the changelog over all releases between the installed and the offered version", async () => {
    const prompts: string[] = [];
    const calls: string[][] = [];
    const list = [
      { ...rel("v0.1.15", [`FORGE_0.1.15_update_${KEY}.zip`]), body: "- feat: Diktat live" },
      { ...rel("v0.1.14", [`FORGE_0.1.14_update_${KEY}.zip`]), body: "- feat: Session-Tabs" },
      { ...rel("v0.1.13", [`FORGE_0.1.13_update_${KEY}.zip`]), body: "- fix: Push auf geschützten Branches" },
      { ...rel("v0.1.12"), body: "- feat: schon installiert" },
    ];
    const svc = new AppUpdateService({
      emit: () => {},
      enabled: () => true,
      log: () => {},
      currentVersion: "0.1.12",
      installable: true,
      runtimeKey: () => KEY,
      chainFile: chainFile(),
      gh: async (args) => {
        calls.push(args);
        return args[1]?.includes("/compare/")
          ? { code: 0, stdout: "feat: Session-Tabs\nfix: Push\nfeat: Diktat live\n", stderr: "" }
          : { code: 0, stdout: JSON.stringify(list), stderr: "" };
      },
      claudeReady: async () => "ok",
      writeChangelog: async (prompt) => {
        prompts.push(prompt);
        return "- Diktat schreibt live";
      },
    });
    const s = await svc.check();
    expect(s.latest).toMatchObject({ version: "0.1.15", since: "0.1.12", kind: "patch" });
    expect(s.latest!.notes).toBe("### 0.1.15\n- feat: Diktat live\n\n### 0.1.14\n- feat: Session-Tabs\n\n### 0.1.13\n- fix: Push auf geschützten Branches");
    expect(await svc.changelogDone()).toMatchObject({ status: "ready", commits: ["feat: Session-Tabs", "fix: Push", "feat: Diktat live"] });
    expect(calls.find((a) => a[1]?.includes("/compare/"))?.[1]).toBe(`repos/${UPDATE_REPO}/compare/v0.1.12...v0.1.15`);
    const prompt = prompts[0]!;
    expect(prompt).toContain("alle 3 Versionen nach 0.1.12 bis einschließlich 0.1.15");
    for (const line of ["Version 0.1.15:\n- feat: Diktat live", "Version 0.1.14:\n- feat: Session-Tabs", "Version 0.1.13:\n- fix: Push auf geschützten Branches", "- fix: Push"]) expect(prompt).toContain(line);
    expect(prompt).not.toContain("schon installiert");
    expect(prompt).not.toContain("ältere Änderungen fehlen");
  });

  it("caps the changelog input of a local build and says so", async () => {
    const prompts: string[] = [];
    const calls: string[][] = [];
    const big = Array.from({ length: 80 }, (_, i) => `- feat: Änderung Nummer ${i} mit etwas mehr Text`).join("\n");
    const list = Array.from({ length: MAX_CHANGE_RELEASES + 15 }, (_, i) => ({ ...rel(`v0.1.${i + 1}`), body: big }));
    const commits = Array.from({ length: 400 }, (_, i) => `feat: Commit ${i}`).join("\n");
    const svc = new AppUpdateService({
      emit: () => {},
      enabled: () => true,
      log: () => {},
      currentVersion: "0.1.0",
      installable: true,
      runtimeKey: () => null,
      chainFile: chainFile(),
      gh: async (args) => {
        calls.push(args);
        return { code: 0, stdout: args[1]?.includes("/compare/") ? commits : JSON.stringify(list), stderr: "" };
      },
      claudeReady: async () => "ok",
      writeChangelog: async (prompt) => {
        prompts.push(prompt);
        return "- Vieles";
      },
    });
    const s = await svc.check();
    expect(s.latest).toMatchObject({ version: "0.1.35", since: "0.1.15" });
    const log = await svc.changelogDone();
    expect(log!.commits).toHaveLength(150);
    expect(log!.commits.at(-1)).toBe("feat: Commit 399");
    expect(calls.find((a) => a[1]?.includes("/compare/"))?.[1]).toBe(`repos/${UPDATE_REPO}/compare/v0.1.15...v0.1.35`);
    const prompt = prompts[0]!;
    expect(prompt).toContain(`nur die letzten ${MAX_CHANGE_RELEASES} Versionen nach 0.1.15, ältere Änderungen fehlen`);
    expect(prompt).toContain("Version 0.1.35:");
    expect(prompt).toContain("(gekürzt)");
    expect(prompt).toMatch(/Notizen der \d+ ältesten Versionen aus Platzgründen weggelassen/);
    expect(prompt).toContain("nur die neuesten 150, 250 ältere weggelassen");
    expect(prompt.length).toBeLessThan(25_000);
  });

  it("takes the small update for the installed runtime, else the newest full installer", () => {
    const list = [
      rel("v0.1.9", [`FORGE_0.1.9_update_${KEY}.zip`]),
      rel("v0.1.8", [`FORGE_0.1.8_update_${KEY}.zip`, `FORGE_0.1.8_${KEY}_x64-setup.exe`]),
      rel("v0.1.6"),
      { ...rel("v0.2.0-beta", [`FORGE_0.2.0-beta_update_${KEY}.zip`]), prerelease: true },
    ];
    // Same runtime: the newest release, a few MB.
    expect(pickRelease(list, "0.1.6", KEY)).toMatchObject({ kind: "patch", newest: { tag_name: "v0.1.9" }, release: { tag_name: "v0.1.9" }, asset: { name: `FORGE_0.1.9_update_${KEY}.zip` } });
    // Older runtime (or none): the newest full installer first, the newest version stays the goal.
    expect(pickRelease(list, "0.1.6", "node-22.0.0_git-2.50.0_gh-2.90.0")).toMatchObject({ kind: "full", newest: { tag_name: "v0.1.9" }, release: { tag_name: "v0.1.8" } });
    expect(pickRelease(list, "0.1.0", null)).toMatchObject({ kind: "full", newest: { tag_name: "v0.1.9" }, release: { tag_name: "v0.1.8" } });
    expect(pickRelease(list, "0.1.9", KEY)).toBeNull();
  });

  it("sorts 0.1.10 above 0.1.9, whatever order GitHub lists them in", () => {
    const list = [rel("v0.1.9", [`FORGE_0.1.9_update_${KEY}.zip`]), rel("v0.1.10", [`FORGE_0.1.10_update_${KEY}.zip`]), rel("v0.1.8", [`FORGE_0.1.8_update_${KEY}.zip`])];
    expect(pickRelease(list, "0.1.7", KEY)).toMatchObject({ newest: { tag_name: "v0.1.10" }, release: { tag_name: "v0.1.10" } });
  });

  it("offers the newest version over a full installer and installs its small update after the restart", async () => {
    const OLD = "node-22.0.0_git-2.50.0_gh-2.90.0";
    const list = JSON.stringify([
      rel("v0.1.15", [`FORGE_0.1.15_update_${KEY}.zip`]),
      rel("v0.1.10", [`FORGE_0.1.10_update_${KEY}.zip`]),
      rel("v0.1.9", [`FORGE_0.1.9_update_${KEY}.zip`, `FORGE_0.1.9_${KEY}_x64-setup.exe`]),
      rel("v0.1.7"),
    ]);
    const chain = chainFile();
    const before = service(() => ({ code: 0, stdout: list }), "0.1.7", { runtimeKey: OLD, chainFile: chain });
    expect(await before.svc.check()).toMatchObject({ autoInstall: false, latest: { version: "0.1.15", tag: "v0.1.15", kind: "full", via: "0.1.9" } });
    expect((await before.svc.download()).phase).toBe("ready");
    expect(before.calls[1]).toEqual(expect.arrayContaining(["release", "download", "v0.1.9", "--pattern", `FORGE_0.1.9_${KEY}_x64-setup.exe`]));
    expect(existsSync(chain)).toBe(true);

    // After the full installer: 0.1.9 with the new runtime finds the small update and installs it without asking.
    const after = service(() => ({ code: 0, stdout: list }), "0.1.9", { chainFile: chain });
    expect(await after.svc.check()).toMatchObject({ autoInstall: true, latest: { version: "0.1.15", kind: "patch", via: null } });
    expect(existsSync(chain)).toBe(false);
    // Only once: the next check asks again.
    expect((await after.svc.check()).autoInstall).toBe(false);
  });

  it("downloads the small update and checks it like an installer", async () => {
    const { svc, calls } = service(() => ({ code: 0, stdout: JSON.stringify([rel("v0.1.9", [`FORGE_0.1.9_update_${KEY}.zip`])]) }), "0.1.8");
    expect((await svc.check()).latest).toMatchObject({ kind: "patch", version: "0.1.9" });
    const ready = await svc.download();
    expect(ready.installerPath).toMatch(/FORGE_0\.1\.9_update_node-24\.21\.0_git-2\.56\.0\.2_gh-2\.102\.0\.zip$/);
    expect(calls[1]).toEqual(expect.arrayContaining(["--pattern", `FORGE_0.1.9_update_${KEY}.zip`]));
  });

  it("does not download without a known release", async () => {
    const { svc, calls } = service(() => ({ code: 0 }));
    expect((await svc.download()).phase).toBe("error");
    expect(calls).toEqual([]);
  });

  it("reads the runtime key of the installation", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-runtime-"));
    try {
      expect(installedRuntimeKey(dir)).toBeNull();
      writeFileSync(path.join(dir, "VERSIONS.json"), JSON.stringify({ node: "24.21.0", git: "2.56.0.2", gh: "2.102.0" }));
      expect(installedRuntimeKey(dir)).toBe(KEY);
      // Not undefined: that falls back to FORGE_RUNTIME_DIR, which is set when the tests run inside FORGE.
      expect(installedRuntimeKey("")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

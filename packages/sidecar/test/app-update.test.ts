import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppUpdateState } from "@forge/protocol";
import { AppUpdateService, canInstallUpdates, changeRange, compareVersions, installedRuntimeKey, MAX_CHANGE_RELEASES, pickRelease, platformAssetPattern, platformCandidates, signedOnly, type Release } from "../src/update/app-update.js";
import type { ReleaseSource } from "../src/update/github-releases.js";
import { SIG_MANIFEST, signedMessage } from "../src/update/signature.js";

const INSTALLER = Buffer.from("MZ fake installer");
const DIGEST = `sha256:${createHash("sha256").update(INSTALLER).digest("hex")}`;

const KEY = "node-24.21.0_git-2.56.0.2_gh-2.102.0";

/** Own signing key: the real one only exists in the release workflow. */
const keys = generateKeyPairSync("ed25519");
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const signatureOf = (name: string, content: Buffer = INSTALLER) =>
  sign(null, signedMessage(name, createHash("sha256").update(content).digest("hex")), keys.privateKey).toString("base64");

/** A release as the releases list returns it; by default a full installer only (like 0.1.1 to 0.1.6), every asset signed. */
function rel(tag: string, assets: string[] = [`FORGE_${tag.slice(1)}_x64-setup.exe`], digest: string | null = DIGEST, signed = true): Release {
  return {
    tag_name: tag,
    body: "- feat: Update-Funktion",
    published_at: "2026-10-12T10:00:00Z",
    assets: assets.flatMap((name) => [{ name, size: INSTALLER.length, digest }, ...(signed ? [{ name: `${name}.sig`, size: 88, digest: null }] : [])]),
  };
}

/** A release since 0.1.102: one FORGE_<v>.sig holds the signatures of all assets. */
function relManifest(tag: string, assets: string[] = [`FORGE_${tag.slice(1)}_x64-setup.exe`]): Release {
  return { ...rel(tag, assets, DIGEST, false), assets: [...assets.map((name) => ({ name, size: INSTALLER.length, digest: DIGEST })), { name: `FORGE_${tag.slice(1)}.sig`, size: 300, digest: null }] };
}

/** Own file per test: the real one in the temp folder belongs to the installed app. */
function chainFile() {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "forge-chain-")), "chain.json");
}

interface FakeOpts {
  commits?: string[];
  /** what a download writes instead of the signed installer */
  content?: Buffer;
  /** a download fails with this message */
  fail?: string;
}

/** Releases from `list` (an Error is thrown), downloads write the installer and a matching signature. */
function fakeSource(list: () => Release[] | null | Error, o: FakeOpts = {}) {
  const calls: string[] = [];
  const source: ReleaseSource = {
    releases: async () => {
      calls.push("releases");
      const l = list();
      if (l instanceof Error) throw l;
      return l;
    },
    commits: async (base, head) => {
      calls.push(`compare ${base}...${head}`);
      return o.commits ?? [];
    },
    download: async (asset, file) => {
      calls.push(`download ${asset.name}`);
      if (o.fail) throw new Error(o.fail);
      if (SIG_MANIFEST.test(asset.name!)) {
        const l = list();
        const names = Array.isArray(l) ? l.flatMap((r) => (r.assets ?? []).map((a) => a.name!)) : [];
        writeFileSync(file, JSON.stringify(Object.fromEntries(names.map((n) => [n, signatureOf(n)]))));
      } else writeFileSync(file, asset.name!.endsWith(".sig") ? signatureOf(asset.name!.slice(0, -4)) : (o.content ?? INSTALLER));
    },
  };
  return { source, calls };
}

function service(list: () => Release[] | null | Error, version = "0.1.0", opts: FakeOpts & { runtimeKey?: string | null; chainFile?: string; requestInstall?: () => void; channel?: "stable" | "dev" } = {}) {
  const states: AppUpdateState[] = [];
  const { source, calls } = fakeSource(list, opts);
  const svc = new AppUpdateService({
    platform: "win32-x64",
    emit: (s) => states.push(s),
    enabled: () => true,
    log: () => {},
    currentVersion: version,
    installable: true,
    runtimeKey: () => (opts.runtimeKey === undefined ? KEY : opts.runtimeKey),
    chainFile: opts.chainFile ?? chainFile(),
    requestInstall: opts.requestInstall,
    source,
    publicKey: PUBLIC_KEY,
    channel: opts.channel ? async () => opts.channel! : undefined,
  });
  return { svc, calls, states };
}

describe("app updates", () => {
  it("offers dev pre-releases only on the dev channel, never the release of FORGE Setup", async () => {
    const devBuild = { ...rel("v0.1.9", [`FORGE_0.1.9_update_${KEY}.zip`]), prerelease: true };
    const setup = { ...rel("installer", ["FORGE-Setup.exe"]), prerelease: true };
    const list = () => [devBuild, setup, rel("v0.1.8", [`FORGE_0.1.8_update_${KEY}.zip`]), rel("v0.1.7")];
    const stable = service(list, "0.1.7");
    expect(await stable.svc.check()).toMatchObject({ phase: "available", channel: "stable", latest: { version: "0.1.8", kind: "patch" } });
    const dev = service(list, "0.1.7", { channel: "dev" });
    expect(await dev.svc.check()).toMatchObject({ phase: "available", channel: "dev", latest: { version: "0.1.9", kind: "patch", via: null } });
    // A dev build is ahead of main: back on stable nothing is offered until main passes it.
    expect(await service(list, "0.1.9").svc.check()).toMatchObject({ phase: "uptodate", latest: null });
  });

  it("compares versions numerically", () => {
    expect(compareVersions("v0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersions("0.2.0-beta", "0.2.0")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
  });

  it("offers a newer release, downloads the installer and checks signature and SHA-256", async () => {
    const { svc, calls } = service(() => [rel("v0.1.7")]);
    const checked = await svc.check();
    expect(calls[0]).toBe("releases");
    expect(checked).toMatchObject({ phase: "available", autoInstall: false, latest: { version: "0.1.7", tag: "v0.1.7", notes: "- feat: Update-Funktion", since: "0.1.0", kind: "full", via: null } });
    const ready = await svc.download();
    expect(ready.phase).toBe("ready");
    expect(readFileSync(ready.installerPath!)).toEqual(INSTALLER);
    expect(calls).toContain("download FORGE_0.1.7_x64-setup.exe.sig");
    expect(calls).toContain("download FORGE_0.1.7_x64-setup.exe");
    // The signature file does not stay next to the installer.
    expect(existsSync(`${ready.installerPath}.sig`)).toBe(false);
    // Checking again keeps the downloaded installer of the same release.
    expect((await svc.check()).phase).toBe("ready");
  });

  it("drops an installer whose checksum does not match", async () => {
    const { svc } = service(() => [rel("v0.1.8", undefined, "sha256:" + "0".repeat(64))]);
    await svc.check();
    const r = await svc.download();
    expect(r).toMatchObject({ phase: "error", message: expect.stringMatching(/Prüfsumme/) });
    expect(r.installerPath).toBeNull();
  });

  it("drops a changed file even when GitHub reports no checksum", async () => {
    const { svc } = service(() => [rel("v0.1.8", undefined, null)], "0.1.0", { content: Buffer.from("MZ untergeschoben") });
    await svc.check();
    expect(await svc.download()).toMatchObject({ phase: "error", installerPath: null, message: expect.stringMatching(/Signatur/) });
  });

  it("takes the signatures from the one signature file of a release", async () => {
    const list = [relManifest("v0.1.102")];
    expect(signedOnly(list)[0]!.assets).toEqual([expect.objectContaining({ name: "FORGE_0.1.102_x64-setup.exe", sig: expect.objectContaining({ name: "FORGE_0.1.102.sig" }) })]);
    const { svc } = service(() => list);
    expect(await svc.check()).toMatchObject({ phase: "available", latest: { version: "0.1.102" } });
    expect(await svc.download()).toMatchObject({ phase: "ready" });
    // A file the signature file does not cover, or a changed one, is not installed.
    const noDigest = list.map((r) => ({ ...r, assets: r.assets!.map((x) => ({ ...x, digest: null })) }));
    const changed = service(() => noDigest, "0.1.0", { content: Buffer.from("MZ untergeschoben") }).svc;
    await changed.check();
    expect(await changed.download()).toMatchObject({ phase: "error", message: expect.stringMatching(/Signatur/) });
  });

  it("never offers unsigned assets", async () => {
    const list = [rel("v0.1.9", undefined, DIGEST, false), rel("v0.1.8")];
    expect(signedOnly(list)[0]!.assets).toEqual([]);
    expect(signedOnly(list)[1]!.assets).toEqual([expect.objectContaining({ name: "FORGE_0.1.8_x64-setup.exe", sig: expect.objectContaining({ name: "FORGE_0.1.8_x64-setup.exe.sig" }) })]);
    // The newest version has no signed file, so the update goes to it over the signed installer of 0.1.8.
    expect(await service(() => list).svc.check()).toMatchObject({ phase: "available", latest: { version: "0.1.9", via: "0.1.8" } });
    const unsigned = await service(() => [rel("v0.1.9", undefined, DIGEST, false)]).svc.check();
    expect(unsigned).toMatchObject({ phase: "uptodate", latest: null, message: expect.stringMatching(/0\.1\.9 ist erschienen/) });
  });

  it("says up to date for the same or an older release, and what went wrong", async () => {
    expect((await service(() => [rel("v0.1.0")]).svc.check()).phase).toBe("uptodate");
    expect((await service(() => [rel("v0.0.9")]).svc.check()).phase).toBe("uptodate");
    const failed = await service(() => new Error("Die Update-Suche ist fehlgeschlagen: GitHub antwortet mit HTTP 502.")).svc.check();
    expect(failed).toMatchObject({ phase: "error", message: expect.stringMatching(/HTTP 502/) });
    const none = await service(() => null).svc.check();
    expect(none).toMatchObject({ phase: "uptodate", message: "Noch kein Release veröffentlicht." });
  });

  it("reports a failed download", async () => {
    const { svc } = service(() => [rel("v0.1.7")], "0.1.0", { fail: "GitHub antwortet mit HTTP 502." });
    await svc.check();
    expect(await svc.download()).toMatchObject({ phase: "error", message: "Download fehlgeschlagen: GitHub antwortet mit HTTP 502." });
  });

  it("lets Claude write the changelog from notes and commits, and says why there is none", async () => {
    const prompts: string[] = [];
    let ready: "ok" | "no-login" = "no-login";
    const svc = new AppUpdateService({
      platform: "win32-x64",
      emit: () => {},
      enabled: () => true,
      log: () => {},
      currentVersion: "0.1.0",
      installable: true,
      chainFile: chainFile(),
      source: fakeSource(() => [rel("v0.2.0")], { commits: ["feat: Backups", "fix: Telefon"] }).source,
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
    const list = [
      { ...rel("v0.1.15", [`FORGE_0.1.15_update_${KEY}.zip`]), body: "- feat: Diktat live" },
      { ...rel("v0.1.14", [`FORGE_0.1.14_update_${KEY}.zip`]), body: "- feat: Session-Tabs" },
      { ...rel("v0.1.13", [`FORGE_0.1.13_update_${KEY}.zip`]), body: "- fix: Push auf geschützten Branches" },
      { ...rel("v0.1.12"), body: "- feat: schon installiert" },
    ];
    const fake = fakeSource(() => list, { commits: ["feat: Session-Tabs", "fix: Push", "feat: Diktat live"] });
    const svc = new AppUpdateService({
      platform: "win32-x64",
      emit: () => {},
      enabled: () => true,
      log: () => {},
      currentVersion: "0.1.12",
      installable: true,
      runtimeKey: () => KEY,
      chainFile: chainFile(),
      source: fake.source,
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
    expect(fake.calls).toContain("compare v0.1.12...v0.1.15");
    const prompt = prompts[0]!;
    expect(prompt).toContain("alle 3 Versionen nach 0.1.12 bis einschließlich 0.1.15");
    for (const line of ["Version 0.1.15:\n- feat: Diktat live", "Version 0.1.14:\n- feat: Session-Tabs", "Version 0.1.13:\n- fix: Push auf geschützten Branches", "- fix: Push"]) expect(prompt).toContain(line);
    expect(prompt).not.toContain("schon installiert");
    expect(prompt).not.toContain("ältere Änderungen fehlen");
  });

  it("caps the changelog input of a local build and says so", async () => {
    const prompts: string[] = [];
    const big = Array.from({ length: 80 }, (_, i) => `- feat: Änderung Nummer ${i} mit etwas mehr Text`).join("\n");
    const list = Array.from({ length: MAX_CHANGE_RELEASES + 15 }, (_, i) => ({ ...rel(`v0.1.${i + 1}`), body: big }));
    const commits = Array.from({ length: 400 }, (_, i) => `feat: Commit ${i}`);
    const fake = fakeSource(() => list, { commits });
    const svc = new AppUpdateService({
      platform: "win32-x64",
      emit: () => {},
      enabled: () => true,
      log: () => {},
      currentVersion: "0.1.0",
      installable: true,
      runtimeKey: () => null,
      chainFile: chainFile(),
      source: fake.source,
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
    expect(fake.calls).toContain("compare v0.1.15...v0.1.35");
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
    const list = [
      rel("v0.1.15", [`FORGE_0.1.15_update_${KEY}.zip`]),
      rel("v0.1.10", [`FORGE_0.1.10_update_${KEY}.zip`]),
      rel("v0.1.9", [`FORGE_0.1.9_update_${KEY}.zip`, `FORGE_0.1.9_${KEY}_x64-setup.exe`]),
      rel("v0.1.7"),
    ];
    const chain = chainFile();
    const before = service(() => list, "0.1.7", { runtimeKey: OLD, chainFile: chain });
    expect(await before.svc.check()).toMatchObject({ autoInstall: false, latest: { version: "0.1.15", tag: "v0.1.15", kind: "full", via: "0.1.9" } });
    expect((await before.svc.download()).phase).toBe("ready");
    expect(before.calls).toContain(`download FORGE_0.1.9_${KEY}_x64-setup.exe`);
    expect(existsSync(chain)).toBe(true);

    // After the full installer: 0.1.9 with the new runtime finds the small update and installs it without asking.
    const after = service(() => list, "0.1.9", { chainFile: chain });
    after.svc.start();
    after.svc.stop();
    // The sessions of the restart wait for the second step instead of being stopped by it again.
    expect(after.svc.holdsResume()).toBe(true);
    expect(await after.svc.check()).toMatchObject({ autoInstall: true, latest: { version: "0.1.15", kind: "patch", via: null } });
    expect(after.svc.holdsResume()).toBe(true);
    expect(existsSync(chain)).toBe(false);
    // Only once: the next check asks again.
    expect((await after.svc.check()).autoInstall).toBe(false);
    expect(after.svc.holdsResume()).toBe(false);
  });

  it("holds no sessions back without a two-step update", async () => {
    const { svc } = service(() => [rel("v0.1.7")]);
    svc.start();
    svc.stop();
    expect(svc.holdsResume()).toBe(false);
  });

  it("asks the main window to install an offered update (for the phone)", async () => {
    let asked = 0;
    const { svc } = service(() => [rel("v0.1.7")], "0.1.0", { requestInstall: () => asked++ });
    expect(() => svc.requestInstall()).toThrow(/kein Update bereit/);
    await svc.check();
    expect(svc.requestInstall().latest?.version).toBe("0.1.7");
    expect(asked).toBe(1);
  });

  it("downloads the small update and checks it like an installer", async () => {
    const { svc, calls } = service(() => [rel("v0.1.9", [`FORGE_0.1.9_update_${KEY}.zip`])], "0.1.8");
    expect((await svc.check()).latest).toMatchObject({ kind: "patch", version: "0.1.9" });
    const ready = await svc.download();
    expect(ready.installerPath).toMatch(/FORGE_0\.1\.9_update_node-24\.21\.0_git-2\.56\.0\.2_gh-2\.102\.0\.zip$/);
    expect(calls).toContain(`download FORGE_0.1.9_update_${KEY}.zip`);
  });

  it("does not download without a known release", async () => {
    const { svc, calls } = service(() => []);
    expect((await svc.download()).phase).toBe("error");
    expect(calls).toEqual([]);
  });

  it("reads the runtime key of the installation", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "forge-runtime-"));
    try {
      expect(installedRuntimeKey(dir, "win32-x64")).toBeNull();
      writeFileSync(path.join(dir, "VERSIONS.json"), JSON.stringify({ node: "24.21.0", git: "2.56.0.2", gh: "2.102.0" }));
      expect(installedRuntimeKey(dir, "win32-x64")).toBe(KEY);
      expect(installedRuntimeKey(dir, "darwin-arm64")).toBe("darwin-arm64_node-24.21.0_gh-2.102.0");
      // Not undefined: that falls back to FORGE_RUNTIME_DIR, which is set when the tests run inside FORGE.
      expect(installedRuntimeKey("")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("app updates on macOS and Linux", () => {
  const mac = (v: string) => `FORGE_${v}_darwin-arm64.app.tar.gz`;
  const linux = (v: string) => `FORGE_${v}_linux-x64.AppImage`;
  const asset = (name: string) => ({ name, size: INSTALLER.length, digest: DIGEST });
  /** A release whose signature files list `signed` (FORGE_<v>.sig) and `platformSigned` (FORGE_<v>_<tag>.sig). */
  function platformRel(tag: string, names: string[], sigs: Record<string, string[]>): Release {
    return { ...rel(tag, [], DIGEST, false), assets: [...names.map(asset), ...Object.keys(sigs).map((n) => ({ name: n, size: 300, digest: null }))] };
  }
  function platformSource(list: Release[], sigs: Record<string, string[]>) {
    const calls: string[] = [];
    const source: ReleaseSource = {
      releases: async () => list,
      commits: async () => [],
      download: async (a, file) => {
        calls.push(`download ${a.name}`);
        const listed = sigs[a.name!];
        writeFileSync(file, listed ? JSON.stringify(Object.fromEntries(listed.map((n) => [n, signatureOf(n)]))) : INSTALLER);
      },
    };
    return { source, calls };
  }
  function platformService(list: Release[], sigs: Record<string, string[]>, platform: "darwin-arm64" | "linux-x64", installKind: "app" | "appimage" | "system" | "dev", requestInstall?: () => void) {
    const { source, calls } = platformSource(list, sigs);
    const svc = new AppUpdateService({ emit: () => {}, enabled: () => true, log: () => {}, currentVersion: "0.1.0", chainFile: chainFile(), source, publicKey: PUBLIC_KEY, platform, installKind, requestInstall });
    return { svc, calls };
  }

  it("matches only the update asset of its own platform", () => {
    expect(platformAssetPattern("darwin-arm64")!.test(mac("0.2.0"))).toBe(true);
    expect(platformAssetPattern("darwin-x64")!.test(mac("0.2.0"))).toBe(false);
    expect(platformAssetPattern("darwin-arm64")!.test("FORGE_0.2.0_darwin-arm64.dmg")).toBe(false);
    expect(platformAssetPattern("darwin-arm64", true)!.test("FORGE_0.2.0_darwin-arm64.dmg")).toBe(true);
    expect(platformAssetPattern("linux-x64")!.test(linux("0.2.0"))).toBe(true);
    expect(platformAssetPattern("linux-x64")!.test("FORGE_0.2.0_linux-x64.deb")).toBe(false);
    expect(platformAssetPattern("linux-x64", true)!.test("FORGE_0.2.0_linux-x64.deb")).toBe(true);
    expect(platformAssetPattern("win32-x64")).toBeNull();
  });

  it("pairs an asset with the signature file of its platform first", () => {
    const r = platformRel("v0.2.0", [mac("0.2.0"), "FORGE_0.2.0_x64-setup.exe"], { "FORGE_0.2.0.sig": [], "FORGE_0.2.0_darwin-arm64.sig": [] });
    const [mine] = signedOnly([r], "darwin-arm64");
    expect(mine!.assets!.find((a) => a.name === mac("0.2.0"))?.sig?.name).toBe("FORGE_0.2.0_darwin-arm64.sig");
    // Windows keeps FORGE_<v>.sig, the platform files are no assets of their own.
    const [win] = signedOnly([r]);
    expect(win!.assets!.find((a) => a.name === "FORGE_0.2.0_x64-setup.exe")?.sig?.name).toBe("FORGE_0.2.0.sig");
    expect(win!.assets!.map((a) => a.name)).not.toContain("FORGE_0.2.0_darwin-arm64.sig");
  });

  it("skips newer releases without the platform asset and lists the releases with one, newest first", () => {
    const list = [
      platformRel("v0.4.0", ["FORGE_0.4.0_x64-setup.exe"], { "FORGE_0.4.0.sig": [] }),
      platformRel("v0.3.0", [mac("0.3.0")], { "FORGE_0.3.0.sig": [] }),
      platformRel("v0.2.0", [mac("0.2.0"), linux("0.2.0")], { "FORGE_0.2.0.sig": [] }),
    ];
    expect(platformCandidates(signedOnly(list, "darwin-arm64"), "0.1.0", "darwin-arm64").map((c) => c.release.tag_name)).toEqual(["v0.3.0", "v0.2.0"]);
    expect(platformCandidates(signedOnly(list, "linux-x64"), "0.1.0", "linux-x64").map((c) => c.asset.name)).toEqual([linux("0.2.0")]);
    expect(platformCandidates(signedOnly(list, "linux-x64"), "0.2.0", "linux-x64")).toEqual([]);
  });

  it("offers the newest release whose signature file signs the asset, downloads and checks it", async () => {
    const sigs = {
      // uploaded after FORGE_0.3.0.sig: no signature for it there, and no platform file
      "FORGE_0.3.0.sig": ["FORGE_0.3.0_x64-setup.exe"],
      "FORGE_0.2.0.sig": ["FORGE_0.2.0_x64-setup.exe"],
      "FORGE_0.2.0_darwin-arm64.sig": [mac("0.2.0")],
    };
    const list = [
      platformRel("v0.4.0", ["FORGE_0.4.0_x64-setup.exe"], {}),
      platformRel("v0.3.0", ["FORGE_0.3.0_x64-setup.exe", mac("0.3.0")], { "FORGE_0.3.0.sig": [] }),
      platformRel("v0.2.0", ["FORGE_0.2.0_x64-setup.exe", mac("0.2.0")], { "FORGE_0.2.0.sig": [], "FORGE_0.2.0_darwin-arm64.sig": [] }),
    ];
    let asked = 0;
    const { svc, calls } = platformService(list, sigs, "darwin-arm64", "app", () => asked++);
    const state = await svc.check();
    expect(state).toMatchObject({ phase: "available", installable: true, latest: { version: "0.2.0", kind: "full", via: null, since: "0.1.0" } });
    const ready = await svc.download();
    expect(ready.phase).toBe("ready");
    expect(ready.installerPath?.endsWith(mac("0.2.0"))).toBe(true);
    expect(existsSync(ready.installerPath!)).toBe(true);
    expect(calls).toContain(`download ${mac("0.2.0")}`);
    expect(calls).not.toContain(`download ${mac("0.3.0")}`);
    svc.requestInstall();
    expect(asked).toBe(1);
  });

  it("says up to date while no newer release brings the platform asset", async () => {
    const list = [platformRel("v0.3.0", ["FORGE_0.3.0_x64-setup.exe"], { "FORGE_0.3.0.sig": [] })];
    const { svc } = platformService(list, { "FORGE_0.3.0.sig": ["FORGE_0.3.0_x64-setup.exe"] }, "linux-x64", "appimage");
    expect(await svc.check()).toMatchObject({ phase: "uptodate", latest: null, message: null });
  });

  it("only tells a package installation (.deb) about a new version", async () => {
    const list = [platformRel("v0.2.0", ["FORGE_0.2.0_linux-x64.deb"], { "FORGE_0.2.0_linux-x64.sig": [] })];
    const { svc, calls } = platformService(list, {}, "linux-x64", "system", () => {});
    expect(await svc.check()).toMatchObject({ phase: "available", installable: false, latest: { version: "0.2.0" } });
    // nothing fetched to check: there is nothing to install
    expect(calls).toEqual([]);
    expect(() => svc.requestInstall()).toThrow();
  });

  it("installs by itself only as .app or AppImage on macOS and Linux, on Windows as before", () => {
    expect(canInstallUpdates("darwin-arm64", "app")).toBe(true);
    expect(canInstallUpdates("linux-x64", "appimage")).toBe(true);
    expect(canInstallUpdates("linux-x64", "system", "/opt/forge/runtime")).toBe(false);
    expect(canInstallUpdates("darwin-x64", "dev", "/x")).toBe(false);
    expect(canInstallUpdates("win32-x64", "nsis", "C:/forge/runtime")).toBe(true);
    expect(canInstallUpdates("win32-x64", null, "")).toBe(false);
  });
});

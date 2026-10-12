import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppUpdateState } from "@forge/protocol";
import { AppUpdateService, compareVersions, UPDATE_REPO } from "../src/update/app-update.js";

const INSTALLER = Buffer.from("MZ fake installer");
const DIGEST = `sha256:${createHash("sha256").update(INSTALLER).digest("hex")}`;

function release(tag: string, digest: string | null = DIGEST) {
  return JSON.stringify({ tag_name: tag, body: "- feat: Update-Funktion", published_at: "2026-10-12T10:00:00Z", assets: [{ name: `FORGE_${tag.slice(1)}_x64-setup.exe`, size: INSTALLER.length, digest }] });
}

function service(answer: (args: string[]) => { code: number; stdout?: string; stderr?: string }, version = "0.1.0") {
  const calls: string[][] = [];
  const states: AppUpdateState[] = [];
  const svc = new AppUpdateService({
    emit: (s) => states.push(s),
    enabled: () => true,
    log: () => {},
    currentVersion: version,
    installable: true,
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
    expect(calls[0]).toEqual(["api", `repos/${UPDATE_REPO}/releases/latest`]);
    expect(checked).toMatchObject({ phase: "available", latest: { version: "0.1.7", tag: "v0.1.7", notes: "- feat: Update-Funktion" } });
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

  it("does not download without a known release", async () => {
    const { svc, calls } = service(() => ({ code: 0 }));
    expect((await svc.download()).phase).toBe("error");
    expect(calls).toEqual([]);
  });
});

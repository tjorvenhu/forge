import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppInstallState } from "@forge/protocol";
import { pickInstaller, pickRelease, type Release } from "../src/update/app-update.js";
import { checkRuntime, findLocalInstaller, FullInstallService, parseRuntimeKey } from "../src/update/full-install.js";
import { signedMessage } from "../src/update/signature.js";

const KEY = "node-24.21.0_git-2.56.0.2_gh-2.102.0";
const OLD = "node-22.0.0_git-2.50.0_gh-2.90.0";
/** big enough to count as an installer, starts like a Windows program */
const INSTALLER = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(1_100_000, 1)]);
const DIGEST = `sha256:${createHash("sha256").update(INSTALLER).digest("hex")}`;

const dirs: string[] = [];
function tmp(prefix: string) {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const keys = generateKeyPairSync("ed25519");
const PUBLIC_KEY = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const SHA = createHash("sha256").update(INSTALLER).digest("hex");

/** A release with signed assets; the pickers see them the way signedOnly hands them over. */
function rel(tag: string, assets: string[], digest: string | null = DIGEST, signed = true): Release {
  return {
    tag_name: tag,
    body: "",
    published_at: "2026-10-12T10:00:00Z",
    assets: assets.flatMap((name) => [{ name, size: INSTALLER.length, digest }, ...(signed ? [{ name: `${name}.sig`, size: 88, digest: null }] : [])]),
  };
}

/** A runtime folder as the full installer leaves it; `skip` leaves tools out. */
function runtime(versions: Record<string, string> | null, skip: string[] = []) {
  const dir = tmp("forge-rt-");
  const files: Record<string, string> = { node: "node/node.exe", git: "git/cmd/git.exe", gh: "gh/bin/gh.exe", python: "python/python.exe" };
  for (const [tool, rel] of Object.entries(files)) {
    if (skip.includes(tool) || (tool === "python" && !versions?.python)) continue;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), "x");
  }
  if (versions) writeFileSync(path.join(dir, "VERSIONS.json"), JSON.stringify(versions));
  return dir;
}

describe("incomplete installations", () => {
  it("reads the tools of a runtime key", () => {
    expect(parseRuntimeKey(KEY)).toEqual([
      { tool: "node", version: "24.21.0" },
      { tool: "git", version: "2.56.0.2" },
      { tool: "gh", version: "2.102.0" },
    ]);
    expect(parseRuntimeKey(`${KEY}_python-3.13.1`)?.at(-1)).toEqual({ tool: "python", version: "3.13.1" });
    expect(parseRuntimeKey("irgendwas")).toBeNull();
  });

  it("finds what an unpacked update zip or an older runtime lacks", () => {
    const full = { node: "24.21.0", git: "2.56.0.2", gh: "2.102.0" };
    expect(checkRuntime(runtime(full), KEY)).toEqual([]);
    // The update zip brings only the exe and the sidecar.
    expect(checkRuntime(runtime(null, ["node", "git", "gh"]), KEY).map((p) => p.label)).toEqual(["Node.js fehlt", "Git fehlt", "GitHub CLI fehlt", "Versionsliste der mitgelieferten Programme fehlt"]);
    expect(checkRuntime(null, KEY)).toMatchObject([{ part: "runtime", kind: "missing" }]);
    expect(checkRuntime(runtime({ ...full, git: "2.50.0" }), KEY)).toEqual([{ part: "git", kind: "outdated", label: "Git 2.50.0 statt 2.56.0.2" }]);
    // A tool added to the runtime later (python) counts as soon as the key names it.
    expect(checkRuntime(runtime(full), `${KEY}_python-3.13.1`)).toEqual([{ part: "python", kind: "missing", label: "Python fehlt" }]);
    expect(checkRuntime(runtime({ ...full, python: "3.13.1" }), `${KEY}_python-3.13.1`)).toEqual([]);
    // Without a key in the build only the programs count.
    expect(checkRuntime(runtime({ node: "1", git: "1", gh: "1" }), null)).toEqual([]);
    expect(checkRuntime(runtime(full, ["gh"]), null).map((p) => p.part)).toEqual(["gh"]);
  });

  it("picks the newest installer for the runtime, also an older release, and the small update after it", () => {
    const list = [
      rel("v0.1.60", [`FORGE_0.1.60_update_${KEY}.zip`]),
      rel("v0.1.58", [`FORGE_0.1.58_update_${KEY}.zip`]),
      rel("v0.1.56", [`FORGE_0.1.56_update_${KEY}.zip`, `FORGE_0.1.56_${KEY}_x64-setup.exe`]),
      rel("v0.1.9", [`FORGE_0.1.9_update_${OLD}.zip`, `FORGE_0.1.9_${OLD}_x64-setup.exe`]),
      { ...rel("v0.1.61", [`FORGE_0.1.61_${KEY}_x64-setup.exe`]), prerelease: true },
    ];
    expect(pickInstaller(list, KEY)).toMatchObject({ release: { tag_name: "v0.1.56" }, asset: { name: `FORGE_0.1.56_${KEY}_x64-setup.exe` }, then: { tag_name: "v0.1.60" } });
    expect(pickInstaller(list, OLD)).toMatchObject({ release: { tag_name: "v0.1.9" }, then: null });
    expect(pickInstaller(list, "node-1_git-1_gh-1")).toBeNull();
    expect(pickInstaller(list, null)).toMatchObject({ release: { tag_name: "v0.1.56" } });
  });

  it("offers an update that needs another runtime over the matching installer, even an older one", () => {
    const list = [
      rel("v0.1.60", [`FORGE_0.1.60_update_${KEY}.zip`]),
      rel("v0.1.58", [`FORGE_0.1.58_update_${OLD}.zip`, `FORGE_0.1.58_${OLD}_x64-setup.exe`]),
      rel("v0.1.56", [`FORGE_0.1.56_update_${KEY}.zip`, `FORGE_0.1.56_${KEY}_x64-setup.exe`]),
    ];
    // Installed: 0.1.58 with the old runtime. The installer of 0.1.56 brings the runtime 0.1.60 needs.
    expect(pickRelease(list, "0.1.58", OLD)).toMatchObject({ kind: "full", newest: { tag_name: "v0.1.60" }, release: { tag_name: "v0.1.56" } });
  });

  it("finds a downloaded setup.exe for the runtime in the Downloads folder", async () => {
    const dl = tmp("forge-dl-");
    writeFileSync(path.join(dl, `FORGE_0.1.9_${OLD}_x64-setup.exe`), INSTALLER);
    writeFileSync(path.join(dl, `FORGE_0.1.56_${KEY}_x64-setup.exe`), INSTALLER);
    writeFileSync(path.join(dl, `FORGE_0.1.57_${KEY}_x64-setup.exe`), "abgebrochen");
    writeFileSync(path.join(dl, `FORGE_0.1.60_update_${KEY}.zip`), INSTALLER);
    expect(await findLocalInstaller([dl, path.join(dl, "fehlt")], KEY)).toMatchObject({ name: `FORGE_0.1.56_${KEY}_x64-setup.exe`, version: "0.1.56" });
    expect(await findLocalInstaller([dl], "node-1_git-1_gh-1")).toBeNull();
  });
});

describe("FullInstallService", () => {
  function service(opts: { runtimeDir: string | null; releases?: Release[]; canDownload?: boolean; localDirs?: string[]; failDownload?: boolean; requestInstall?: () => void }) {
    const states: AppInstallState[] = [];
    const calls: string[] = [];
    const downloadDir = tmp("forge-full-");
    const chainFile = path.join(tmp("forge-chain-"), "chain.json");
    const svc = new FullInstallService({
      emit: (s) => states.push(s),
      log: () => {},
      checkable: true,
      expectedRuntime: KEY,
      runtimeDir: () => opts.runtimeDir,
      canDownload: () => opts.canDownload ?? true,
      localDirs: () => opts.localDirs ?? [],
      downloadDir,
      chainFile,
      requestInstall: opts.requestInstall,
      publicKey: PUBLIC_KEY,
      source: {
        releases: async () => {
          calls.push("releases");
          return opts.releases ?? [];
        },
        commits: async () => [],
        download: async (asset, file) => {
          calls.push(`download ${asset.name}`);
          if (opts.failDownload) throw new Error("GitHub antwortet mit HTTP 502.");
          const name = asset.name!;
          writeFileSync(file, name.endsWith(".sig") ? sign(null, signedMessage(name.slice(0, -4), SHA), keys.privateKey).toString("base64") : INSTALLER);
        },
      },
    });
    return { svc, states, calls, chainFile };
  }

  const releases = [rel("v0.1.60", [`FORGE_0.1.60_update_${KEY}.zip`]), rel("v0.1.56", [`FORGE_0.1.56_update_${KEY}.zip`, `FORGE_0.1.56_${KEY}_x64-setup.exe`])];

  it("says nothing for a complete installation and nothing in a development build", async () => {
    const { svc, calls } = service({ runtimeDir: runtime({ node: "24.21.0", git: "2.56.0.2", gh: "2.102.0" }) });
    expect(await svc.check()).toMatchObject({ complete: true, problems: [], phase: "idle" });
    expect(calls).toEqual([]);
    const dev = new FullInstallService({ emit: () => {}, log: () => {}, checkable: false, expectedRuntime: null });
    expect(await dev.check()).toMatchObject({ checkable: false, complete: null });
    expect(() => dev.requestInstall()).toThrow(/Entwicklungsmodus/);
  });

  it("finds the installer, downloads it with progress, checks it and lets the small update follow", async () => {
    const { svc, calls, states, chainFile } = service({ runtimeDir: runtime(null, ["git", "gh"]), releases });
    const found = await svc.check();
    expect(found).toMatchObject({ complete: false, phase: "found", canDownload: true, installer: { version: "0.1.56", source: "github", then: "0.1.60", size: INSTALLER.length } });
    expect(found.problems.map((p) => p.part)).toEqual(["git", "gh", "versions"]);
    expect(states.some((s) => s.phase === "searching")).toBe(true);
    const ready = await svc.download();
    expect(ready).toMatchObject({ phase: "ready", received: INSTALLER.length });
    expect(readFileSync(ready.installerPath!)).toEqual(INSTALLER);
    expect(calls.slice(1)).toEqual([`download FORGE_0.1.56_${KEY}_x64-setup.exe.sig`, `download FORGE_0.1.56_${KEY}_x64-setup.exe`]);
    // After the restart the update service installs 0.1.60 by itself (two-step update).
    expect(JSON.parse(readFileSync(chainFile, "utf8"))).toEqual({ target: "v0.1.60" });
    // A second download keeps the checked file.
    expect((await svc.download()).installerPath).toBe(ready.installerPath);
  });

  it("drops a download whose checksum or size does not match", async () => {
    const bad = [rel("v0.1.56", [`FORGE_0.1.56_${KEY}_x64-setup.exe`], `sha256:${"0".repeat(64)}`)];
    const { svc, chainFile } = service({ runtimeDir: runtime(null, ["gh"]), releases: bad });
    await svc.check();
    expect(await svc.download()).toMatchObject({ phase: "error", installerPath: null, message: expect.stringMatching(/Prüfsumme/) });
    expect(existsSync(chainFile)).toBe(false);
    const failing = service({ runtimeDir: runtime(null, ["gh"]), releases, failDownload: true });
    await failing.svc.check();
    expect(await failing.svc.download()).toMatchObject({ phase: "error", message: "Download fehlgeschlagen: GitHub antwortet mit HTTP 502." });
  });

  it("ignores unsigned installers (releases from before the signing)", async () => {
    const { svc } = service({ runtimeDir: runtime(null, ["gh"]), releases: [rel("v0.1.56", [`FORGE_0.1.56_${KEY}_x64-setup.exe`], DIGEST, false)] });
    expect(await svc.check()).toMatchObject({ phase: "none", installer: null });
  });

  it("says clearly when there is no installer for the runtime and how to get one", async () => {
    const { svc } = service({ runtimeDir: runtime(null, ["gh"]), releases: [rel("v0.1.60", [`FORGE_0.1.60_update_${KEY}.zip`])] });
    const none = await svc.check();
    expect(none).toMatchObject({ phase: "none", installer: null, message: expect.stringMatching(/noch keinen Installer für diese Laufzeit.*Run workflow mit full/) });
    expect(() => svc.requestInstall()).toThrow(/noch keinen Installer/);
  });

  it("takes a setup.exe from the Downloads folder when it cannot download, and one the user picks", async () => {
    const dl = tmp("forge-dl-");
    const local = path.join(dl, `FORGE_0.1.56_${KEY}_x64-setup.exe`);
    writeFileSync(local, INSTALLER);
    const { svc, calls } = service({ runtimeDir: runtime(null, ["git", "gh"]), canDownload: false, localDirs: [dl] });
    expect(await svc.check()).toMatchObject({ phase: "found", canDownload: false, installer: { source: "local", version: "0.1.56", tag: null } });
    const ready = await svc.download();
    expect(ready.phase).toBe("ready");
    expect(ready.installerPath).not.toBe(local);
    expect(readFileSync(ready.installerPath!)).toEqual(INSTALLER);
    expect(calls).toEqual([]);

    const empty = service({ runtimeDir: runtime(null, ["gh"]), canDownload: false });
    expect(await empty.svc.check()).toMatchObject({ phase: "none", message: expect.stringMatching(/nicht selbst laden.*Release-Seite/) });
    await expect(empty.svc.useLocal(path.join(dl, "FORGE_0.1.9_update_x.zip"))).rejects.toThrow(/kein FORGE-Installer/);
    const other = path.join(dl, `FORGE_0.1.9_${OLD}_x64-setup.exe`);
    writeFileSync(other, INSTALLER);
    await expect(empty.svc.useLocal(other)).rejects.toThrow(`Diese FORGE-Version braucht ${KEY}`);
    expect(await empty.svc.useLocal(local)).toMatchObject({ phase: "ready", installer: { source: "local", version: "0.1.56" } });
  });

  it("asks the main window to install (for the phone) only when there is something to install", async () => {
    let asked = 0;
    const { svc } = service({ runtimeDir: runtime(null, ["gh"]), releases, requestInstall: () => asked++ });
    await svc.check();
    expect(svc.requestInstall().installer?.version).toBe("0.1.56");
    expect(asked).toBe(1);
    const complete = service({ runtimeDir: runtime({ node: "24.21.0", git: "2.56.0.2", gh: "2.102.0" }), requestInstall: () => asked++ });
    await complete.svc.check();
    expect(() => complete.svc.requestInstall()).toThrow(/vollständig installiert/);
  });
});

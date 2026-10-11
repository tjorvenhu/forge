#!/usr/bin/env node
// Downloads and verifies the tools FORGE ships with (Node.js, Git, GitHub CLI) and copies the
// built sidecar next to them. Output: apps/desktop/src-tauri/runtime/ (bundled as Tauri resources).
// Every download is pinned and checked against the SHA-256 published by the upstream project.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "apps/desktop/src-tauri/runtime");
const CACHE = path.join(ROOT, ".runtime-cache");

const WINDOWS = {
  node: {
    version: "24.21.0",
    url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip",
    sha256: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
  },
  git: {
    version: "2.56.0.2",
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe",
    sha256: "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
  },
  gh: {
    version: "2.102.0",
    url: "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_windows_amd64.zip",
    sha256: "ae64e556ecc240b200f7eba60d550e4bb60d78e860e69dd88c449405b86067f4",
  },
};

function log(msg) {
  process.stdout.write(`[prepare-runtime] ${msg}\n`);
}

async function download(spec) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, path.basename(new URL(spec.url).pathname));
  if (existsSync(file) && sha256(file) === spec.sha256) return file;
  log(`lade ${spec.url}`);
  const res = await fetch(spec.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status}): ${spec.url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const got = sha256(file);
  if (got !== spec.sha256) {
    rmSync(file, { force: true });
    throw new Error(`Prüfsumme stimmt nicht für ${file}\n erwartet ${spec.sha256}\n erhalten ${got}`);
  }
  return file;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} fehlgeschlagen (Code ${r.status})`);
}

function unzip(zip, dest) {
  mkdirSync(dest, { recursive: true });
  // Windows bsdtar reads zip archives; call it by full path so GNU tar from Git on PATH is not used.
  const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  run(tar, ["-xf", zip, "-C", dest]);
}

/**
 * Removes parts FORGE never uses: docs, man pages, translations and vim (commit messages are
 * always passed with -F, so no editor opens). git, bash, ssh and the credential manager stay.
 */
function pruneGit(dir) {
  const drop = [
    "usr/share/vim",
    "usr/share/doc",
    "usr/share/man",
    "usr/share/info",
    "usr/share/locale",
    "ucrt64/share/doc",
    "ucrt64/share/man",
    "ucrt64/share/info",
    "ucrt64/share/locale",
    "ucrt64/share/git-doc",
  ];
  for (const rel of drop) rmSync(path.join(dir, rel), { recursive: true, force: true });
}

async function prepareWindows(state) {
  const tmp = path.join(CACHE, "extract");
  rmSync(tmp, { recursive: true, force: true });

  if (state.node !== WINDOWS.node.version) {
    const zip = await download(WINDOWS.node);
    unzip(zip, tmp);
    const dir = path.join(tmp, `node-v${WINDOWS.node.version}-win-x64`);
    rmSync(path.join(OUT, "node"), { recursive: true, force: true });
    mkdirSync(path.join(OUT, "node"), { recursive: true });
    copyFileSync(path.join(dir, "node.exe"), path.join(OUT, "node", "node.exe"));
    copyFileSync(path.join(dir, "LICENSE"), path.join(OUT, "node", "LICENSE"));
    state.node = WINDOWS.node.version;
  }

  if (state.git !== WINDOWS.git.version) {
    const sfx = await download(WINDOWS.git);
    rmSync(path.join(OUT, "git"), { recursive: true, force: true });
    // PortableGit is a verified 7-Zip self-extractor; -o sets the target, -y answers prompts.
    run(sfx, [`-o${path.join(OUT, "git")}`, "-y"]);
    pruneGit(path.join(OUT, "git"));
    state.git = WINDOWS.git.version;
  }

  if (state.gh !== WINDOWS.gh.version) {
    const zip = await download(WINDOWS.gh);
    const dest = path.join(tmp, "gh");
    unzip(zip, dest);
    rmSync(path.join(OUT, "gh"), { recursive: true, force: true });
    mkdirSync(path.join(OUT, "gh", "bin"), { recursive: true });
    copyFileSync(path.join(dest, "bin", "gh.exe"), path.join(OUT, "gh", "bin", "gh.exe"));
    copyFileSync(path.join(dest, "LICENSE"), path.join(OUT, "gh", "LICENSE"));
    state.gh = WINDOWS.gh.version;
  }
  rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  if (process.platform !== "win32") throw new Error("FORGE wird nur unter Windows gebaut.");
  mkdirSync(OUT, { recursive: true });
  const stateFile = path.join(OUT, "VERSIONS.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};

  await prepareWindows(state);

  const sidecar = path.join(ROOT, "packages/sidecar/dist/sidecar.mjs");
  if (!existsSync(sidecar)) throw new Error("Sidecar nicht gebaut: zuerst `pnpm build:sidecar` ausführen.");
  mkdirSync(path.join(OUT, "sidecar"), { recursive: true });
  cpSync(sidecar, path.join(OUT, "sidecar", "sidecar.mjs"));

  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  log(`fertig: ${JSON.stringify(state)}`);
}

if (process.argv.includes("--prune-only")) {
  pruneGit(path.join(OUT, "git"));
  process.exit(0);
}

main().catch((e) => {
  console.error(`[prepare-runtime] ${e.message}`);
  process.exit(1);
});

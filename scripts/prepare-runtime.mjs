#!/usr/bin/env node
// Downloads and verifies the tools FORGE ships with (Node.js, Git, GitHub CLI, Python) and copies the
// built sidecar next to them. Output: apps/desktop/src-tauri/runtime/ (bundled as Tauri resources).
// Every download is pinned and checked against the hash published by the upstream project.
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
  // The official NuGet package of the PSF: a complete CPython with pip, venv and ensurepip, but without
  // tests, tkinter and IDLE (the embeddable zip has no pip and cannot create venvs). 3.14 instead of the
  // fresh 3.15 so packages with C extensions find wheels. nuget.org publishes SHA-512 (base64) in the
  // catalog entry of the package (`packageHash`).
  python: {
    version: "3.14.8",
    url: "https://api.nuget.org/v3-flatcontainer/python/3.14.8/python.3.14.8.nupkg",
    sha512: "b9oz/C2qiLlE7FKAogz3dyiT38vFX3d9K2IqhooLZmcL3E9REJsgrg3eUXeTHLXRy50jgfHEoX1bx3u91Vjeaw==",
  },
};

function log(msg) {
  process.stdout.write(`[prepare-runtime] ${msg}\n`);
}

async function download(spec) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, path.basename(new URL(spec.url).pathname));
  const [algo, expected, encoding] = spec.sha512 ? ["sha512", spec.sha512, "base64"] : ["sha256", spec.sha256, "hex"];
  if (existsSync(file) && digest(file, algo, encoding) === expected) return file;
  log(`lade ${spec.url}`);
  const res = await fetch(spec.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status}): ${spec.url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const got = digest(file, algo, encoding);
  if (got !== expected) {
    rmSync(file, { force: true });
    throw new Error(`Prüfsumme stimmt nicht für ${file}\n erwartet ${expected}\n erhalten ${got}`);
  }
  return file;
}

function digest(file, algo, encoding) {
  return createHash(algo).update(readFileSync(file)).digest(encoding);
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

/**
 * Makes the NuGet Python usable from a shell: `python3` next to `python`, `pip`/`pip3` for cmd,
 * PowerShell and Git Bash (pip's own exe launchers carry an absolute path and break when the folder
 * moves). pip.ini sits in sys.prefix, so it applies to this interpreter only, not to venvs made from
 * it: plain `pip install` goes to the user site (%APPDATA%\Python\Python3xx), not into the FORGE
 * installation, which the next full installer replaces.
 */
function preparePython(dir) {
  copyFileSync(path.join(dir, "python.exe"), path.join(dir, "python3.exe"));
  // [install], not [global]: `pip list` and `pip freeze` with user=true would only show the user site.
  writeFileSync(path.join(dir, "pip.ini"), "[global]\r\ndisable-pip-version-check = true\r\n\r\n[install]\r\nuser = true\r\n");
  for (const name of ["pip", "pip3"]) {
    writeFileSync(path.join(dir, `${name}.cmd`), '@"%~dp0python.exe" -m pip %*\r\n');
    writeFileSync(path.join(dir, name), '#!/bin/sh\nexec "$(dirname "$0")/python.exe" -m pip "$@"\n');
  }
  const r = spawnSync(path.join(dir, "python3.exe"), ["-I", "-B", "-m", "pip", "--version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Python aus dem Paket startet nicht: ${r.stderr || r.error?.message}`);
  log(r.stdout.trim());
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

  if (state.python !== WINDOWS.python.version) {
    const pkg = await download(WINDOWS.python);
    const dest = path.join(tmp, "python");
    // A .nupkg is a zip; the interpreter is in tools/, the rest is NuGet metadata.
    unzip(pkg, dest);
    rmSync(path.join(OUT, "python"), { recursive: true, force: true });
    cpSync(path.join(dest, "tools"), path.join(OUT, "python"), { recursive: true });
    preparePython(path.join(OUT, "python"));
    state.python = WINDOWS.python.version;
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

const VERSIONS = Object.fromEntries(Object.entries(WINDOWS).map(([name, spec]) => [name, spec.version]));

/**
 * Key of the bundled runtime versions, e.g. node-24.21.0_git-2.56.0.2_gh-2.102.0_python-3.14.8. Small
 * updates (exe and sidecar only) carry it in their name; an installation with another runtime needs
 * the full installer. installedRuntimeKey in packages/sidecar/src/update/app-update.ts builds the same
 * key from VERSIONS.json.
 */
export function runtimeKey(versions = VERSIONS) {
  return `node-${versions.node}_git-${versions.git}_gh-${versions.gh}_python-${versions.python}`;
}

if (process.argv.includes("--key")) {
  process.stdout.write(runtimeKey() + "\n");
  process.exit(0);
}

// VERSIONS.json as a full build writes it (tests compare the key against the sidecar's).
if (process.argv.includes("--versions")) {
  process.stdout.write(JSON.stringify(VERSIONS) + "\n");
  process.exit(0);
}

if (process.argv.includes("--prune-only")) {
  pruneGit(path.join(OUT, "git"));
  process.exit(0);
}

main().catch((e) => {
  console.error(`[prepare-runtime] ${e.message}`);
  process.exit(1);
});

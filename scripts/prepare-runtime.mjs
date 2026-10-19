#!/usr/bin/env node
// Downloads and verifies the tools FORGE ships with and copies the built sidecar next to them. Output:
// apps/desktop/src-tauri/runtime/ (bundled as Tauri resources). Every download is pinned and checked
// against the hash published by the upstream project.
//
// Windows (win32-x64): Node.js (node.exe only), Git for Windows, GitHub CLI, Python.
// macOS (darwin-arm64, darwin-x64) and Linux (linux-x64): the complete Node.js dist folder and the GitHub
// CLI. git and python come from the system there (ADR 0014).
//
//   node scripts/prepare-runtime.mjs                       prepare for this machine
//   node scripts/prepare-runtime.mjs --target darwin-x64   another architecture of the same OS (x64 build on an arm64 Mac)
//   node scripts/prepare-runtime.mjs --key                 runtime key of the target, e.g. for update names
//   node scripts/prepare-runtime.mjs --versions            VERSIONS.json as a full build writes it
//   node scripts/prepare-runtime.mjs --check-hashes        download and verify every pinned archive of all targets
//   --out <dir>                                            other output folder (tests)
// The target can also come from FORGE_RUNTIME_TARGET.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.resolve(argValue("--out") ?? path.join(ROOT, "apps/desktop/src-tauri/runtime"));
const CACHE = path.join(ROOT, ".runtime-cache");

const TARGETS = ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"];

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

// Same versions as on Windows. Hashes: nodejs.org/dist/v<v>/SHASUMS256.txt and gh_<v>_checksums.txt of the
// gh release. `dir` is the single top-level folder of the archive. gh ships zip archives for macOS.
const UNIX = {
  "darwin-arm64": {
    node: {
      version: "24.21.0",
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
      sha256: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
      dir: "node-v24.21.0-darwin-arm64",
    },
    gh: {
      version: "2.102.0",
      url: "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_arm64.zip",
      sha256: "da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e",
      dir: "gh_2.102.0_macOS_arm64",
    },
  },
  "darwin-x64": {
    node: {
      version: "24.21.0",
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz",
      sha256: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
      dir: "node-v24.21.0-darwin-x64",
    },
    gh: {
      version: "2.102.0",
      url: "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_macOS_amd64.zip",
      sha256: "b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3",
      dir: "gh_2.102.0_macOS_amd64",
    },
  },
  "linux-x64": {
    node: {
      version: "24.21.0",
      url: "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz",
      sha256: "6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff",
      dir: "node-v24.21.0-linux-x64",
    },
    gh: {
      version: "2.102.0",
      url: "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_amd64.tar.gz",
      sha256: "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386",
      dir: "gh_2.102.0_linux_amd64",
    },
  },
};

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i >= 0) return process.argv[i + 1];
  return process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** Platform tag the runtime is prepared for: --target, FORGE_RUNTIME_TARGET or this machine. */
function selectTarget() {
  const wanted = argValue("--target") ?? process.env.FORGE_RUNTIME_TARGET;
  // Windows has always meant x64, whatever the machine.
  const target = wanted || (process.platform === "win32" ? "win32-x64" : `${process.platform}-${process.arch}`);
  if (!TARGETS.includes(target)) throw new Error(`FORGE wird für ${target} nicht gebaut (möglich: ${TARGETS.join(", ")}).`);
  return target;
}

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

/** Extracts a tar.gz or zip. macOS bsdtar reads both; GNU tar on Linux does not read zip. */
function extract(archive, dest) {
  mkdirSync(dest, { recursive: true });
  if (process.platform === "win32") {
    // Test runs only (--out): Windows cannot create the symlinks in node's bin/, replaceNodeLinks writes them anyway.
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    run(tar, ["-xf", archive, "-C", dest, ...["npm", "npx", "corepack"].flatMap((n) => ["--exclude", `*/bin/${n}`])]);
  } else if (process.platform === "linux" && archive.endsWith(".zip")) run("unzip", ["-q", archive, "-d", dest]);
  else run("tar", ["-xf", archive, "-C", dest]);
}

/**
 * Platform tag of an executable from its header (Mach-O or ELF), or null. VERSIONS.json only holds
 * versions, so this tells whether a runtime folder from an arm64 build can serve an x64 build.
 */
function binaryTarget(file) {
  if (!existsSync(file)) return null;
  const head = Buffer.alloc(20);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (head.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = head.readUInt32LE(4);
    return cpu === 0x0100000c ? "darwin-arm64" : cpu === 0x01000007 ? "darwin-x64" : null;
  }
  if (head.readUInt32BE(0) === 0x7f454c46) return head.readUInt16LE(18) === 0x3e ? "linux-x64" : null;
  return null;
}

/**
 * Tauri copies resources file by file and resolves symlinks, so npm, npx and corepack (relative links
 * in bin/) would end up as copies of their scripts with broken relative requires. Small shell scripts
 * work from any location and in every bundle format.
 */
function replaceNodeLinks(dir) {
  const scripts = {
    npm: "lib/node_modules/npm/bin/npm-cli.js",
    npx: "lib/node_modules/npm/bin/npx-cli.js",
    corepack: "lib/node_modules/corepack/dist/corepack.js",
  };
  for (const [name, script] of Object.entries(scripts)) {
    const file = path.join(dir, "bin", name);
    rmSync(file, { force: true });
    writeFileSync(file, `#!/bin/sh\ndir=$(dirname "$0")\nexec "$dir/node" "$dir/../${script}" "$@"\n`);
    chmodSync(file, 0o755);
  }
}

function assertNoSymlinks(dir) {
  const links = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isSymbolicLink());
  if (links.length) {
    const names = links.map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
    throw new Error(`Symbolische Links im Laufzeit-Ordner (Tauri bündelt sie nicht als Links): ${names.join(", ")}`);
  }
}

/** Moves a prepared folder into the runtime folder (same file system as the cache in the repo). */
function place(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  try {
    renameSync(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    cpSync(src, dest, { recursive: true });
  }
}

/** `<tool> --version` when the target runs on this machine; a cross build cannot start it. */
function smokeTest(file, target) {
  if (target !== `${process.platform}-${process.arch}`) return;
  const r = spawnSync(file, ["--version"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${file} startet nicht: ${r.stderr || r.error?.message}`);
  log(r.stdout.trim().split("\n")[0]);
}

async function prepareUnix(state, target) {
  const spec = UNIX[target];
  const tmp = path.join(CACHE, "extract");
  rmSync(tmp, { recursive: true, force: true });

  // git and python come from the system here; drop what an earlier Windows build may have left.
  for (const name of ["git", "python"]) {
    rmSync(path.join(OUT, name), { recursive: true, force: true });
    delete state[name];
  }

  const nodeBin = path.join(OUT, "node", "bin", "node");
  if (state.node !== spec.node.version || binaryTarget(nodeBin) !== target) {
    const archive = await download(spec.node);
    const dest = path.join(tmp, "node");
    extract(archive, dest);
    const dir = path.join(dest, spec.node.dir);
    replaceNodeLinks(dir);
    chmodSync(path.join(dir, "bin", "node"), 0o755);
    assertNoSymlinks(dir);
    place(dir, path.join(OUT, "node"));
    if (binaryTarget(nodeBin) !== target) throw new Error(`${nodeBin} ist nicht für ${target} gebaut.`);
    state.node = spec.node.version;
  }
  smokeTest(nodeBin, target);

  const ghBin = path.join(OUT, "gh", "bin", "gh");
  if (state.gh !== spec.gh.version || binaryTarget(ghBin) !== target) {
    const archive = await download(spec.gh);
    const dest = path.join(tmp, "gh");
    extract(archive, dest);
    const dir = path.join(dest, spec.gh.dir);
    // man pages: gh is only called by FORGE and by Claude, never through man.
    rmSync(path.join(dir, "share"), { recursive: true, force: true });
    chmodSync(path.join(dir, "bin", "gh"), 0o755);
    assertNoSymlinks(dir);
    place(dir, path.join(OUT, "gh"));
    if (binaryTarget(ghBin) !== target) throw new Error(`${ghBin} ist nicht für ${target} gebaut.`);
    state.gh = spec.gh.version;
  }
  smokeTest(ghBin, target);
  rmSync(tmp, { recursive: true, force: true });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const stateFile = path.join(OUT, "VERSIONS.json");
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};

  if (TARGET === "win32-x64") {
    if (process.platform !== "win32") throw new Error("Die Windows-Laufzeit lässt sich nur unter Windows vorbereiten.");
    await prepareWindows(state);
  } else {
    // Unpacking on Windows loses the executable bits; allowed only into a test folder.
    if (process.platform === "win32" && !argValue("--out")) {
      throw new Error(`Die Laufzeit für ${TARGET} lässt sich nur unter macOS oder Linux vorbereiten.`);
    }
    if (process.platform !== "win32" && !TARGET.startsWith(`${process.platform}-`)) {
      throw new Error(`Die Laufzeit für ${TARGET} lässt sich nur auf demselben Betriebssystem vorbereiten.`);
    }
    await prepareUnix(state, TARGET);
  }

  const sidecar = path.join(ROOT, "packages/sidecar/dist/sidecar.mjs");
  if (!existsSync(sidecar)) throw new Error("Sidecar nicht gebaut: zuerst `pnpm build:sidecar` ausführen.");
  mkdirSync(path.join(OUT, "sidecar"), { recursive: true });
  cpSync(sidecar, path.join(OUT, "sidecar", "sidecar.mjs"));

  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
  log(`fertig: ${JSON.stringify(state)}`);
}

/** Tool versions of a target, as VERSIONS.json lists them after a full build. */
function versionsOf(target) {
  const specs = target === "win32-x64" ? WINDOWS : UNIX[target];
  return Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, spec.version]));
}

/**
 * Key of the bundled runtime versions. Windows: node-24.21.0_git-2.56.0.2_gh-2.102.0_python-3.14.8 (no
 * platform tag, as before macOS and Linux). Others: <tag>_node-<v>_gh-<v>, e.g.
 * darwin-arm64_node-24.21.0_gh-2.102.0. Small updates (exe and sidecar only) carry it in their name; an
 * installation with another runtime needs the full installer. installedRuntimeKey in
 * packages/sidecar/src/update/app-update.ts builds the same key from VERSIONS.json.
 */
export function runtimeKey(target = TARGET, versions = versionsOf(target)) {
  if (target === "win32-x64") return `node-${versions.node}_git-${versions.git}_gh-${versions.gh}_python-${versions.python}`;
  return `${target}_node-${versions.node}_gh-${versions.gh}`;
}

/** Downloads and verifies every pinned archive of every target (works on any OS, nothing is unpacked). */
async function checkHashes() {
  const specs = [...Object.values(WINDOWS), ...Object.values(UNIX).flatMap((t) => Object.values(t))];
  for (const spec of specs) {
    await download(spec);
    log(`ok ${path.basename(new URL(spec.url).pathname)}`);
  }
}

let TARGET;
try {
  TARGET = selectTarget();
} catch (e) {
  console.error(`[prepare-runtime] ${e.message}`);
  process.exit(1);
}

if (process.argv.includes("--key")) {
  process.stdout.write(runtimeKey() + "\n");
  process.exit(0);
}

// VERSIONS.json as a full build writes it (tests compare the key against the sidecar's).
if (process.argv.includes("--versions")) {
  process.stdout.write(JSON.stringify(versionsOf(TARGET)) + "\n");
  process.exit(0);
}

if (process.argv.includes("--prune-only")) {
  pruneGit(path.join(OUT, "git"));
  process.exit(0);
}

(process.argv.includes("--check-hashes") ? checkHashes() : main()).catch((e) => {
  console.error(`[prepare-runtime] ${e.message}`);
  process.exit(1);
});

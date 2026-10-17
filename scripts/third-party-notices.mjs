#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: every npm package that ships inside FORGE, with license, copyright
// lines and the license text from the package. Run after changing dependencies and commit the result.
//
//   node scripts/third-party-notices.mjs           write the file
//   node scripts/third-party-notices.mjs --check   fail if the file is out of date
//
// Sidecar: exactly the packages esbuild puts into sidecar.mjs (metafile of the same entry point).
// Frontend: the production dependency tree of @forge/desktop (with @forge/protocol) from `pnpm licenses list --prod`; Vite
// bundles a subset of it, so the list may name a few packages more than the bundle contains.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
const SIDECAR = path.join(ROOT, "packages/sidecar");

/** Directory of the package a bundled file belongs to, or null for workspace sources. */
function packageDirOf(file) {
  const parts = path.resolve(SIDECAR, file).split(path.sep);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) return null;
  const len = parts[i + 1]?.startsWith("@") ? 2 : 1;
  return parts.slice(0, i + 1 + len).join(path.sep);
}

async function sidecarPackages() {
  const { build } = createRequire(path.join(SIDECAR, "package.json"))("esbuild");
  const { metafile } = await build({
    absWorkingDir: SIDECAR,
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const dirs = new Set();
  for (const file of Object.keys(metafile.inputs)) {
    const dir = packageDirOf(file);
    if (dir) dirs.add(dir);
  }
  return [...dirs];
}

function desktopPackages() {
  // "@forge/desktop..." includes the workspace packages it imports (@forge/protocol and its zod).
  // pnpm is a .cmd on Windows, so this runs through the shell; the command is fixed.
  const r = spawnSync('pnpm --filter "@forge/desktop..." licenses list --prod --json', {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
  if (r.status !== 0) throw new Error(`pnpm licenses list fehlgeschlagen:\n${r.stderr}`);
  return Object.values(JSON.parse(r.stdout)).flatMap((list) => list.flatMap((p) => p.paths));
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;
const COPYRIGHT_LINE = /^\s*(copyright\b|\(c\)\s|©)/i;

function describe(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const license =
    (typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(" OR ")) || "nicht angegeben";
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n").trim() }));
  const copyright = [...new Set(files.flatMap((f) => f.text.split("\n").filter((l) => COPYRIGHT_LINE.test(l)).map((l) => l.trim())))];
  return { name: pkg.name, version: pkg.version, license, source: pkg.homepage ?? repo ?? null, copyright, files };
}

function collect(dirs, part, all) {
  for (const dir of dirs) {
    if (!existsSync(path.join(dir, "package.json"))) continue;
    const p = describe(dir);
    if (p.name?.startsWith("@forge/")) continue;
    const key = `${p.name}@${p.version}`;
    const known = all.get(key) ?? { ...p, parts: new Set() };
    known.parts.add(part);
    all.set(key, known);
  }
}

const all = new Map();
collect(await sidecarPackages(), "Sidecar", all);
collect(desktopPackages(), "Oberfläche", all);
const packages = [...all.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const fence = (text) => {
  const ticks = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}text\n${text}\n${ticks}`;
};
const cell = (s) => s.replace(/\|/g, "\\|");

const lines = [
  "# Hinweise zu npm-Paketen von Drittanbietern",
  "",
  "Diese Datei erzeugt `scripts/third-party-notices.mjs`. Nicht von Hand bearbeiten.",
  "",
  "FORGE enthält die folgenden npm-Pakete: im Sidecar (`sidecar.mjs`) und in der Oberfläche, die in",
  "`forge-desktop.exe` eingebettet ist. Für die mitgelieferten Programme (Node.js, Git, GitHub CLI, Python)",
  "siehe `THIRD_PARTY_LICENSES.md`.",
  "",
  "| Paket | Version | Lizenz | Teil | Copyright |",
  "|---|---|---|---|---|",
  ...packages.map(
    (p) => `| ${cell(p.name)} | ${p.version} | ${cell(p.license)} | ${[...p.parts].join(", ")} | ${cell(p.copyright.join("; ") || "siehe Lizenztext")} |`,
  ),
  "",
  "## Lizenztexte",
  "",
];
for (const p of packages) {
  lines.push(`### ${p.name} ${p.version}`, "", `Lizenz: ${p.license}`);
  if (p.source) lines.push(`Quelle: ${p.source.replace(/^git\+/, "")}`);
  lines.push("");
  if (!p.files.length) lines.push("Das Paket enthält keine eigene Lizenzdatei. Es gilt der Standardtext der genannten Lizenz.", "");
  for (const f of p.files) lines.push(`\`${f.name}\`:`, "", fence(f.text), "");
}
const text = lines.join("\n");

if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== text) {
    console.error("THIRD_PARTY_NOTICES.md ist veraltet: node scripts/third-party-notices.mjs ausführen.");
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md ist aktuell (${packages.length} Pakete).`);
} else {
  writeFileSync(OUT, text);
  console.log(`THIRD_PARTY_NOTICES.md geschrieben (${packages.length} Pakete).`);
}

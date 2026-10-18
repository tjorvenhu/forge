// Authenticode signature for the Windows files of a release, with Azure Artifact Signing
// (signtool.exe from the Windows SDK plus Microsoft's dlib). Without it SmartScreen warns on every download.
//
//   node scripts/codesign.mjs --setup          download the dlib, find signtool, write metadata.json
//   node scripts/codesign.mjs <file> [...]     sign (also as Tauri's bundle.windows.signCommand, one file per call)
//
// Account:     AZURE_SIGNING_ENDPOINT (regional, e.g. https://weu.codesigning.azure.net),
//              AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE (certificate profile)
// Credentials: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET of an app registration with the role
//              "Artifact Signing Certificate Profile Signer". Without the secret the dlib tries the other
//              credentials of DefaultAzureCredential (locally: az login).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIR = path.join(ROOT, ".codesign");

// nuget.org publishes SHA-512 (base64) as packageHash in the catalog entry of the package.
const DLIB = {
  version: "1.0.146",
  url: "https://api.nuget.org/v3-flatcontainer/microsoft.artifactsigning.client/1.0.146/microsoft.artifactsigning.client.1.0.146.nupkg",
  sha512: "/G0hG/VDIS6psW23b5t1V/ORIgn0PVAOtGj9w+hkPmAuI4pempfwlW50E2GtHscnz9+5Qz3hbC4mcb7ej2Yn1A==",
};
const TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";
// The dlib needs the signtool of SDK 10.0.22621.755 or newer; 20348 does not work with it.
const MIN_SDK_BUILD = 22621;

const dlibPath = path.join(DIR, "dlib", "bin", "x64", "Azure.CodeSigning.Dlib.dll");
const metadataPath = path.join(DIR, "metadata.json");

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function findSigntool() {
  if (process.env.FORGE_SIGNTOOL) return process.env.FORGE_SIGNTOOL;
  const base = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const builds = existsSync(base)
    ? readdirSync(base)
        .filter((d) => /^10\.0\.\d+\.\d+$/.test(d))
        .map((d) => ({ dir: d, build: Number(d.split(".")[2]) }))
        .filter((d) => d.build >= MIN_SDK_BUILD && existsSync(path.join(base, d.dir, "x64", "signtool.exe")))
        .sort((a, b) => b.build - a.build)
    : [];
  if (!builds.length) fail(`signtool.exe aus dem Windows SDK 10.0.${MIN_SDK_BUILD} oder neuer nicht gefunden (${base}).`);
  return path.join(base, builds[0].dir, "x64", "signtool.exe");
}

async function setup() {
  const account = {
    Endpoint: process.env.AZURE_SIGNING_ENDPOINT?.trim(),
    CodeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT?.trim(),
    CertificateProfileName: process.env.AZURE_SIGNING_PROFILE?.trim(),
  };
  const missing = Object.entries({
    AZURE_SIGNING_ENDPOINT: account.Endpoint,
    AZURE_SIGNING_ACCOUNT: account.CodeSigningAccountName,
    AZURE_SIGNING_PROFILE: account.CertificateProfileName,
  }).filter(([, v]) => !v);
  if (missing.length) fail(`Für die Code-Signatur fehlt: ${missing.map(([k]) => k).join(", ")}.`);

  if (!existsSync(dlibPath)) {
    const res = await fetch(DLIB.url);
    if (!res.ok) fail(`Download der Artifact-Signing-dlib fehlgeschlagen: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const actual = createHash("sha512").update(data).digest("base64");
    if (actual !== DLIB.sha512) fail(`Prüfsumme der Artifact-Signing-dlib ${DLIB.version} stimmt nicht: ${actual}`);
    rmSync(path.join(DIR, "dlib"), { recursive: true, force: true });
    mkdirSync(path.join(DIR, "dlib"), { recursive: true });
    const nupkg = path.join(DIR, "dlib.zip");
    writeFileSync(nupkg, data);
    // Windows bsdtar reads zip archives; by full path so GNU tar from Git on PATH is not used.
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const r = spawnSync(tar, ["-xf", nupkg, "-C", path.join(DIR, "dlib")], { stdio: "inherit" });
    rmSync(nupkg, { force: true });
    if (r.status !== 0 || !existsSync(dlibPath)) fail("Artifact-Signing-dlib ließ sich nicht entpacken.");
  }

  const metadata = { ...account, CorrelationId: process.env.GITHUB_RUN_ID ? `forge-run-${process.env.GITHUB_RUN_ID}` : "forge-local" };
  // With a client secret only EnvironmentCredential applies; the others cost time and spam the log.
  if (process.env.AZURE_CLIENT_SECRET) {
    metadata.ExcludeCredentials = [
      "ManagedIdentityCredential",
      "WorkloadIdentityCredential",
      "SharedTokenCacheCredential",
      "VisualStudioCredential",
      "VisualStudioCodeCredential",
      "AzureCliCredential",
      "AzurePowerShellCredential",
      "AzureDeveloperCliCredential",
      "InteractiveBrowserCredential",
    ];
  }
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`Code-Signatur bereit: ${findSigntool()}, dlib ${DLIB.version}, Profil ${account.CertificateProfileName}`);
}

const isSigned = (signtool, file) => spawnSync(signtool, ["verify", "/pa", "/q", file], { stdio: "ignore" }).status === 0;

// Only FORGE's own executables get the Vanturis signature: the app, the installer, FORGE Setup (the online
// installer, apps/installer) and the uninstaller NSIS writes as a temp file (nstXXXX.tmp). Tauri hands
// every unsigned exe/dll to the sign command, including the bundled runtime (node, git, gh, python: third-party software) and the NSIS plugin DLLs; signatures
// per month are limited, so everything else is left as it is.
const SIGN_ONLY = [/^forge-desktop\.exe$/i, /_x64-setup\.exe$/i, /^FORGE-Setup\.exe$/i, /^nst[0-9a-f]+\.tmp$/i];

function signFile(signtool, file) {
  if (!existsSync(file)) fail(`Datei zum Signieren fehlt: ${file}`);
  // Tauri may pass canonicalized paths (\\?\C:\...).
  const name = path.basename(file.replace(/^\\\\\?\\/, ""));
  if (!SIGN_ONLY.some((re) => re.test(name))) {
    console.log(`nicht signiert (keine Signatur verbraucht): ${name}`);
    return;
  }
  if (isSigned(signtool, file)) {
    console.log(`schon signiert: ${path.basename(file)}`);
    return;
  }
  const args = ["sign", "/v", "/fd", "SHA256", "/tr", TIMESTAMP_URL, "/td", "SHA256",
    "/d", "FORGE", "/du", "https://vanturis.de", "/dlib", dlibPath, "/dmdf", metadataPath, file];
  // The timestamp server and the signing service fail now and then for a few seconds.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync(signtool, args, { stdio: "inherit" });
    if (r.status === 0 && isSigned(signtool, file)) {
      console.log(`codesigniert: ${path.basename(file)}`);
      return;
    }
    if (attempt < 3) {
      console.error(`Signieren von ${path.basename(file)} fehlgeschlagen, Versuch ${attempt + 1} von 3 …`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 5000);
    }
  }
  fail(`Code-Signatur fehlgeschlagen: ${file}`);
}

const args = process.argv.slice(2);
if (args[0] === "--setup") {
  await setup();
} else {
  if (!args.length) fail("Keine Dateien zum Signieren angegeben.");
  if (!existsSync(dlibPath) || !existsSync(metadataPath)) await setup();
  const signtool = findSigntool();
  for (const file of args) signFile(signtool, path.resolve(file));
}

// Signs release assets for the FORGE updater.
// The private key (PEM, Ed25519) comes from FORGE_UPDATE_SIGNING_KEY; the public half is in
// packages/sidecar/src/update/signature.ts. Message format: see signedMessage there.
//
//   node scripts/sign-update.mjs --manifest <FORGE_v.sig> <file> [...]   one signature file for all (JSON)
//   node scripts/sign-update.mjs <file> [<file> ...]                     <file>.sig next to each (up to 0.1.101)
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import path from "node:path";

const pem = process.env.FORGE_UPDATE_SIGNING_KEY;
if (!pem?.trim()) {
  console.error("FORGE_UPDATE_SIGNING_KEY fehlt: ohne Signatur installiert FORGE kein Update.");
  process.exit(1);
}
const key = createPrivateKey(pem);
const args = process.argv.slice(2);
const manifest = args[0] === "--manifest" ? args[1] : null;
const files = manifest ? args.slice(2) : args;
if ((args[0] === "--manifest" && !manifest) || !files.length) {
  console.error("Keine Dateien zum Signieren angegeben.");
  process.exit(1);
}

const sha256 = (file) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });

const signatures = {};
for (const file of files) {
  const name = path.basename(file);
  const message = Buffer.from(`FORGE-UPDATE-1\n${name}\n${await sha256(file)}`, "utf8");
  const signature = sign(null, message, key).toString("base64");
  if (manifest) signatures[name] = signature;
  else writeFileSync(`${file}.sig`, signature);
  console.log(`signiert: ${name}`);
}
if (manifest) writeFileSync(manifest, JSON.stringify(signatures, null, 2) + "\n");

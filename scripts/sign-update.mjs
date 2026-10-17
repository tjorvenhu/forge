// Signs release assets for the FORGE updater: writes <file>.sig next to each file.
// The private key (PEM, Ed25519) comes from FORGE_UPDATE_SIGNING_KEY; the public half is in
// packages/sidecar/src/update/signature.ts. Message format: see signedMessage there.
//
//   node scripts/sign-update.mjs <file> [<file> ...]
import { createHash, createPrivateKey, sign } from "node:crypto";
import { createReadStream, writeFileSync } from "node:fs";
import path from "node:path";

const pem = process.env.FORGE_UPDATE_SIGNING_KEY;
if (!pem?.trim()) {
  console.error("FORGE_UPDATE_SIGNING_KEY fehlt: ohne Signatur installiert FORGE kein Update.");
  process.exit(1);
}
const key = createPrivateKey(pem);
const files = process.argv.slice(2);
if (!files.length) {
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

for (const file of files) {
  const name = path.basename(file);
  const message = Buffer.from(`FORGE-UPDATE-1\n${name}\n${await sha256(file)}`, "utf8");
  writeFileSync(`${file}.sig`, sign(null, message, key).toString("base64"));
  console.log(`signiert: ${name}`);
}

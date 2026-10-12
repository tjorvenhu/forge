/**
 * Registers once with the phone settings stored in FORGE and prints every SIP packet (passwords and
 * digest responses masked), then signs off again. For finding out what the PBX answers.
 *
 *   pnpm tsx scripts/sip-probe.ts
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { SecretStore } from "../src/phone/secrets.js";
import { SipUserAgent } from "../src/phone/sip-ua.js";

const dataDir = process.env.FORGE_DATA_DIR || path.join(process.env.APPDATA ?? "", "forge");
const db = new DatabaseSync(path.join(dataDir, "forge.db"), { readOnly: true });
const row = db.prepare("SELECT value FROM settings WHERE key = 'phone'").get() as { value: string } | undefined;
if (!row) throw new Error("Keine Telefon-Einstellungen in FORGE.");
const cfg = JSON.parse(row.value) as { server: string; port: number; username: string; authUsername: string | null; domain: string | null; displayName: string };
const password = await new SecretStore(path.join(dataDir, "secrets")).get("sip-password");
if (!password) throw new Error("Kein SIP-Passwort gespeichert.");

const mask = (s: string) => s.replace(/(response|nonce|cnonce)="[^"]*"/gi, '$1="…"');
const ua = new SipUserAgent({ ...cfg, password, displayName: cfg.displayName || "FORGE" });
const anyUa = ua as unknown as { sendTo: (t: string, ip: string, port: number) => void; onDatagram: (raw: string, ip: string, port: number) => void };
const send = anyUa.sendTo.bind(ua);
anyUa.sendTo = (t, ip, port) => {
  console.log(`\n>>> an ${ip}:${port}\n${mask(t).trimEnd()}`);
  send(t, ip, port);
};
const recv = anyUa.onDatagram.bind(ua);
anyUa.onDatagram = (raw, ip, port) => {
  console.log(`\n<<< von ${ip}:${port}\n${mask(raw).trimEnd()}`);
  recv(raw, ip, port);
};
ua.on("log", (m) => console.log(`[log] ${m}`));
let done: (v: string) => void;
const result = new Promise<string>((r) => (done = r));
ua.on("registration", (state, message) => {
  console.log(`[registration] ${state}${message ? `: ${message}` : ""}`);
  if (state === "registered" || state === "failed") done(state);
});
console.log(`Anmeldung als ${cfg.username}${cfg.authUsername ? ` (Auth ${cfg.authUsername})` : ""} an ${cfg.server}:${cfg.port}, Domain ${cfg.domain ?? cfg.server}`);
await ua.start();
const state = await Promise.race([result, new Promise<string>((r) => setTimeout(() => r("timeout"), 15_000))]);
console.log(`\nErgebnis: ${state}. Lokale Adresse ${ua.localIp}. Melde ab …`);
await ua.stop();
process.exit(0);

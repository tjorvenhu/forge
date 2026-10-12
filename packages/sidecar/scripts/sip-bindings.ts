/**
 * Asks the PBX where an extension is registered: REGISTER without Contact (RFC 3261 10.2.3), which
 * changes nothing and is answered with all current bindings. The password comes from the
 * environment variable SIP_PASSWORD and is never printed.
 *
 *   SIP_PASSWORD=… pnpm tsx scripts/sip-bindings.ts <server> <user>
 */
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { digestAuthorization, parseChallenge } from "../src/phone/digest.js";
import { getHeader, getHeaders, parseSip } from "../src/phone/sip-message.js";

const [server = "", user = ""] = process.argv.slice(2);
const password = process.env.SIP_PASSWORD ?? "";
if (!server || !user || !password) throw new Error("Aufruf: SIP_PASSWORD=… tsx scripts/sip-bindings.ts <server> <user>");
const { address } = await lookup(server, 4);
const sock = createSocket("udp4");
await new Promise<void>((r) => sock.bind(0, () => r()));
const local = sock.address();
const callId = `${randomBytes(8).toString("hex")}@probe`;
const tag = randomBytes(4).toString("hex");

function request(cseq: number, auth?: string) {
  return [
    `REGISTER sip:${server} SIP/2.0`,
    `Via: SIP/2.0/UDP 0.0.0.0:${local.port};branch=z9hG4bK${randomBytes(6).toString("hex")};rport`,
    "Max-Forwards: 70",
    `From: <sip:${user}@${server}>;tag=${tag}`,
    `To: <sip:${user}@${server}>`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} REGISTER`,
    ...(auth ? [`Authorization: ${auth}`] : []),
    "User-Agent: FORGE-probe",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");
}

function exchange(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("keine Antwort")), 5000);
    sock.once("message", (b) => {
      clearTimeout(t);
      resolve(b.toString("utf8"));
    });
    sock.send(text, 5060, address);
  });
}

const first = parseSip(await exchange(request(1)));
const ch = first ? parseChallenge(getHeader(first, "www-authenticate") ?? "") : null;
if (!first || !ch) throw new Error(`Unerwartete Antwort: ${first?.status}`);
const auth = digestAuthorization(ch, { username: user, password, method: "REGISTER", uri: `sip:${server}` });
const res = parseSip(await exchange(request(2, auth)));
console.log(`Antwort: ${res?.status} ${res?.reason ?? ""}`);
const contacts = res ? getHeaders(res, "contact") : [];
console.log(contacts.length ? `Bindungen von ${user}:\n${contacts.map((c) => `  ${c}`).join("\n")}` : `Keine Bindung: ${user} ist an der Anlage nicht angemeldet.`);
sock.close();

import { randomBytes } from "node:crypto";

/** One SIP request or response (RFC 3261). Header names are kept in their long, lower-case form. */
export interface SipMessage {
  method?: string;
  uri?: string;
  status?: number;
  reason?: string;
  headers: Array<[string, string]>;
  body: string;
}

const COMPACT: Record<string, string> = {
  v: "via",
  f: "from",
  t: "to",
  i: "call-id",
  m: "contact",
  l: "content-length",
  c: "content-type",
  k: "supported",
  s: "subject",
  e: "content-encoding",
};

const CANONICAL: Record<string, string> = {
  via: "Via",
  from: "From",
  to: "To",
  "call-id": "Call-ID",
  cseq: "CSeq",
  contact: "Contact",
  "content-length": "Content-Length",
  "content-type": "Content-Type",
  "max-forwards": "Max-Forwards",
  "www-authenticate": "WWW-Authenticate",
  "proxy-authenticate": "Proxy-Authenticate",
  authorization: "Authorization",
  "proxy-authorization": "Proxy-Authorization",
  "record-route": "Record-Route",
  route: "Route",
  "user-agent": "User-Agent",
  allow: "Allow",
  supported: "Supported",
  expires: "Expires",
};

export function headerName(name: string): string {
  const n = name.trim().toLowerCase();
  return COMPACT[n] ?? n;
}

function canonical(name: string): string {
  return CANONICAL[name] ?? name.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase());
}

/** Parses one datagram. Returns null for keep-alives and anything that is not SIP. */
export function parseSip(raw: string): SipMessage | null {
  const split = raw.indexOf("\r\n\r\n");
  const head = split >= 0 ? raw.slice(0, split) : raw;
  let body = split >= 0 ? raw.slice(split + 4) : "";
  const lines = head.split(/\r?\n/);
  const start = lines.shift()?.trim() ?? "";
  if (!start) return null;
  const msg: SipMessage = { headers: [], body: "" };
  const res = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/.exec(start);
  const req = /^([A-Z]+)\s+(\S+)\s+SIP\/2\.0$/.exec(start);
  if (res) {
    msg.status = Number(res[1]);
    msg.reason = res[2] ?? "";
  } else if (req) {
    msg.method = req[1];
    msg.uri = req[2];
  } else return null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && msg.headers.length) {
      msg.headers[msg.headers.length - 1]![1] += " " + line.trim();
      continue;
    }
    const i = line.indexOf(":");
    if (i <= 0) continue;
    msg.headers.push([headerName(line.slice(0, i)), line.slice(i + 1).trim()]);
  }
  const len = Number(getHeader(msg, "content-length") ?? NaN);
  if (Number.isFinite(len)) body = Buffer.from(body, "utf8").subarray(0, len).toString("utf8");
  msg.body = body;
  return msg;
}

export function getHeader(msg: SipMessage, name: string): string | undefined {
  const n = headerName(name);
  return msg.headers.find(([k]) => k === n)?.[1];
}

/** All values of a header, also when several are combined in one line with commas. */
export function getHeaders(msg: SipMessage, name: string): string[] {
  const n = headerName(name);
  return msg.headers.filter(([k]) => k === n).flatMap(([, v]) => (n === "via" || n === "record-route" || n === "route" || n === "contact" ? splitList(v) : [v]));
}

export function setHeader(msg: SipMessage, name: string, value: string) {
  const n = headerName(name);
  msg.headers = msg.headers.filter(([k]) => k !== n);
  msg.headers.push([n, value]);
}

/** Splits a header list at commas outside quotes and angle brackets. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "<") angle++;
    if (!quoted && ch === ">") angle = Math.max(0, angle - 1);
    if (ch === "," && !quoted && angle === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function serializeSip(msg: SipMessage): string {
  const start = msg.method ? `${msg.method} ${msg.uri} SIP/2.0` : `SIP/2.0 ${msg.status} ${msg.reason ?? ""}`;
  const lines = [start];
  for (const [k, v] of msg.headers) if (k !== "content-length") lines.push(`${canonical(k)}: ${v}`);
  lines.push(`Content-Length: ${Buffer.byteLength(msg.body, "utf8")}`);
  return lines.join("\r\n") + "\r\n\r\n" + msg.body;
}

export interface NameAddr {
  display: string | null;
  uri: string;
  params: Record<string, string>;
}

/** `"Name" <sip:user@host>;tag=x` or `sip:user@host;tag=x`. */
export function parseNameAddr(value: string): NameAddr {
  const m = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<"]*?))?\s*<([^>]*)>(.*)$/.exec(value);
  let uri: string;
  let rest: string;
  let display: string | null = null;
  if (m) {
    display = (m[1] ?? m[2] ?? "").trim() || null;
    uri = m[3]!.trim();
    rest = m[4] ?? "";
  } else {
    const semi = value.indexOf(";");
    uri = (semi >= 0 ? value.slice(0, semi) : value).trim();
    rest = semi >= 0 ? value.slice(semi) : "";
  }
  return { display, uri, params: parseParams(rest) };
}

export function parseParams(rest: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const part of rest.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    params[(eq >= 0 ? p.slice(0, eq) : p).toLowerCase()] = eq >= 0 ? p.slice(eq + 1).replace(/^"|"$/g, "") : "";
  }
  return params;
}

export function tagOf(value: string | undefined): string | null {
  return value ? (parseNameAddr(value).params.tag ?? null) : null;
}

/** User part of a SIP URI ("sip:+4930123@pbx;user=phone" -> "+4930123"). */
export function uriUser(uri: string): string {
  const m = /^(?:sips?|tel):([^@;>]+)/i.exec(uri.trim());
  return m ? decodeURIComponent(m[1]!) : uri;
}

export interface Via {
  transport: string;
  host: string;
  port: number | null;
  params: Record<string, string>;
}

export function parseVia(value: string): Via | null {
  const m = /^SIP\/2\.0\/(\w+)\s+([^;\s]+)(.*)$/i.exec(value.trim());
  if (!m) return null;
  const hostPort = m[2]!;
  const hp = /^\[([^\]]+)\](?::(\d+))?$|^([^:]+)(?::(\d+))?$/.exec(hostPort);
  return {
    transport: m[1]!.toUpperCase(),
    host: hp?.[1] ?? hp?.[3] ?? hostPort,
    port: hp?.[2] ?? hp?.[4] ? Number(hp?.[2] ?? hp?.[4]) : null,
    params: parseParams(m[3] ?? ""),
  };
}

export function cseqOf(msg: SipMessage): { seq: number; method: string } {
  const [n, m] = (getHeader(msg, "cseq") ?? "0 UNKNOWN").trim().split(/\s+/);
  return { seq: Number(n) || 0, method: (m ?? "").toUpperCase() };
}

export function randomToken(bytes = 8): string {
  return randomBytes(bytes).toString("hex");
}

export function newBranch(): string {
  return `z9hG4bK${randomToken(10)}`;
}

/** Response to a request: Via, From, To (with our tag), Call-ID and CSeq copied as RFC 3261 requires. */
export function responseTo(req: SipMessage, status: number, reason: string, toTag?: string): SipMessage {
  const headers: Array<[string, string]> = [];
  for (const [k, v] of req.headers) if (k === "via" || k === "record-route") headers.push([k, v]);
  const to = getHeader(req, "to") ?? "";
  headers.push(["from", getHeader(req, "from") ?? ""]);
  headers.push(["to", toTag && !tagOf(to) ? `${to};tag=${toTag}` : to]);
  headers.push(["call-id", getHeader(req, "call-id") ?? ""]);
  headers.push(["cseq", getHeader(req, "cseq") ?? ""]);
  return { status, reason, headers, body: "" };
}

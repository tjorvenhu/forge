/** Minimal SDP for one audio stream with G.711 and DTMF (RFC 4566, RFC 4733). */

export const PT_PCMU = 0;
export const PT_PCMA = 8;
const DEFAULT_DTMF_PT = 101;

/** a=sendrecv and friends, from the point of view of the side that wrote the SDP */
export type MediaDirection = "sendrecv" | "sendonly" | "recvonly" | "inactive";
const DIRECTIONS: readonly string[] = ["sendrecv", "sendonly", "recvonly", "inactive"];

export interface MediaOffer {
  ip: string;
  port: number;
  /** payload types in the order of preference of the sender */
  payloads: number[];
  /** dynamic payload type of telephone-event, if offered */
  dtmfPt: number | null;
  /** codec name per payload type from a=rtpmap */
  rtpmap: Record<number, string>;
  secure: boolean;
  /** c=0.0.0.0 (old-style hold, RFC 2543) counts as sendonly: the other side wants no audio */
  direction: MediaDirection;
}

export function buildSdp(opts: { ip: string; port: number; sessionId: string; version: number; codec?: number; dtmfPt?: number | null; direction?: MediaDirection }): string {
  const codecs = opts.codec !== undefined ? [opts.codec] : [PT_PCMA, PT_PCMU];
  const dtmf = opts.dtmfPt === undefined ? DEFAULT_DTMF_PT : opts.dtmfPt;
  const pts = dtmf !== null ? [...codecs, dtmf] : codecs;
  const lines = [
    "v=0",
    `o=FORGE ${opts.sessionId} ${opts.version} IN IP4 ${opts.ip}`,
    "s=FORGE",
    `c=IN IP4 ${opts.ip}`,
    "t=0 0",
    `m=audio ${opts.port} RTP/AVP ${pts.join(" ")}`,
  ];
  for (const c of codecs) lines.push(c === PT_PCMA ? "a=rtpmap:8 PCMA/8000" : "a=rtpmap:0 PCMU/8000");
  if (dtmf !== null) lines.push(`a=rtpmap:${dtmf} telephone-event/8000`, `a=fmtp:${dtmf} 0-16`);
  lines.push("a=ptime:20", `a=${opts.direction ?? "sendrecv"}`);
  return lines.join("\r\n") + "\r\n";
}

export function parseSdp(sdp: string): MediaOffer | null {
  let sessionIp: string | null = null;
  let mediaIp: string | null = null;
  let port = 0;
  let payloads: number[] = [];
  let secure = false;
  let inAudio = false;
  let seenAudio = false;
  let sessionDir: MediaDirection | null = null;
  let mediaDir: MediaDirection | null = null;
  const rtpmap: Record<number, string> = {};
  for (const raw of sdp.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("m=")) {
      inAudio = false;
      const m = /^m=audio\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (m && !seenAudio) {
        inAudio = seenAudio = true;
        port = Number(m[1]);
        secure = /SAVP/i.test(m[2]!);
        payloads = m[3]!.trim().split(/\s+/).map(Number).filter(Number.isFinite);
      }
    } else if (line.startsWith("c=")) {
      const ip = /^c=IN IP4 (\S+)/.exec(line)?.[1] ?? null;
      if (inAudio) mediaIp = ip;
      else if (!seenAudio) sessionIp = ip;
    } else if (line.startsWith("a=") && DIRECTIONS.includes(line.slice(2))) {
      if (inAudio) mediaDir = line.slice(2) as MediaDirection;
      else if (!seenAudio) sessionDir = line.slice(2) as MediaDirection;
    } else if (inAudio && line.startsWith("a=rtpmap:")) {
      const m = /^a=rtpmap:(\d+)\s+([^/\s]+)/.exec(line);
      if (m) rtpmap[Number(m[1])] = m[2]!.toLowerCase();
    }
  }
  const ip = mediaIp ?? sessionIp;
  if (!seenAudio || !ip) return null;
  const dtmfEntry = Object.entries(rtpmap).find(([, name]) => name === "telephone-event");
  let direction: MediaDirection = mediaDir ?? sessionDir ?? "sendrecv";
  if (ip === "0.0.0.0" && direction === "sendrecv") direction = "sendonly";
  return { ip, port, payloads, dtmfPt: dtmfEntry ? Number(dtmfEntry[0]) : null, rtpmap, secure, direction };
}

/** First audio codec of the remote side that FORGE speaks (PCMA or PCMU), or null. */
export function chooseCodec(offer: MediaOffer): number | null {
  for (const pt of offer.payloads) {
    const name = offer.rtpmap[pt] ?? (pt === PT_PCMU ? "pcmu" : pt === PT_PCMA ? "pcma" : "");
    if (pt === PT_PCMA || name === "pcma") return PT_PCMA;
    if (pt === PT_PCMU || name === "pcmu") return PT_PCMU;
  }
  return null;
}

/** Our direction in the answer to an offer (RFC 3264 6.1): hold is answered with recvonly, not sendrecv. */
export function answerDirection(offered: MediaDirection): MediaDirection {
  return offered === "sendonly" ? "recvonly" : offered === "recvonly" ? "sendonly" : offered;
}

/** Same SDP with another direction and the next o= version (RFC 3264 8: changed SDP needs a new version). */
export function withDirection(sdp: string, direction: MediaDirection): string {
  return sdp.replace(/^a=(sendrecv|sendonly|recvonly|inactive)(?=\r?$)/m, `a=${direction}`).replace(/^(o=\S+ \S+ )(\d+)/m, (_, head: string, v: string) => `${head}${Number(v) + 1}`);
}

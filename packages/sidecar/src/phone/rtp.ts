import { createSocket, type Socket } from "node:dgram";
import { randomInt } from "node:crypto";
import { EventEmitter } from "node:events";
import { decodeG711, encodeG711, FRAME_SAMPLES } from "./audio.js";

const DTMF_EVENTS = "0123456789*#ABCD";
const SILENCE = new Int16Array(FRAME_SAMPLES);

export interface RtpEvents {
  audio: [Int16Array];
  dtmf: [string];
  /** playback queue ran empty */
  drained: [];
}

/**
 * One RTP audio stream (RFC 3550) with G.711. Sends a frame every 20 ms (silence when nothing is
 * queued, so the PBX never sees a dead stream), plays queued audio, receives audio and DTMF events.
 */
export class RtpSession extends EventEmitter<RtpEvents> {
  private socket: Socket | null = null;
  private remote: { ip: string; port: number } | null = null;
  private pt = 8;
  private dtmfPt: number | null = 101;
  private seq = randomInt(0, 0xffff);
  private ts = randomInt(0, 0x7fffffff);
  private readonly ssrc = randomInt(1, 0x7fffffff);
  private queue: Int16Array[] = [];
  /** start of a frame that is not complete yet */
  private pending = new Int16Array(0);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt = 0;
  private lastDtmfTs: number | null = null;
  private latched = false;
  port = 0;

  constructor(private readonly localIp: string) {
    super();
  }

  /** Binds an even port in the usual RTP range. */
  async open(): Promise<number> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const port = 2 * randomInt(20000, 30000);
      const sock = createSocket("udp4");
      const ok = await new Promise<boolean>((resolve) => {
        sock.once("error", () => resolve(false));
        sock.bind(port, () => resolve(true));
      });
      if (!ok) {
        sock.close();
        continue;
      }
      this.socket = sock;
      this.port = port;
      sock.on("message", (buf, rinfo) => this.onPacket(buf, rinfo.address, rinfo.port));
      sock.on("error", () => {});
      return port;
    }
    throw new Error("Kein freier Port für Audio (RTP) gefunden.");
  }

  get address() {
    return { ip: this.localIp, port: this.port };
  }

  configure(remote: { ip: string; port: number }, pt: number, dtmfPt: number | null) {
    this.remote = remote;
    this.pt = pt;
    this.dtmfPt = dtmfPt;
  }

  start() {
    if (this.timer) return;
    this.nextAt = Date.now();
    const tick = () => {
      this.sendFrame();
      this.nextAt += 20;
      // Catch up after a stall instead of bursting a backlog.
      if (Date.now() - this.nextAt > 200) this.nextAt = Date.now();
      this.timer = setTimeout(tick, Math.max(0, this.nextAt - Date.now()));
    };
    tick();
  }

  /**
   * Queues audio (8 kHz PCM) for playback. Streamed audio arrives in chunks of any size; a partial
   * 20 ms frame is kept until the next chunk instead of being padded, because padding inserts
   * short gaps of silence that are heard as crackling. `flush()` ends an utterance.
   */
  play(pcm: Int16Array) {
    let data = pcm;
    if (this.pending.length) {
      data = new Int16Array(this.pending.length + pcm.length);
      data.set(this.pending);
      data.set(pcm, this.pending.length);
    }
    const full = data.length - (data.length % FRAME_SAMPLES);
    for (let i = 0; i < full; i += FRAME_SAMPLES) this.queue.push(data.slice(i, i + FRAME_SAMPLES));
    this.pending = data.slice(full);
  }

  /** Plays the rest of an utterance; the last partial frame fades out instead of breaking off. */
  flush() {
    if (!this.pending.length) return;
    const frame = new Int16Array(FRAME_SAMPLES);
    const n = this.pending.length;
    for (let i = 0; i < n; i++) frame[i] = Math.round(this.pending[i]! * (1 - i / n));
    this.queue.push(frame);
    this.pending = new Int16Array(0);
  }

  /** Stops playback (barge-in), with a 20 ms fade so the cut does not click. */
  clearPlayback() {
    const next = this.queue[0];
    this.queue = [];
    this.pending = new Int16Array(0);
    if (next) this.queue.push(next.map((s, i) => Math.round(s * (1 - i / FRAME_SAMPLES))));
  }

  get playing(): boolean {
    return this.queue.length > 0 || this.pending.length > 0;
  }

  /** Remaining playback in ms. */
  get queuedMs(): number {
    return this.queue.length * 20;
  }

  close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue = [];
    this.pending = new Int16Array(0);
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
    this.socket = null;
  }

  private sendFrame() {
    if (!this.socket || !this.remote) return;
    const had = this.queue.length > 0;
    const frame = this.queue.shift() ?? SILENCE;
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = this.pt & 0x7f;
    header.writeUInt16BE(this.seq, 2);
    header.writeUInt32BE(this.ts >>> 0, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
    this.socket.send(Buffer.concat([header, encodeG711(frame, this.pt)]), this.remote.port, this.remote.ip);
    if (had && this.queue.length === 0) this.emit("drained");
  }

  private onPacket(buf: Buffer, ip: string, port: number) {
    if (buf.length < 12 || buf[0]! >> 6 !== 2) return;
    // Symmetric RTP: behind NAT the PBX may send from another address than its SDP says.
    if (!this.latched && this.remote && (this.remote.ip !== ip || this.remote.port !== port)) {
      this.remote = { ip, port };
    }
    this.latched = true;
    const cc = buf[0]! & 0x0f;
    const hasExt = (buf[0]! & 0x10) !== 0;
    const padding = (buf[0]! & 0x20) !== 0;
    const pt = buf[1]! & 0x7f;
    let offset = 12 + cc * 4;
    if (hasExt && buf.length >= offset + 4) offset += 4 + buf.readUInt16BE(offset + 2) * 4;
    let end = buf.length;
    if (padding) end -= buf[buf.length - 1]!;
    if (offset >= end) return;
    const payload = buf.subarray(offset, end);
    if (this.dtmfPt !== null && pt === this.dtmfPt) {
      this.onDtmf(payload, buf.readUInt32BE(4));
      return;
    }
    if (pt === 0 || pt === 8) this.emit("audio", decodeG711(payload, pt));
  }

  /** RFC 4733: one event is sent several times; report it once, at the first end packet. */
  private onDtmf(payload: Buffer, timestamp: number) {
    if (payload.length < 4) return;
    const event = payload[0]!;
    const end = (payload[1]! & 0x80) !== 0;
    if (!end || this.lastDtmfTs === timestamp) return;
    this.lastDtmfTs = timestamp;
    const digit = DTMF_EVENTS[event];
    if (digit) this.emit("dtmf", digit);
  }
}

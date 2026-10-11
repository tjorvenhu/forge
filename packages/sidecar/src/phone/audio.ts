/** Audio helpers for telephone audio: 8 kHz, 16-bit mono PCM internally, G.711 on the wire. */

export const SAMPLE_RATE = 8000;
/** 20 ms at 8 kHz */
export const FRAME_SAMPLES = 160;

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToLinear(byte: number): number {
  const u = ~byte & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const s = (((mantissa << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return sign ? -s : s;
}

const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

/** As in the CCITT reference (g711.c): 13-bit magnitude, segment search, XOR 0x55. */
export function linearToAlaw(sample: number): number {
  let v = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 3;
  let mask: number;
  if (v >= 0) mask = 0xd5;
  else {
    mask = 0x55;
    v = -v - 1;
  }
  const seg = ALAW_SEG_END.findIndex((end) => v <= end);
  if (seg < 0) return 0x7f ^ mask;
  const aval = (seg << 4) | (seg < 2 ? (v >> 1) & 0x0f : (v >> seg) & 0x0f);
  return aval ^ mask;
}

export function alawToLinear(byte: number): number {
  const a = byte ^ 0x55;
  const exponent = (a >> 4) & 0x07;
  const mantissa = a & 0x0f;
  let s = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  if (!(a & 0x80)) s = -s;
  return s;
}

export function encodeG711(pcm: Int16Array, pt: number): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pt === 8 ? linearToAlaw(pcm[i]!) : linearToMulaw(pcm[i]!);
  return out;
}

export function decodeG711(payload: Uint8Array, pt: number): Int16Array {
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = pt === 8 ? alawToLinear(payload[i]!) : mulawToLinear(payload[i]!);
  return out;
}

/**
 * Integer downsampling (e.g. 24 kHz -> 8 kHz) with a windowed-sinc low-pass, so speech from the
 * TTS does not alias into the telephone band. `carry` keeps the filter history between chunks.
 */
export class Downsampler {
  private readonly taps: Float64Array;
  private history: Float64Array;
  private phase = 0;

  constructor(private readonly factor: number) {
    const n = factor * 8 + 1;
    const cutoff = 0.9 / (2 * factor);
    this.taps = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = i - (n - 1) / 2;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
      this.taps[i] = sinc * w;
      sum += this.taps[i]!;
    }
    for (let i = 0; i < n; i++) this.taps[i]! /= sum;
    this.history = new Float64Array(n);
  }

  push(input: Int16Array): Int16Array {
    const n = this.taps.length;
    const out: number[] = [];
    for (const s of input) {
      this.history.copyWithin(0, 1);
      this.history[n - 1] = s;
      if (this.phase === 0) {
        let acc = 0;
        for (let k = 0; k < n; k++) acc += this.history[k]! * this.taps[k]!;
        out.push(Math.max(-32768, Math.min(32767, Math.round(acc))));
      }
      this.phase = (this.phase + 1) % this.factor;
    }
    return Int16Array.from(out);
  }
}

/** Little-endian 16-bit PCM bytes to samples; an odd trailing byte is returned for the next chunk. */
export function bytesToPcm(bytes: Uint8Array): { samples: Int16Array; rest: Uint8Array } {
  const even = bytes.length - (bytes.length % 2);
  const samples = new Int16Array(even / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, even);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true);
  return { samples, rest: bytes.slice(even) };
}

export function pcmToWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(pcm[i]!, i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function rms(frame: Int16Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (const s of frame) sum += s * s;
  return Math.sqrt(sum / frame.length);
}

/** A short, soft two-tone signal (e.g. after a correct PIN). */
export function beep(ms = 180, freq = 880): Int16Array {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / 80, (n - i) / 80);
    out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 6000 * env);
  }
  return out;
}

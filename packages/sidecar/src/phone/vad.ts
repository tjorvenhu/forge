import { EventEmitter } from "node:events";
import { rms } from "./audio.js";

export interface VadOptions {
  /** absolute minimum level that counts as speech */
  minLevel: number;
  /** frames (20 ms) above the threshold before speech starts */
  startFrames: number;
  /** silence after speech that ends an utterance */
  endSilenceMs: number;
  /** longest utterance; longer speech is cut and sent */
  maxUtteranceMs: number;
  /** utterances shorter than this are noise (a cough, a click) */
  minUtteranceMs: number;
}

const DEFAULTS: VadOptions = { minLevel: 450, startFrames: 3, endSilenceMs: 700, maxUtteranceMs: 20_000, minUtteranceMs: 300 };
const PREROLL_FRAMES = 10;

export interface VadEvents {
  speechStart: [];
  utterance: [Int16Array];
}

/**
 * Energy-based voice activity detection for 20 ms frames. The noise floor adapts while nobody
 * speaks; speech must be clearly above it. While FORGE itself talks the threshold is raised, so
 * a remaining echo from the phone does not cut FORGE off.
 */
export class Vad extends EventEmitter<VadEvents> {
  private readonly o: VadOptions;
  private floor = 200;
  private above = 0;
  private speaking = false;
  private silenceMs = 0;
  private frames: Int16Array[] = [];
  private preroll: Int16Array[] = [];
  /** set while FORGE plays audio */
  outputActive = false;

  constructor(options: Partial<VadOptions> = {}) {
    super();
    this.o = { ...DEFAULTS, ...options };
  }

  push(frame: Int16Array) {
    const level = rms(frame);
    const threshold = Math.max(this.o.minLevel, this.floor * 3) * (this.outputActive ? 2.5 : 1);
    const loud = level > threshold;
    if (!this.speaking) {
      this.floor = this.floor * 0.95 + Math.min(level, this.floor * 4) * 0.05;
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      this.above = loud ? this.above + 1 : 0;
      if (this.above >= this.o.startFrames) {
        this.speaking = true;
        this.silenceMs = 0;
        this.frames = [...this.preroll];
        this.preroll = [];
        this.emit("speechStart");
      }
      return;
    }
    this.frames.push(frame);
    this.silenceMs = loud ? 0 : this.silenceMs + frame.length / 8;
    const length = durationMs(this.frames);
    if (this.silenceMs >= this.o.endSilenceMs || length >= this.o.maxUtteranceMs) this.finish();
  }

  /** Drops what was heard so far (e.g. when the call ends). */
  reset() {
    this.speaking = false;
    this.above = 0;
    this.frames = [];
    this.preroll = [];
  }

  private finish() {
    const voiced = durationMs(this.frames) - this.silenceMs;
    const frames = this.frames;
    this.reset();
    if (voiced < this.o.minUtteranceMs) return;
    // Packet sizes can change within a call (10, 20 or 30 ms), so frames are not all equally long.
    const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let offset = 0;
    for (const f of frames) {
      out.set(f, offset);
      offset += f.length;
    }
    this.emit("utterance", out);
  }
}

/** 8 samples per ms at 8 kHz */
function durationMs(frames: Int16Array[]): number {
  return frames.reduce((n, f) => n + f.length, 0) / 8;
}

import { EventEmitter } from "node:events";
import { rms } from "./audio.js";

export interface VadOptions {
  /** absolute minimum level that counts as speech */
  minLevel: number;
  /** frames (20 ms) above the threshold before speech starts */
  startFrames: number;
  /** the same while FORGE talks: a short sound must not cut FORGE off */
  bargeInFrames: number;
  /** silence after speech that ends an utterance (not the caller's turn, see CallController) */
  endSilenceMs: number;
  /** longest utterance; longer speech is cut and sent */
  maxUtteranceMs: number;
  /** utterances with less sound than this are noise (a click); a short "ja" must still count */
  minUtteranceMs: number;
}

const DEFAULTS: VadOptions = { minLevel: 450, startFrames: 3, bargeInFrames: 12, endSilenceMs: 700, maxUtteranceMs: 20_000, minUtteranceMs: 120 };
/** longer than bargeInFrames, so the first syllable of a barge-in is still in the utterance */
const PREROLL_FRAMES = 16;

export interface VadEvents {
  speechStart: [];
  utterance: [Int16Array];
  /** speech started but was too short to count */
  noise: [];
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
  /** length of the current run of loud frames before speech starts */
  private aboveMs = 0;
  /** quiet audio before the speech in this utterance, kept so the first syllable is not cut */
  private leadMs = 0;
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
      // Loud frames barely move the floor: while a barge-in is still being counted, the speech itself
      // must not raise the threshold above it.
      const rate = loud ? 0.005 : 0.05;
      this.floor = this.floor * (1 - rate) + Math.min(level, this.floor * 4) * rate;
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
      this.above = loud ? this.above + 1 : 0;
      this.aboveMs = loud ? this.aboveMs + frame.length / 8 : 0;
      if (this.above >= (this.outputActive ? this.o.bargeInFrames : this.o.startFrames)) {
        this.speaking = true;
        this.silenceMs = 0;
        this.frames = [...this.preroll];
        this.leadMs = Math.max(0, durationMs(this.preroll) - this.aboveMs);
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

  /** the caller is talking right now */
  get active(): boolean {
    return this.speaking;
  }

  /** Drops what was heard so far (e.g. when the call ends). */
  reset() {
    this.speaking = false;
    this.above = 0;
    this.aboveMs = 0;
    this.frames = [];
    this.preroll = [];
  }

  private finish() {
    const voiced = durationMs(this.frames) - this.silenceMs - this.leadMs;
    const frames = this.frames;
    this.reset();
    if (voiced < this.o.minUtteranceMs) {
      this.emit("noise");
      return;
    }
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

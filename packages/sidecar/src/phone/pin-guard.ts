import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export type PinResult = "ok" | "wrong" | "locked";

/** Persisted between calls and app starts; keys are normalized caller numbers, GLOBAL counts all of them. */
export interface PinGuardState {
  failures: Array<{ key: string; at: number }>;
  lockedUntil: Record<string, number>;
}

export interface PinLimits {
  /** wrong PINs per caller number within `windowMs` until that number is locked */
  perCaller: number;
  /** wrong PINs from all numbers within `windowMs` until PIN entry is locked for everyone */
  global: number;
  windowMs: number;
  lockMs: number;
  /** wait before a wrong PIN is answered; doubles with each recent failure of the caller */
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * A 4-digit PIN has 10,000 values and caller numbers can be spoofed, so three tries per call alone do
 * not stop someone who calls again and again. Limits: 5 wrong PINs per number or 10 overall within an
 * hour lock PIN entry for an hour; each wrong PIN is answered later than the one before.
 */
export const DEFAULT_PIN_LIMITS: PinLimits = { perCaller: 5, global: 10, windowMs: 60 * 60_000, lockMs: 60 * 60_000, baseDelayMs: 1000, maxDelayMs: 16_000 };

const GLOBAL = "*";

export function emptyPinGuardState(): PinGuardState {
  return { failures: [], lockedUntil: {} };
}

const scryptAsync = (pin: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => scrypt(pin, salt, 32, (err, key) => (err ? reject(err) : resolve(key))));

/** "salt:hash" (scrypt, hex) */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await scryptAsync(pin, salt)).toString("hex")}`;
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = await scryptAsync(pin, Buffer.from(salt, "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class PinGuard {
  private state: PinGuardState;

  constructor(
    initial: PinGuardState | undefined,
    private readonly persist: (s: PinGuardState) => void,
    private readonly limits: PinLimits = DEFAULT_PIN_LIMITS,
    private readonly now: () => number = Date.now,
  ) {
    this.state = initial ? { failures: [...initial.failures], lockedUntil: { ...initial.lockedUntil } } : emptyPinGuardState();
  }

  /** Remaining lock time for a caller in ms (0 = may try). */
  lockedFor(caller: string): number {
    const t = this.now();
    return Math.max(0, (this.state.lockedUntil[caller] ?? 0) - t, (this.state.lockedUntil[GLOBAL] ?? 0) - t);
  }

  /** Checks a PIN unless the caller is locked; failures count across calls. */
  async check(caller: string, verify: () => Promise<boolean>): Promise<PinResult> {
    if (this.lockedFor(caller) > 0) return "locked";
    if (await verify()) {
      this.state.failures = this.state.failures.filter((f) => f.key !== caller);
      this.save();
      return "ok";
    }
    const t = this.now();
    this.state.failures = this.state.failures.filter((f) => t - f.at < this.limits.windowMs);
    this.state.failures.push({ key: caller, at: t });
    const mine = this.state.failures.filter((f) => f.key === caller).length;
    if (mine >= this.limits.perCaller) this.state.lockedUntil[caller] = t + this.limits.lockMs;
    if (this.state.failures.length >= this.limits.global) this.state.lockedUntil[GLOBAL] = t + this.limits.lockMs;
    this.save();
    const delay = Math.min(this.limits.baseDelayMs * 2 ** (mine - 1), this.limits.maxDelayMs);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return this.lockedFor(caller) > 0 ? "locked" : "wrong";
  }

  reset() {
    this.state = emptyPinGuardState();
    this.save();
  }

  private save() {
    const t = this.now();
    for (const [k, until] of Object.entries(this.state.lockedUntil)) if (until <= t) delete this.state.lockedUntil[k];
    this.persist({ failures: [...this.state.failures], lockedUntil: { ...this.state.lockedUntil } });
  }
}

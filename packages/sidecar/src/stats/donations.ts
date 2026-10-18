import { USAGE_STATS_URL } from "@forge/protocol";

export interface Donated {
  /** euro cents, before Stripe's fees */
  cents: number;
  count: number;
}

/** The service asks Stripe at most every 10 minutes too. */
const CACHE_MS = 10 * 60_000;
/** A failed look is not repeated right away when the dialog opens again. */
const RETRY_MS = 60_000;

/**
 * Donations so far over the support link, from the statistics service (services/stats, GET
 * /api/v1/donations); FORGE itself has no Stripe key. Asked only when someone wants to see them
 * (the heart's dialog, the phone), not on start.
 */
export class DonationsSource {
  private cached: { value: Donated | null; at: number; ok: boolean } | null = null;

  constructor(
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<Donated | null> {
    const c = this.cached;
    if (c && this.now() - c.at < (c.ok ? CACHE_MS : RETRY_MS)) return c.value;
    try {
      const res = await this.fetchFn(`${USAGE_STATS_URL}/api/v1/donations`, { headers: { "User-Agent": "FORGE" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { donations?: { cents?: unknown; count?: unknown } | null };
      const d = body.donations;
      const value = d && Number.isInteger(d.cents) && Number.isInteger(d.count) ? { cents: d.cents as number, count: d.count as number } : null;
      this.cached = { value, at: this.now(), ok: true };
      return value;
    } catch {
      // Offline or the service is down: the dialog leaves the figure out.
      this.cached = { value: c?.value ?? null, at: this.now(), ok: false };
      return this.cached.value;
    }
  }
}

/** Stripe id of the "Unterstützen" link (DONATE_URL in constants.ts); its payments are the donations. */
export const DONATE_LINK_ID = "plink_1URfBBPw4QqplHqjIO592fZr";
const API = "https://api.stripe.com/v1";
const CACHE_MS = 10 * 60_000;
/** 100 sessions per page; 50 pages are 5000 donations. */
const MAX_PAGES = 50;

export type Donations = {
  /** paid amount in euro cents, before Stripe's fees and without refunds taken off */
  cents: number;
  /** number of paid donations */
  count: number;
};

type Session = { amount_total?: number | null; currency?: string | null; payment_status?: string };
type Page<T> = { data: T[]; has_more: boolean };

/** Paid euro amounts only: an open or failed checkout is no donation. */
export function sumDonations(sessions: Session[]): Donations {
  let cents = 0;
  let count = 0;
  for (const s of sessions) {
    if (s.payment_status !== "paid" || s.currency !== "eur" || !s.amount_total) continue;
    cents += s.amount_total;
    count++;
  }
  return { cents, count };
}

async function stripe<T>(path: string, key: string, fetchFn: typeof fetch): Promise<T> {
  const res = await fetchFn(`${API}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Stripe antwortet mit HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Every page of a Stripe list. */
async function all<T extends { id?: string }>(path: string, key: string, fetchFn: typeof fetch): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const page = await stripe<Page<T>>(`${path}${sep}limit=100${after ? `&starting_after=${after}` : ""}`, key, fetchFn);
    out.push(...page.data);
    after = page.data.at(-1)?.id;
    if (!page.has_more || !after) break;
  }
  return out;
}

let cache: { value: Donations; at: number } | null = null;

/** The live site; only it has the Stripe key, so `next dev` asks it for the figure. */
const LIVE_DONATIONS_URL = "https://forge.vanturis.de/api/v1/donations";

async function liveDonations(fetchFn: typeof fetch): Promise<Donations | null> {
  const res = await fetchFn(LIVE_DONATIONS_URL, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) return null;
  return ((await res.json()) as { donations: Donations | null }).donations;
}

/**
 * Donations so far, from Stripe at most every 10 minutes. Null without STRIPE_SECRET_KEY: the page
 * then leaves the figure out. A restricted key with read access to Checkout Sessions is enough.
 * In development without a key the figure comes from the live site.
 */
export async function donations(fetchFn: typeof fetch = fetch): Promise<Donations | null> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return process.env.NODE_ENV === "development" ? liveDonations(fetchFn) : null;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const link = process.env.STRIPE_PAYMENT_LINK?.trim() || DONATE_LINK_ID;
  const sessions = await all<Session & { id: string }>(`/checkout/sessions?payment_link=${encodeURIComponent(link)}&status=complete`, key, fetchFn);
  cache = { value: sumDonations(sessions), at: Date.now() };
  return cache.value;
}

/** For tests: forget the cached sum. */
export function resetDonationsCache() {
  cache = null;
}

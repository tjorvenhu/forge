import { DONATE_URL } from "./constants";

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
type PaymentLink = { id: string; url?: string };

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

/** The id (plink_…) of the donation link: from STRIPE_PAYMENT_LINK, else looked up by its address. */
async function paymentLinkId(key: string, fetchFn: typeof fetch): Promise<string> {
  const given = process.env.STRIPE_PAYMENT_LINK?.trim();
  if (given) return given;
  const links = await all<PaymentLink>("/payment_links", key, fetchFn);
  const link = links.find((l) => l.url === DONATE_URL);
  if (!link) throw new Error("Zahlungslink zum Spenden nicht im Stripe-Konto gefunden");
  return link.id;
}

let cache: { value: Donations; at: number } | null = null;

/**
 * Donations so far, from Stripe at most every 10 minutes. Null without STRIPE_SECRET_KEY: the page
 * then leaves the figure out. A restricted key with read access to Checkout Sessions and Payment Links
 * is enough.
 */
export async function donations(fetchFn: typeof fetch = fetch): Promise<Donations | null> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const link = await paymentLinkId(key, fetchFn);
  const sessions = await all<Session & { id: string }>(`/checkout/sessions?payment_link=${encodeURIComponent(link)}&status=complete`, key, fetchFn);
  cache = { value: sumDonations(sessions), at: Date.now() };
  return cache.value;
}

/** For tests: forget the cached sum. */
export function resetDonationsCache() {
  cache = null;
}

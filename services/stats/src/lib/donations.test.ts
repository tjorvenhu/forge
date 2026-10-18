import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DONATE_URL } from "./constants";
import { donations, resetDonationsCache, sumDonations } from "./donations";
import { formatEur } from "./format";

describe("donations", () => {
  const env = { key: process.env.STRIPE_SECRET_KEY, link: process.env.STRIPE_PAYMENT_LINK };
  beforeEach(() => {
    resetDonationsCache();
    delete process.env.STRIPE_PAYMENT_LINK;
  });
  afterEach(() => {
    if (env.key === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = env.key;
    if (env.link !== undefined) process.env.STRIPE_PAYMENT_LINK = env.link;
  });

  it("counts only paid euro checkouts", () => {
    expect(
      sumDonations([
        { amount_total: 500, currency: "eur", payment_status: "paid" },
        { amount_total: 1250, currency: "eur", payment_status: "paid" },
        { amount_total: 900, currency: "eur", payment_status: "unpaid" },
        { amount_total: 700, currency: "usd", payment_status: "paid" },
        { amount_total: null, currency: "eur", payment_status: "paid" },
      ]),
    ).toEqual({ cents: 1750, count: 2 });
  });

  it("is left out without a Stripe key", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(await donations(() => Promise.reject(new Error("kein Aufruf erwartet")))).toBeNull();
  });

  it("finds the link by its address and reads every page of its checkouts", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_x";
    const calls: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer rk_test_x");
      if (u.includes("/payment_links")) return json({ data: [{ id: "plink_anders", url: "https://buy.stripe.com/x" }, { id: "plink_spende", url: DONATE_URL }], has_more: false });
      if (!u.includes("starting_after")) return json({ data: [{ id: "cs_1", amount_total: 1000, currency: "eur", payment_status: "paid" }], has_more: true });
      return json({ data: [{ id: "cs_2", amount_total: 550, currency: "eur", payment_status: "paid" }], has_more: false });
    }) as typeof fetch;
    expect(await donations(fake)).toEqual({ cents: 1550, count: 2 });
    expect(calls[1]).toContain("payment_link=plink_spende");
    expect(calls[1]).toContain("status=complete");
    expect(calls[2]).toContain("starting_after=cs_1");
    // cached: no second round to Stripe
    await donations(fake);
    expect(calls).toHaveLength(3);
  });

  it("formats euros the way the page shows them", () => {
    expect(formatEur(2500)).toBe("25 €");
    expect(formatEur(1250)).toBe("12,50 €");
    expect(formatEur(123_456)).toBe("1.235 €");
  });
});

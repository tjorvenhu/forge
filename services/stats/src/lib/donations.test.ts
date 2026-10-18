import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DONATE_LINK_ID, donations, resetDonationsCache, sumDonations } from "./donations";
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

  it("reads every page of the donation link's checkouts", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_x";
    const calls: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer rk_test_x");
      if (!u.includes("starting_after")) return json({ data: [{ id: "cs_1", amount_total: 1000, currency: "eur", payment_status: "paid" }], has_more: true });
      return json({ data: [{ id: "cs_2", amount_total: 550, currency: "eur", payment_status: "paid" }], has_more: false });
    }) as typeof fetch;
    expect(await donations(fake)).toEqual({ cents: 1550, count: 2 });
    expect(calls[0]).toContain(`payment_link=${DONATE_LINK_ID}`);
    expect(calls[0]).toContain("status=complete");
    expect(calls[1]).toContain("starting_after=cs_1");
    // cached: no second round to Stripe
    await donations(fake);
    expect(calls).toHaveLength(2);
  });

  it("takes another link from STRIPE_PAYMENT_LINK", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_x";
    process.env.STRIPE_PAYMENT_LINK = "plink_anders";
    let seen = "";
    const fake = (async (url: string | URL | Request) => {
      seen = String(url);
      return new Response(JSON.stringify({ data: [], has_more: false }));
    }) as typeof fetch;
    expect(await donations(fake)).toEqual({ cents: 0, count: 0 });
    expect(seen).toContain("payment_link=plink_anders");
  });

  it("formats euros the way the page shows them", () => {
    expect(formatEur(2500)).toBe("25 €");
    expect(formatEur(1250)).toBe("12,50 €");
    expect(formatEur(123_456)).toBe("1.235 €");
  });
});

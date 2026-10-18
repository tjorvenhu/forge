import { describe, expect, it } from "vitest";
import { DonationsSource } from "../src/stats/donations.js";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("donations from the statistics service", () => {
  it("reads the sum, keeps it for a while and stays quiet when the service fails", async () => {
    let now = 0;
    const answers: Array<() => Response> = [() => reply({ donations: { cents: 4250, count: 3 } }), () => reply({ error: "stripe unavailable" }, 503), () => reply({ donations: null })];
    const urls: string[] = [];
    const source = new DonationsSource(
      (async (url: string | URL | Request) => {
        urls.push(String(url));
        return answers.shift()!();
      }) as typeof fetch,
      () => now,
    );
    expect(await source.get()).toEqual({ cents: 4250, count: 3 });
    expect(urls[0]).toBe("https://forge-stats.vanturis.de/api/v1/donations");
    now += 5 * 60_000;
    expect(await source.get()).toEqual({ cents: 4250, count: 3 });
    expect(urls).toHaveLength(1);
    // After 10 minutes it asks again; a failure keeps the last known sum.
    now += 6 * 60_000;
    expect(await source.get()).toEqual({ cents: 4250, count: 3 });
    now += 2 * 60_000;
    expect(await source.get()).toBeNull();
    expect(urls).toHaveLength(3);
  });

  it("is null offline", async () => {
    const source = new DonationsSource((async () => {
      throw new Error("offline");
    }) as typeof fetch);
    expect(await source.get()).toBeNull();
  });
});

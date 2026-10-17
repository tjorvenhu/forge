import { describe, expect, it } from "vitest";
import { clientIp, hashIp, NewInstallLimiter } from "./new-install-limiter";

describe("NewInstallLimiter", () => {
  it("allows 20 new IDs per IP and day, then refuses", () => {
    const limiter = new NewInstallLimiter(20, () => Date.parse("2026-10-17T12:00:00Z"));
    for (let i = 0; i < 20; i++) expect(limiter.tryAdd("ip-a", `id-${i}`)).toBe(true);
    expect(limiter.tryAdd("ip-a", "id-20")).toBe(false);
    // known IDs and other IPs are unaffected
    expect(limiter.tryAdd("ip-a", "id-3")).toBe(true);
    expect(limiter.tryAdd("ip-b", "id-20")).toBe(true);
  });

  it("starts over on the next UTC day", () => {
    let now = Date.parse("2026-10-17T23:59:00Z");
    const limiter = new NewInstallLimiter(1, () => now);
    expect(limiter.tryAdd("ip", "a")).toBe(true);
    expect(limiter.tryAdd("ip", "b")).toBe(false);
    now = Date.parse("2026-10-18T00:01:00Z");
    expect(limiter.tryAdd("ip", "b")).toBe(true);
  });
});

describe("clientIp / hashIp", () => {
  it("prefers CF-Connecting-Ip, then X-Real-Ip, then the last X-Forwarded-For entry", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": "8.8.4.4", "x-real-ip": "104.21.7.72" }))).toBe("8.8.4.4");
    expect(clientIp(new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 5.6.7.8" }))).toBe("5.6.7.8");
    expect(clientIp(new Headers())).toBe("unknown");
  });

  it("hashes deterministically within the process and never returns the address", () => {
    expect(hashIp("1.2.3.4")).toBe(hashIp("1.2.3.4"));
    expect(hashIp("1.2.3.4")).not.toBe(hashIp("1.2.3.5"));
    expect(hashIp("1.2.3.4")).not.toContain("1.2.3.4");
  });
});

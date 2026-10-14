import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PlanUsage } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { USAGE_INTERVAL_MS, usageOutdated, usageRefetchIn } from "./rate-limit";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn<(method: string) => Promise<unknown>>();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: [string]) => callMock(...a), subscribe: () => () => {} } }));

const { useUsage } = await import("./queries");

const T0 = Date.parse("2026-10-14T10:00:00Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

function usage(fiveHour: number, resetsAt: string | null, fetchedAt = at(0)): PlanUsage {
  return {
    available: true,
    subscriptionType: "max",
    windows: [
      { key: "five_hour", label: "5 Stunden", utilization: fiveHour, resetsAt },
      { key: "seven_day", label: "Woche", utilization: 40, resetsAt: at(3 * 24 * 3_600_000) },
    ],
    fetchedAt,
    error: null,
  };
}

describe("usage refresh timing", () => {
  it("reads shortly after the next reset, else at the regular interval", () => {
    expect(usageRefetchIn(usage(90, at(60_000)), T0)).toBe(70_000);
    expect(usageRefetchIn(usage(90, at(60 * 60_000)), T0)).toBe(USAGE_INTERVAL_MS);
    // A reset time in the past does not cause a tight loop.
    expect(usageRefetchIn(usage(0, at(-60_000)), T0)).toBe(USAGE_INTERVAL_MS);
    expect(usageRefetchIn(undefined, T0)).toBe(USAGE_INTERVAL_MS);
  });

  it("calls the usage outdated after a reset or a missed regular read", () => {
    expect(usageOutdated(usage(90, at(60_000)), T0 + 30_000)).toBe(false);
    expect(usageOutdated(usage(90, at(60_000)), T0 + 61_000)).toBe(true);
    expect(usageOutdated(usage(0, at(-60_000)), T0 + 61_000)).toBe(false);
    expect(usageOutdated(usage(0, null), T0 + USAGE_INTERVAL_MS)).toBe(true);
  });
});

describe("useUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    callMock.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the reset window by itself once its reset time has passed", async () => {
    callMock.mockResolvedValueOnce(usage(92, at(60_000))).mockResolvedValueOnce(usage(0, at(5 * 3_600_000), at(70_000)));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useUsage(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current.data?.windows[0]?.utilization).toBe(92);

    await act(() => vi.advanceTimersByTimeAsync(65_000));
    expect(callMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(callMock).toHaveBeenCalledTimes(2);
    expect(result.current.data?.windows[0]?.utilization).toBe(0);

    // Afterwards back to the regular interval, not a read every few seconds.
    await act(() => vi.advanceTimersByTimeAsync(USAGE_INTERVAL_MS - 10_000));
    expect(callMock).toHaveBeenCalledTimes(2);
  });
});

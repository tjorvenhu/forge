import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { RateLimitState } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { keys } from "@/lib/queries";
import { limitTime } from "@/lib/rate-limit";
import { routeServerEvent, createGitRefresher } from "@/lib/server-events";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { RateLimitBadge } = await import("./RateLimitBadge");

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const RESET = new Date(NOW + 30 * 60_000).toISOString();
const warning: RateLimitState = { status: "warning", limitType: "five_hour", resetsAt: RESET, utilization: 91, updatedAt: new Date(NOW).toISOString() };

function setup(state: RateLimitState, autoContinueAt: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(keys.rateLimit, state);
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RateLimitBadge autoContinueAt={autoContinueAt} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  callMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RateLimitBadge", () => {
  it("stays visible with the reset time while the limit is close, and goes once it has reset", async () => {
    setup(warning);
    expect(screen.getByRole("status").textContent).toContain(`Limit fast erreicht · Reset ${limitTime(RESET)}`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30 * 60_000 + 2000);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("disappears when Claude Code reports the limit as fine again", async () => {
    const qc = setup(warning);
    expect(screen.getByRole("status")).toBeTruthy();
    routeServerEvent(qc, createGitRefresher(qc), { event: "ratelimit.updated", payload: { status: "ok", limitType: null, resetsAt: null, utilization: null, updatedAt: new Date().toISOString() } });
    // React Query hands cache updates to components on a timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows when work goes on once the limit is reached", () => {
    const due = new Date(Date.parse(RESET) + 2 * 60_000).toISOString();
    setup({ ...warning, status: "reached" }, due);
    expect(screen.getByRole("status").textContent).toContain(`Limit erreicht · weiter um ${limitTime(due)}`);
  });

  it("shows nothing while the limit is fine", () => {
    setup({ status: "ok", limitType: null, resetsAt: null, utilization: null, updatedAt: null });
    expect(screen.queryByRole("status")).toBeNull();
  });
});

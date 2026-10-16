import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { PlanUsage, UsageWindow } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { forecastLabel, forecastSentence, windowsRunningOut } from "@/lib/usage-forecast";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn<(method: string, params?: unknown) => Promise<unknown>>();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: [string, unknown]) => callMock(...a), subscribe: () => () => {} } }));

const { UsageSettings } = await import("@/components/settings/UsageSettings");
const { LimitForecastWarning } = await import("./UsageWindows");

const HOUR = 3_600_000;
const NOW = Date.now();
const at = (ms: number) => new Date(NOW + ms).toISOString();

const fiveHour: UsageWindow = { key: "five_hour", label: "5 Stunden", utilization: 60, resetsAt: at(2 * HOUR), forecast: { outcome: "limit", limitAt: at(HOUR), perHour: 40 } };
const week: UsageWindow = { key: "seven_day", label: "Woche", utilization: 20, resetsAt: at(72 * HOUR), forecast: { outcome: "enough", limitAt: null, perHour: 0.3 } };
const opus: UsageWindow = { key: "model:Opus", label: "Woche Opus", utilization: 5, resetsAt: at(72 * HOUR) };

function usage(windows: UsageWindow[]): PlanUsage {
  return { available: true, subscriptionType: "max", windows, fetchedAt: new Date(NOW).toISOString(), error: null };
}

function renderWith(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
});

describe("forecast texts", () => {
  it("says when the limit comes, that it lasts, or that there is no forecast", () => {
    expect(forecastLabel(fiveHour, NOW)).toEqual({ text: expect.stringMatching(/^Limit gegen \d\d:\d\d$|^Limit gegen .+, \d\d:\d\d$/), limit: true });
    expect(forecastLabel(week, NOW)).toEqual({ text: "Reicht bis zum Reset", limit: false });
    expect(forecastLabel(opus, NOW)).toBeNull();
    // After the reset the old forecast no longer applies.
    expect(forecastLabel(fiveHour, NOW + 3 * HOUR)).toBeNull();
    expect(forecastSentence(fiveHour, NOW)).toMatch(/^Bei diesem Tempo ist das Limit gegen .*\d\d:\d\d erreicht, vor dem Reset\.$/);
    expect(forecastSentence(week, NOW)).toBe("Bei diesem Tempo reicht es bis zum Reset.");
    expect(forecastSentence(opus, NOW)).toBe("Keine Prognose: zu wenig Messwerte oder kein Anstieg.");
    expect(windowsRunningOut(usage([fiveHour, week, opus]), NOW)).toEqual([fiveHour]);
    expect(windowsRunningOut({ ...usage([fiveHour]), available: false }, NOW)).toEqual([]);
    expect(windowsRunningOut(undefined, NOW)).toEqual([]);
  });
});

describe("UsageSettings", () => {
  it("shows a skeleton, then every window with its forecast, and reads the usage again on request", async () => {
    let resolve: (u: PlanUsage) => void = () => {};
    callMock.mockImplementation((method, params) => {
      if (method !== "system.usage") throw new Error(`unexpected ${method}`);
      if ((params as { refresh?: boolean }).refresh) return Promise.resolve(usage([{ ...fiveHour, utilization: 70 }, week, opus]));
      return new Promise<PlanUsage>((r) => (resolve = r));
    });
    renderWith(<UsageSettings />);
    expect(screen.getByRole("status", { name: "Lädt Nutzung" })).toBeTruthy();
    await act(async () => resolve(usage([fiveHour, week, opus])));
    expect(await screen.findByText("60 % genutzt")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Lädt Nutzung" })).toBeNull();
    expect(screen.getByText(/^Bei diesem Tempo ist das Limit gegen .+ erreicht, vor dem Reset\.$/).className).toContain("text-warning");
    expect(screen.getByText("Bei diesem Tempo reicht es bis zum Reset.")).toBeTruthy();
    expect(screen.getByText("Keine Prognose: zu wenig Messwerte oder kein Anstieg.")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" })));
    expect(callMock).toHaveBeenCalledWith("system.usage", { refresh: true });
    expect(await screen.findByText("70 % genutzt")).toBeTruthy();
  });

  it("says why there are no numbers", async () => {
    callMock.mockResolvedValue({ available: false, subscriptionType: null, windows: [], fetchedAt: new Date(NOW).toISOString(), error: "Claude Code nicht gefunden" });
    renderWith(<UsageSettings />);
    expect(await screen.findByText("Claude Code nicht gefunden")).toBeTruthy();
  });
});

describe("LimitForecastWarning", () => {
  it("warns only when a window runs full before its reset", async () => {
    callMock.mockResolvedValue(usage([fiveHour, week]));
    renderWith(<LimitForecastWarning />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Bei diesem Tempo ist das Limit vor dem Reset erreicht\./);
    expect(alert.textContent).toMatch(/5 Stunden: Limit gegen .+, Reset .+\. Ein weiterer Agent verbraucht es schneller\./);
    expect(alert.textContent).not.toMatch(/Woche/);
    cleanup();

    callMock.mockResolvedValue(usage([week, opus]));
    renderWith(<LimitForecastWarning />);
    await act(async () => {});
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

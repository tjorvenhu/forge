import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { AppUpdateState } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { AppUpdateDialog } = await import("./AppUpdate");
const { useDictationActivity } = await import("@/stores/dictation");

const available: AppUpdateState = {
  currentVersion: "0.1.90",
  phase: "available",
  latest: { version: "0.1.91", tag: "v0.1.91", notes: "- Neu", since: "0.1.90", publishedAt: null, size: 4 * 1048576, kind: "patch", via: null, channelSwitch: false },
  autoInstall: false,
  installerPath: null,
  installable: true,
  checkedAt: null,
  message: null,
  channel: "stable",
};

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <AppUpdateDialog />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useDictationActivity.setState({ active: 0 });
  callMock.mockReset();
  callMock.mockImplementation(async (method: string) => {
    if (method === "app.updateState") return available;
    if (method === "settings.get") return { setupDone: true };
    if (method === "sessions.listLive") return [];
    if (method === "app.changelog") return null;
    return null;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("update offer and dictation", () => {
  it("waits until a running dictation is over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const release = useDictationActivity.getState().hold();
    setup();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.queryByText("FORGE 0.1.91 ist verfügbar")).toBeNull();

    act(() => release());
    // Not the moment the text lands: a short pause first.
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.queryByText("FORGE 0.1.91 ist verfügbar")).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText("FORGE 0.1.91 ist verfügbar")).toBeTruthy();
  });

  it("shows at once without a dictation", async () => {
    setup();
    expect(await screen.findByText("FORGE 0.1.91 ist verfügbar")).toBeTruthy();
    expect(screen.queryByText("Vorabversion aus dem Branch dev")).toBeNull();
  });

  it("marks an update from the dev branch as a development build", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "app.updateState") return { ...available, channel: "dev" };
      if (method === "settings.get") return { setupDone: true };
      if (method === "sessions.listLive") return [];
      return null;
    });
    setup();
    expect(await screen.findByText("Entwicklungsversion 0.1.91 ist verfügbar")).toBeTruthy();
    expect(screen.getByText("Vorabversion aus dem Branch dev")).toBeTruthy();
    expect(screen.getByText("Entwicklungsversion installieren")).toBeTruthy();
  });

  it("explains the way back to main instead of listing main's changes", async () => {
    const back: AppUpdateState = { ...available, currentVersion: "0.1.92-dev", latest: { ...available.latest!, since: "0.1.92-dev", channelSwitch: true } };
    callMock.mockImplementation(async (method: string) => {
      if (method === "app.updateState") return back;
      if (method === "settings.get") return { setupDone: true };
      if (method === "sessions.listLive") return [];
      return null;
    });
    setup();
    expect(await screen.findByText("Zurück zur stabilen Version 0.1.91")).toBeTruthy();
    expect(screen.getByText("Entwicklungsversion ausgeschaltet")).toBeTruthy();
    expect(screen.getByText("Stabile Version installieren")).toBeTruthy();
    expect(screen.queryByText("- Neu")).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("app.changelog", expect.anything());
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { SyncStatus } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { SyncButton, syncLook } = await import("./SyncButton");
const { useUi } = await import("@/stores/ui");

const base: SyncStatus = {
  enabled: true,
  phase: "idle",
  account: "me",
  repo: "me/forge-data",
  lastSyncAt: new Date(Date.now() - 120_000).toISOString(),
  error: null,
  remote: { updatedAt: new Date(Date.now() - 120_000).toISOString(), device: "PC-A" },
  available: [{ key: "github.com/me/shop", name: "shop", cloneUrl: null }],
  localOnly: [],
  hasKey: true,
  pending: false,
};
let syncEnabled = true;

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <SyncButton />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  syncEnabled = true;
  callMock.mockImplementation(async (method: string) => (method === "settings.get" ? { syncEnabled } : method === "sync.status" ? { ...base, enabled: syncEnabled, phase: syncEnabled ? "idle" : "off" } : null));
});
afterEach(cleanup);

describe("sync cloud in the header", () => {
  it("is only there while the sync is on", async () => {
    syncEnabled = false;
    setup();
    await waitFor(() => expect(callMock.mock.calls.some(([m]) => m === "sync.status")).toBe(true));
    expect(screen.queryByRole("button", { name: /GitHub-Synchronisierung/ })).toBeNull();
  });

  it("tells in its tooltip when it last synced and opens the GitHub settings", async () => {
    setup();
    const button = await screen.findByRole("button", { name: "GitHub-Synchronisierung: Alles aktuell" });
    fireEvent.focus(button);
    expect((await screen.findAllByText("Zuletzt abgeglichen")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/PC-A, vor 2 Min/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 Projekt zum Holen").length).toBeGreaterThan(0);
    fireEvent.click(button);
    expect(useUi.getState()).toMatchObject({ view: "settings", settingsSection: "github" });
  });

  it("shows what needs attention", () => {
    expect(syncLook({ ...base, pending: true }).title).toBe("Änderungen werden gleich hochgeladen");
    expect(syncLook({ ...base, phase: "syncing" }).tone).toBe("busy");
    expect(syncLook({ ...base, phase: "error", error: "offline" })).toMatchObject({ tone: "bad", title: "Abgleich fehlgeschlagen" });
    expect(syncLook({ ...base, phase: "needs-passphrase" })).toMatchObject({ tone: "warn", title: "Sync-Passwort nötig" });
  });
});

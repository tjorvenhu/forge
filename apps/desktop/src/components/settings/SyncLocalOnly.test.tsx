import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { SyncStatus } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { LocalOnlyBanner } = await import("./SyncLocalOnly");

const status: SyncStatus = {
  enabled: true,
  phase: "idle",
  account: "me",
  repo: "me/forge-data",
  lastSyncAt: null,
  error: null,
  remote: null,
  available: [],
  localOnly: [{ key: "project:github.com/me/shop", kind: "project", label: "Projekt shop", projectId: "p-shop" }],
  hasKey: true,
};
const calls = (method: string) => callMock.mock.calls.filter(([m]) => m === method).map(([, p]) => p as Record<string, unknown>);

function setup(projectId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <LocalOnlyBanner projectId={projectId} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  callMock.mockImplementation(async (method: string) => (method === "sync.status" || method === "sync.keep" || method === "sync.forceLocal" ? status : null));
});
afterEach(cleanup);

describe("project only on this computer", () => {
  it("shows the notice only for projects another computer removed", async () => {
    setup("p-other");
    await waitFor(() => expect(calls("sync.status")).toHaveLength(1));
    expect(screen.queryByText("Nur auf diesem PC")).toBeNull();
  });

  it("syncs it again or sets it to GitHub after asking", async () => {
    setup("p-shop");
    expect(await screen.findByText("Nur auf diesem PC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Wieder abgleichen/ }));
    await waitFor(() => expect(calls("sync.keep")).toEqual([{ key: "project:github.com/me/shop" }]));

    fireEvent.click(screen.getByRole("button", { name: /Auf GitHub-Stand setzen/ }));
    expect(await screen.findByText(/Der Ordner mit den Dateien bleibt/)).toBeTruthy();
    expect(calls("sync.forceLocal")).toEqual([]);
    const buttons = screen.getAllByRole("button", { name: "Auf GitHub-Stand setzen" });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(calls("sync.forceLocal")).toEqual([{ key: "project:github.com/me/shop" }]));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { MemoryEditor } = await import("./MemoryEditor");
const { useToasts } = await import("@/stores/toast");

const writes = () => callMock.mock.calls.filter(([m]) => m === "config.memoryWrite").map(([, p]) => p as Record<string, unknown>);

beforeEach(() => {
  callMock.mockReset();
  useToasts.setState({ toasts: [] });
  callMock.mockImplementation(async (method: string) => {
    if (method === "config.memoryList") return [{ scope: "global", label: "Global", path: "C:\\Users\\x\\.claude\\CLAUDE.md", exists: false }];
    if (method === "config.memoryRead") return { content: "", mtimeMs: null };
    if (method === "config.memoryWrite") return { path: "C:\\Users\\x\\.claude\\CLAUDE.md", mtimeMs: 2 };
    return [];
  });
});
afterEach(cleanup);

describe("CLAUDE.md editor", () => {
  it("saves by itself a moment after a change, without a save button", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <MemoryEditor scopes={["global"]} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Anlegen/ }));
    expect(screen.queryByRole("button", { name: /Speichern/ })).toBeNull();
    expect(writes()).toEqual([]);
    await waitFor(() => expect(writes()).toHaveLength(1), { timeout: 3000 });
    expect(writes()[0]).toMatchObject({ scope: "global", content: expect.stringContaining("# Globale Regeln"), expectedMtimeMs: null });
    await waitFor(() => expect(useToasts.getState().toasts[0]).toMatchObject({ title: "Automatisch gespeichert" }));
    // Saved once: the stored text is the draft now, no second write and no "changed outside" warning.
    await new Promise((r) => setTimeout(r, 1300));
    expect(writes()).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

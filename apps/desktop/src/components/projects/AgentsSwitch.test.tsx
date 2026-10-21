import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as RpcModuleNs from "@/lib/rpc";
import { useAgentsSwitch } from "@/stores/agents-switch";
import { useToasts } from "@/stores/toast";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { AgentsOffDialog, switchProjectAgents } = await import("./AgentsSwitch");

const shop = { id: "shop", name: "Shop" };

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentsOffDialog />
    </QueryClientProvider>,
  );
  return qc;
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
  useAgentsSwitch.setState({ confirm: null });
  useToasts.setState({ toasts: [] });
  callMock.mockImplementation(async (method: string) => {
    if (method === "projects.list") return [{ id: "wt", parentId: "shop" }];
    if (method === "projects.update") return {};
    throw new Error("unexpected " + method);
  });
});

describe("AgentsSwitch", () => {
  it("asks with a warning before switching parallel agents off and saves only after the confirmation", async () => {
    const qc = setup();
    act(() => switchProjectAgents(qc, shop, false));
    expect(screen.getByText("Parallele Agenten ausschalten?")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/weniger effizient.*nacheinander statt gleichzeitig/);
    expect(await screen.findByText(/Der bestehende Agent läuft weiter/)).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith("projects.update", expect.anything());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Agenten ausschalten" }));
    });
    expect(callMock).toHaveBeenCalledWith("projects.update", { projectId: "shop", agentsEnabled: false });
    expect(useAgentsSwitch.getState().confirm).toBeNull();
    expect(useToasts.getState().toasts.at(-1)?.title).toBe("Parallele Agenten ausgeschaltet");
  });

  it("closes without saving on cancel and allows agents again without asking", async () => {
    const qc = setup();
    act(() => switchProjectAgents(qc, shop, false));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(useAgentsSwitch.getState().confirm).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("projects.update", expect.anything());

    await act(async () => switchProjectAgents(qc, shop, true));
    expect(callMock).toHaveBeenCalledWith("projects.update", { projectId: "shop", agentsEnabled: true });
    expect(screen.queryByText("Parallele Agenten ausschalten?")).toBeNull();
  });
});

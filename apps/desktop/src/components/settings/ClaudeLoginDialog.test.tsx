import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClaudeSetupState, Settings } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
const openExternal = vi.fn(async () => {});
vi.mock("@/lib/native", () => ({ openExternal: (...a: unknown[]) => openExternal(...(a as [])) }));

const { ClaudeLoginDialog } = await import("./ClaudeLoginDialog");
const { useUi } = await import("@/stores/ui");
const { keys } = await import("@/lib/queries");

const IDLE: ClaudeSetupState = { task: null, phase: "idle", url: null, log: [], message: null };
const WAITING: ClaudeSetupState = { task: "login", phase: "waiting_code", url: "https://claude.ai/oauth/authorize?x=1", log: [], message: null };
let setupState: ClaudeSetupState;
let setupDone: boolean;
let qc: QueryClient;
const calls = (method: string) => callMock.mock.calls.filter(([m]) => m === method).map(([, p]) => p as Record<string, unknown>);

function setup() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClaudeLoginDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  openExternal.mockClear();
  setupState = IDLE;
  setupDone = true;
  useUi.setState({ claudeLogin: null, setupWizard: false });
  callMock.mockImplementation(async (method: string) => {
    if (method === "settings.get") return { setupDone } as Settings;
    if (method === "claude.setupState") return setupState;
    if (method === "claude.login") return (setupState = WAITING);
    if (method === "claude.submitLoginCode") return (setupState = { ...WAITING, phase: "running" });
    if (method === "claude.cancelSetup") return (setupState = { ...setupState, phase: "cancelled" });
    throw new Error(`unexpected ${method}`);
  });
});

afterEach(cleanup);

describe("ClaudeLoginDialog", () => {
  it("signs in again after an expired login and confirms it", async () => {
    setup();
    act(() => useUi.getState().openClaudeLogin("expired"));
    expect(await screen.findByText("Claude-Anmeldung abgelaufen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Mit Claude-Konto anmelden/ }));
    const input = await screen.findByPlaceholderText("Code von der Anmeldeseite");
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(WAITING.url));
    fireEvent.change(input, { target: { value: " abc#123 " } });
    fireEvent.click(screen.getByRole("button", { name: "Bestätigen" }));
    await waitFor(() => expect(calls("claude.submitLoginCode")).toEqual([{ code: " abc#123 " }]));
    act(() => qc.setQueryData(keys.claudeSetup, { ...WAITING, url: null, phase: "done", message: "Angemeldet" }));
    expect(await screen.findByText(/Du bist wieder angemeldet/)).toBeTruthy();
    // the last one is the footer button, the first the X in the header
    fireEvent.click(screen.getAllByRole("button", { name: "Schließen" }).at(-1)!);
    expect(useUi.getState().claudeLogin).toBeNull();
  });

  it("does not show an earlier sign-in as this dialog's result", async () => {
    setupState = { task: "login", phase: "done", url: null, log: [], message: "Angemeldet" };
    setup();
    act(() => useUi.getState().openClaudeLogin("manual"));
    expect(await screen.findByRole("button", { name: /Mit Claude-Konto anmelden/ })).toBeTruthy();
    expect(screen.queryByText(/Du bist wieder angemeldet/)).toBeNull();
  });

  it("cancels a running sign-in when it is closed", async () => {
    setup();
    act(() => useUi.getState().openClaudeLogin("expired"));
    fireEvent.click(await screen.findByRole("button", { name: /Mit Claude-Konto anmelden/ }));
    await screen.findByPlaceholderText("Code von der Anmeldeseite");
    fireEvent.click(screen.getByRole("button", { name: "Später" }));
    await waitFor(() => expect(calls("claude.cancelSetup")).toHaveLength(1));
    expect(useUi.getState().claudeLogin).toBeNull();
  });

  it("keeps out of the way of the setup assistant", async () => {
    setupDone = false;
    setup();
    act(() => useUi.getState().openClaudeLogin("expired"));
    await waitFor(() => expect(calls("settings.get")).toHaveLength(1));
    expect(screen.queryByText("Claude-Anmeldung abgelaufen")).toBeNull();
  });
});

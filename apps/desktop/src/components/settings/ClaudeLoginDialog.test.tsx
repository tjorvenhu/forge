import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ClaudeSetupState, Diagnostics, Settings } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
const openExternal = vi.fn(async () => {});
vi.mock("@/lib/native", () => ({ openExternal: (...a: unknown[]) => openExternal(...(a as [])) }));

const { ClaudeLoginDialog, ClaudeLogoutDialog, claudeAccountItems } = await import("./ClaudeLoginDialog");
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
  useUi.setState({ claudeLogin: null, claudeLogout: false, setupWizard: false });
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

  it("switches accounts, also over the setup assistant", async () => {
    setupDone = false;
    setup();
    act(() => useUi.getState().openClaudeLogin("switch"));
    expect(await screen.findByText("Claude-Konto wechseln")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Mit Claude-Konto anmelden/ }));
    await screen.findByPlaceholderText("Code von der Anmeldeseite");
    act(() => qc.setQueryData(keys.claudeSetup, { ...WAITING, url: null, phase: "done", message: "Angemeldet" }));
    expect(await screen.findByText(/nutzt jetzt das neue Konto/)).toBeTruthy();
  });

  it("keeps out of the way of the setup assistant", async () => {
    setupDone = false;
    setup();
    act(() => useUi.getState().openClaudeLogin("expired"));
    await waitFor(() => expect(calls("settings.get")).toHaveLength(1));
    expect(screen.queryByText("Claude-Anmeldung abgelaufen")).toBeNull();
  });
});

describe("ClaudeLogoutDialog", () => {
  function renderLogout() {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <ClaudeLogoutDialog />
      </QueryClientProvider>,
    );
  }

  it("signs out only after the confirmation and refreshes the sign-in state", async () => {
    const loggedOut = { claude: { found: true }, auth: { loggedIn: false } };
    callMock.mockImplementation(async (method: string) => {
      if (method === "claude.logout") return IDLE;
      if (method === "system.diagnostics") return loggedOut;
      throw new Error(`unexpected ${method}`);
    });
    renderLogout();
    act(() => useUi.getState().setClaudeLogout(true));
    expect(await screen.findByText("Von Claude abmelden?")).toBeTruthy();
    expect(calls("claude.logout")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    await waitFor(() => expect(useUi.getState().claudeLogout).toBe(false));
    expect(calls("claude.logout")).toHaveLength(1);
    expect(calls("system.diagnostics")).toEqual([{ refresh: true }]);
    expect(qc.getQueryData(keys.diagnostics)).toBe(loggedOut);
  });

  it("stays open when the logout fails", async () => {
    callMock.mockImplementation(async () => {
      throw new Error("keychain locked");
    });
    renderLogout();
    act(() => useUi.getState().setClaudeLogout(true));
    fireEvent.click(await screen.findByRole("button", { name: "Abmelden" }));
    await waitFor(() => expect(calls("claude.logout")).toHaveLength(1));
    expect(useUi.getState().claudeLogout).toBe(true);
  });
});

describe("claudeAccountItems", () => {
  const diag = (found: boolean, loggedIn: boolean) => ({ claude: { found }, auth: { loggedIn } }) as Diagnostics;
  const labels = (d: Diagnostics | undefined) => claudeAccountItems(d, () => {}).map((i) => i.label);

  it("offers switching and signing out when signed in, otherwise signing in", () => {
    expect(labels(diag(true, true))).toEqual(["Konto wechseln", "Abmelden", "Claude-Einstellungen"]);
    expect(labels(diag(true, false))).toEqual(["Anmelden", "Claude-Einstellungen"]);
    expect(labels(diag(false, false))).toEqual(["Claude-Einstellungen"]);
    expect(labels(undefined)).toEqual(["Claude-Einstellungen"]);
  });

  it("opens the matching dialog", () => {
    const [sw, out] = claudeAccountItems(diag(true, true), () => {});
    act(() => sw!.onSelect());
    expect(useUi.getState().claudeLogin?.reason).toBe("switch");
    act(() => out!.onSelect());
    expect(useUi.getState().claudeLogout).toBe(true);
  });
});

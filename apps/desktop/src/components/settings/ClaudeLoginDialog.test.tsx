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
    if (method === "system.diagnostics" && diagnostics) return diagnostics;
    throw new Error(`unexpected ${method}`);
  });
  diagnostics = null;
});

afterEach(cleanup);

let diagnostics: Diagnostics | null = null;
const signedIn = (loggedIn: boolean) => ({ claude: { found: true }, auth: { checked: true, loggedIn } }) as Diagnostics;
const AUTO = "https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A5%2Fcallback";
const MANUAL = "https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

describe("sign-in without a code", () => {
  it("waits for the browser and offers the code only as a fallback", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "settings.get") return { setupDone: true } as Settings;
      if (method === "claude.setupState") return { ...WAITING, url: AUTO, codeUrl: MANUAL };
      throw new Error(`unexpected ${method}`);
    });
    setup();
    act(() => useUi.getState().openClaudeLogin("manual"));
    expect(await screen.findByText(/Warte auf die Anmeldung im Browser/)).toBeTruthy();
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(AUTO));
    expect(screen.queryByPlaceholderText("Code von der Anmeldeseite")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Mit Code anmelden/ }));
    expect(openExternal).toHaveBeenLastCalledWith(MANUAL);
    expect(screen.getByPlaceholderText("Code von der Anmeldeseite")).toBeTruthy();
  });
});

describe("required sign-in", () => {
  it("cannot be closed while Claude Code is signed out and goes away after the sign-in", async () => {
    diagnostics = signedIn(false);
    setup();
    expect(await screen.findByText("Bei Claude anmelden")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Schließen" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Später" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByText("Bei Claude anmelden")).toBeTruthy();
    act(() => qc.setQueryData(keys.diagnostics, signedIn(true)));
    await waitFor(() => expect(screen.queryByText("Bei Claude anmelden")).toBeNull());
  });

  it("replaces an asked-for dialog so it does not come back after the sign-in", async () => {
    diagnostics = signedIn(false);
    setup();
    act(() => useUi.getState().openClaudeLogin("expired"));
    await screen.findByText("Bei Claude anmelden");
    await waitFor(() => expect(useUi.getState().claudeLogin).toBeNull());
    expect(screen.queryByText("Claude-Anmeldung abgelaufen")).toBeNull();
  });

  it("leaves the first sign-in to the setup assistant", async () => {
    diagnostics = signedIn(false);
    setupDone = false;
    setup();
    await waitFor(() => expect(calls("system.diagnostics")).toHaveLength(1));
    expect(screen.queryByText("Bei Claude anmelden")).toBeNull();
  });
});

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

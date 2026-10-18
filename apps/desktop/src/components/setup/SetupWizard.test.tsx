import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { Settings, SyncStatus } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@/lib/native", () => ({ pickFolder: vi.fn(async () => null), openExternal: vi.fn(async () => {}) }));

const { SetupWizard } = await import("./SetupWizard");
const { SyncPrompt } = await import("./SyncPrompt");
const { useUi } = await import("@/stores/ui");
const { useToasts } = await import("@/stores/toast");

let settings: Settings;
let account: unknown;
const status: SyncStatus = {
  enabled: true,
  phase: "idle",
  account: "me",
  repo: "me/forge-data",
  lastSyncAt: "2026-10-13T10:00:00Z",
  error: null,
  remote: { updatedAt: "2026-10-13T10:00:00Z", device: "PC-A" },
  available: [{ key: "github.com/me/shop", name: "shop", cloneUrl: "https://github.com/me/shop.git" }],
  localOnly: [],
  hasKey: false,
  pending: false,
};
const calls = (method: string) => callMock.mock.calls.filter(([m]) => m === method).map(([, p]) => p as Record<string, unknown>);

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <SetupWizard />
        <SyncPrompt />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  useUi.setState({ setupWizard: false, newProject: null });
  settings = {
    claudePath: null,
    defaultModel: null,
    defaultEffort: null,
    defaultProfile: "balanced",
    stripApiKey: true,
    enterToSend: true,
    sounds: true,
    debugLogs: false,
    defaultProjectDir: "C:\\Projekte",
    autoContinueAfterLimit: true,
    idleCloseMinutes: 60,
    longSessionTokens: 200_000,
    updateChecks: true,
    desktopNotifications: true,
    alwaysOnTop: false,
    screenshotKey: true,
    uiCompare: true,
    learnTemplates: true,
    disabledPolicyRules: [],
    setupDone: false,
    syncEnabled: false,
    syncAsked: false,
    usageStats: true,
    usageStatsAsked: true,
    language: "de",
  };
  account = { login: "me", id: 1, name: "Me", avatarUrl: null, profileUrl: "https://github.com/me" };
  callMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "settings.get":
        return settings;
      case "settings.update":
        settings = { ...settings, ...params };
        return settings;
      case "system.diagnostics":
        return { claude: { found: true, version: "2.1.0", error: null }, auth: { checked: true, loggedIn: true, subscriptionType: "max" }, gh: { found: true, authenticated: true } };
      case "claude.setupState":
        return { phase: "idle", task: null, message: null, url: null, log: [] };
      case "github.account":
        return account;
      case "github.loginState":
        return { phase: "idle", code: null, url: null, message: null };
      case "sync.probe":
        return { account: "me", repo: "me/forge-data", found: true, updatedAt: "2026-10-13T10:00:00Z", device: "PC-A", projects: 3, settings: 14 };
      case "sync.status":
        return status;
      case "sync.setPassphrase":
      case "sync.now":
        return { ...status, hasKey: true };
      case "git.identity":
        return { name: "Alt", email: "alt@example.com" };
      case "git.setIdentity":
        return params;
      case "system.runtimeInfo":
        return null;
      default:
        return null;
    }
  });
});
afterEach(cleanup);

describe("setup assistant", () => {
  it("walks through the first start, takes the data of another computer and offers its projects", async () => {
    setup();
    expect(await screen.findByText("FORGE einrichten")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Los" }));
    expect(await screen.findByText("Alles bereit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Weiter/ }));

    // Data of another computer: syncing is preselected.
    expect(await screen.findByText(/liegen schon verschlüsselte FORGE-Daten von PC-A/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Daten über GitHub synchronisieren" }).getAttribute("aria-checked")).toBe("true");
    // Without the password of the data on GitHub it does not go on.
    fireEvent.click(screen.getByRole("button", { name: /Weiter/ }));
    await waitFor(() => expect(useToasts.getState().toasts.map((t) => `${t.title} ${t.body ?? ""}`).join(" ")).toContain("Gib zuerst das Sync-Passwort ein."));
    expect(calls("settings.update")).toEqual([]);
    expect(screen.getByRole("switch", { name: "Daten über GitHub synchronisieren" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Sync-Passwort"), { target: { value: "richtig langes Passwort" } });
    fireEvent.click(screen.getByRole("button", { name: /Weiter/ }));
    await waitFor(() => expect(calls("sync.now")).toHaveLength(1));
    expect(calls("sync.setPassphrase")).toEqual([{ passphrase: "richtig langes Passwort" }]);
    expect(calls("settings.update")).toContainEqual({ syncEnabled: true, syncAsked: true });

    const name = (await screen.findByPlaceholderText("Vorname Nachname")) as HTMLInputElement;
    await waitFor(() => expect(name.value).toBe("Alt"));
    fireEvent.change(name, { target: { value: "Tjorven" } });
    fireEvent.click(screen.getByRole("button", { name: /Weiter/ }));
    await waitFor(() => expect(calls("git.setIdentity")).toEqual([{ name: "Tjorven", email: "alt@example.com" }]));

    expect(await screen.findByText("shop")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Fertig/ }));
    await waitFor(() => expect(calls("settings.update")).toContainEqual({ setupDone: true, syncAsked: true }));
    await waitFor(() => expect(screen.queryByText("FORGE einrichten")).toBeNull());
    // Answered in the assistant: no second question.
    expect(screen.queryByText("FORGE-Daten über GitHub synchronisieren?")).toBeNull();
  });

  it("can be skipped and leaves sync off without GitHub", async () => {
    account = null;
    setup();
    fireEvent.click(await screen.findByRole("button", { name: /Überspringen/ }));
    await waitFor(() => expect(calls("settings.update")).toEqual([{ setupDone: true, syncAsked: true }]));
    expect(calls("sync.now")).toEqual([]);
    // Skipped is answered: the question for older installations does not follow right after.
    await waitFor(() => expect(screen.queryByText("FORGE einrichten")).toBeNull());
    expect(screen.queryByText("FORGE-Daten über GitHub synchronisieren?")).toBeNull();
  });

  it("stays away from installations that were used before and asks them once about syncing", async () => {
    settings = { ...settings, setupDone: true };
    setup();
    expect(await screen.findByText("FORGE-Daten über GitHub synchronisieren?")).toBeTruthy();
    expect(screen.queryByText("FORGE einrichten")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Nein, danke" }));
    await waitFor(() => expect(calls("settings.update")).toEqual([{ syncEnabled: false, syncAsked: true }]));
    await waitFor(() => expect(screen.queryByText("FORGE-Daten über GitHub synchronisieren?")).toBeNull());
  });

  it("switches syncing on from the question", async () => {
    settings = { ...settings, setupDone: true };
    setup();
    await screen.findByText(/liegen schon verschlüsselte FORGE-Daten von PC-A/);
    expect((screen.getByRole("button", { name: "Synchronisieren" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Sync-Passwort"), { target: { value: "richtig langes Passwort" } });
    fireEvent.click(screen.getByRole("button", { name: "Synchronisieren" }));
    await waitFor(() => expect(calls("settings.update")).toEqual([{ syncEnabled: true, syncAsked: true }]));
    expect(calls("sync.setPassphrase")).toEqual([{ passphrase: "richtig langes Passwort" }]);
  });

  it("opens again from the palette after the setup", async () => {
    settings = { ...settings, setupDone: true, syncAsked: true };
    setup();
    await waitFor(() => expect(calls("settings.get")).toHaveLength(1));
    expect(screen.queryByText("FORGE einrichten")).toBeNull();
    useUi.getState().setSetupWizard(true);
    expect(await screen.findByText("FORGE einrichten")).toBeTruthy();
  });
});

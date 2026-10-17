import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { AppInstallState } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
const invokeMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

const { InstallRepairBanner, InstallRepairSettings } = await import("./InstallRepair");
const { useInstall } = await import("@/lib/app-install");

const incomplete: AppInstallState = {
  checkable: true,
  complete: false,
  problems: [
    { part: "git", kind: "missing", label: "Git fehlt" },
    { part: "gh", kind: "missing", label: "GitHub CLI fehlt" },
  ],
  expectedRuntime: "node-24.21.0_git-2.56.0.2_gh-2.102.0",
  phase: "found",
  installer: { version: "0.1.56", tag: "v0.1.56", name: "FORGE_0.1.56_x64-setup.exe", size: 96 * 1048576, source: "github", then: "0.1.60" },
  received: null,
  installerPath: null,
  canDownload: true,
  checkedAt: null,
  message: null,
};
let state: AppInstallState = incomplete;

function setup(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state = incomplete;
  useInstall.setState({ installing: false });
  callMock.mockReset();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  callMock.mockImplementation(async (method: string) => {
    if (method === "app.installState") return state;
    if (method === "app.downloadFullInstaller") return { ...state, phase: "ready", installerPath: "C:/tmp/forge-update/full/v0.1.56/FORGE_0.1.56_x64-setup.exe" };
    if (method === "app.prepareInstall") return { sessions: 0, working: 0 };
    if (method === "sessions.listLive") return [];
    return null;
  });
});
afterEach(cleanup);

describe("incomplete installation", () => {
  it("shows what is missing and installs fully the way an update does", async () => {
    setup(<InstallRepairBanner />);
    expect(await screen.findByText("FORGE ist nicht vollständig installiert.")).toBeTruthy();
    expect(screen.getByText("Git fehlt, GitHub CLI fehlt.")).toBeTruthy();
    expect(screen.getByText("Installer 0.1.56 · 96 MB, danach Update auf 0.1.60")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Vollständig installieren/ }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_update", { path: "C:/tmp/forge-update/full/v0.1.56/FORGE_0.1.56_x64-setup.exe" }));
    const order = callMock.mock.calls.map(([m]) => m as string).filter((m) => m.startsWith("app."));
    expect(order).toEqual(["app.installState", "app.downloadFullInstaller", "app.prepareInstall"]);
  });

  it("offers the release page and a downloaded setup.exe when FORGE cannot fetch the installer", async () => {
    state = { ...incomplete, phase: "none", installer: null, canDownload: false, message: "Ohne GitHub CLI kann FORGE den Installer nicht selbst laden." };
    setup(<InstallRepairBanner />);
    expect(await screen.findByText("Ohne GitHub CLI kann FORGE den Installer nicht selbst laden.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Vollständig installieren/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Release-Seite/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /setup\.exe auswählen/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Später" }));
    expect(screen.queryByText("FORGE ist nicht vollständig installiert.")).toBeNull();
  });

  it("shows a skeleton while it looks for the installer and nothing for a complete installation", async () => {
    state = { ...incomplete, phase: "searching", installer: null };
    const { unmount } = setup(<InstallRepairBanner />);
    expect(await screen.findByRole("status", { name: "Lädt Installer-Suche" })).toBeTruthy();
    unmount();
    state = { ...incomplete, complete: true, problems: [], phase: "idle", installer: null };
    setup(<InstallRepairBanner />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("app.installState", {}));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists the problems in the settings with download progress", async () => {
    state = { ...incomplete, phase: "downloading", received: 48 * 1048576 };
    setup(<InstallRepairSettings />);
    expect(await screen.findByText("Nicht vollständig installiert")).toBeTruthy();
    expect(screen.getByText("GitHub CLI fehlt")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Download des Installers" }).getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("48 von 96 MB")).toBeTruthy();
  });

  it("says when everything is there", async () => {
    state = { ...incomplete, complete: true, problems: [], phase: "idle", installer: null };
    setup(<InstallRepairSettings />);
    expect(await screen.findByText("Vollständig installiert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Neu prüfen/ })).toBeTruthy();
  });
});

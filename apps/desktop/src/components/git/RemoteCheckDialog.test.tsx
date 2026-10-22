import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GitIncoming } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { RemoteCheckDialog } = await import("./RemoteCheckDialog");
const { checkRemote, resetRemoteChecks, useRemoteCheck } = await import("@/stores/remote-check");
const { useUi } = await import("@/stores/ui");

const project = { id: "p1", name: "Shop", exists: true, gitEnabled: true, git: { remoteUrl: "https://github.com/x/shop.git", detached: false } };
const commit = (n: number) => ({ hash: `${n}`.repeat(40).slice(0, 40), shortHash: `${n}`.repeat(7), author: "Anna", authorEmail: "a@x", avatarUrl: null, date: new Date().toISOString(), parents: [], refs: [], subject: `Neu ${n}` });
const behind = (o: Partial<GitIncoming> = {}): GitIncoming => ({ branch: "dev", remoteHead: "r1", behind: 2, ahead: 1, changedCount: 3, commits: [commit(1), commit(2)], ...o });

let incoming: GitIncoming | null;

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RemoteCheckDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resetRemoteChecks();
  incoming = behind();
  callMock.mockReset();
  callMock.mockImplementation(async (method: string) => {
    if (method === "projects.get") return project;
    if (method === "git.incoming") return incoming;
    if (method === "git.pull") return { output: "", integrated: { mode: "merge", remoteCommits: 2, localCommits: 1 }, session: null };
    if (method === "git.resetToRemote") return { branch: "dev", stashed: true, backupBranch: "forge-backup/dev-20261022-0930", dropped: 1 };
    return null;
  });
  useUi.setState({ view: "workspace", activeProjectId: "p1" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const methods = () => callMock.mock.calls.map((c) => c[0] as string);

describe("remote check on opening a project", () => {
  it("asks when origin is ahead and pulls with the chosen strategy", async () => {
    setup();
    expect(await screen.findByText("Neuer Stand auf origin/dev")).toBeTruthy();
    expect(screen.getByText("Neu 1")).toBeTruthy();
    expect(screen.getByText("1 Commit nicht gepusht, 3 Dateien geändert, nicht committet")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /Zusammenführen per Merge/ }));
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(useRemoteCheck.getState().shown).toBeNull());
    expect(callMock).toHaveBeenCalledWith("git.pull", { projectId: "p1", strategy: "merge" });
  });

  it("offers no choice when nothing is open locally, and no merge without own commits", async () => {
    incoming = behind({ ahead: 0, changedCount: 0 });
    setup();
    expect(await screen.findByRole("button", { name: "Aktualisieren" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();

    act(() => useRemoteCheck.getState().close());
    incoming = behind({ ahead: 0, changedCount: 2, remoteHead: "r2" });
    await act(() => checkRemote("p1", true));
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual([expect.stringMatching(/^Übernehmen, eigene Arbeit/), expect.stringMatching(/^Auf den Stand vom Server/)]);
  });

  it("resets to origin and says where the own work went", async () => {
    setup();
    fireEvent.click(await screen.findByRole("radio", { name: /Auf den Stand vom Server zurücksetzen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Zurücksetzen" }));
    await waitFor(() => expect(useRemoteCheck.getState().shown).toBeNull());
    expect(methods()).toContain("git.resetToRemote");
    expect(methods()).not.toContain("git.pull");
  });

  it("checks automatically only on the first opening; the palette asks again after Später", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Später" }));
    expect(useRemoteCheck.getState().shown).toBeNull();

    incoming = behind({ remoteHead: "r2" });
    await act(() => checkRemote("p1", false));
    expect(useRemoteCheck.getState().shown).toBeNull();
    expect(methods().filter((m) => m === "git.incoming")).toHaveLength(1);

    await act(() => checkRemote("p1", true));
    expect(useRemoteCheck.getState().shown?.incoming.remoteHead).toBe("r2");
  });

  it("stays silent when the branch is up to date or the server is unreachable", async () => {
    incoming = behind({ behind: 0, commits: [] });
    setup();
    await waitFor(() => expect(methods()).toContain("git.incoming"));
    expect(useRemoteCheck.getState().shown).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

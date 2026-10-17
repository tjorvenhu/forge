import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DevServerState, GitSummary, ProjectWithStatus, WorktreeSetupState } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { useToasts } from "@/stores/toast";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
const closeTerminalsMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@/lib/terminal-registry", () => ({ closeProjectTerminals: (ids: string[]) => closeTerminalsMock(ids) }));
const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(async () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));

const { RpcCallError } = await import("@/lib/rpc");
const { AgentsTab } = await import("./AgentsTab");
const { useChatWindows } = await import("@/lib/chat-windows");
const { offeredGroups } = await import("@/lib/context-menu");

function git(branch: string, changedCount = 0): GitSummary {
  return { isRepo: true, branch, detached: false, ahead: 0, behind: 0, upstream: null, changedCount, conflicted: false, remoteUrl: null };
}

function project(id: string, over: Partial<ProjectWithStatus> = {}): ProjectWithStatus {
  return {
    id,
    name: id,
    path: `C:\\code\\${id}`,
    favorite: false,
    tags: [],
    technologies: [],
    profile: "balanced",
    defaultModel: null,
    defaultEffort: null,
    createdAt: "2026-10-10T00:00:00Z",
    lastOpenedAt: null,
    testCommand: null,
    devCommand: null,
    parentId: null,
    gitEnabled: true,
    exists: true,
    git: git("main"),
    lastSession: null,
    ...over,
  };
}

const app = project("app", { name: "App" });
const login = project("wt-login", { name: "App · agent/login", parentId: "app", git: git("agent/login") });
const dirty = project("wt-dirty", { name: "App · agent/dirty", parentId: "app", git: git("agent/dirty", 3) });
const other = project("other", { name: "Anderes" });
const otherWt = project("wt-other", { parentId: "other", git: git("agent/fremd") });

function setup(open: ProjectWithStatus) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentsTab project={open} />
    </QueryClientProvider>,
  );
}

const failedSetup: WorktreeSetupState = {
  projectId: "wt-login",
  status: "failed",
  steps: [
    { id: "files", label: "Lokale Konfiguration", status: "done", detail: "1 Datei kopiert: .env", durationMs: 20 },
    { id: "deps", label: "Abhängigkeiten", status: "failed", detail: "pnpm install fehlgeschlagen (Exit-Code 1)", durationMs: 4000 },
  ],
  devPort: 4100,
  startedAt: "2026-10-17T10:00:00Z",
  finishedAt: "2026-10-17T10:00:05Z",
};

function devState(projectId: string, running: boolean): DevServerState {
  return { projectId, status: running ? "running" : "stopped", command: null, url: running ? "http://localhost:4100/" : null, startedAt: null, exitCode: null, error: null, effectiveCommand: "pnpm dev" };
}

async function openRemoval(branch: string) {
  const card = (await screen.findByText(branch)).closest("div.rounded-xl") as HTMLElement;
  fireEvent.click(within(card).getByRole("button", { name: "Entfernen" }));
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
  closeTerminalsMock.mockReset();
  invokeMock.mockClear();
  useChatWindows.setState({ sessions: [] });
  useToasts.setState({ toasts: [] });
  useUi.setState({ view: "workspace", activeProjectId: "app", workspaceTab: "agents" });
  callMock.mockImplementation(async (method: string, params: { projectId?: string }) => {
    if (method === "projects.list") return [app, login, dirty, other, otherWt];
    if (method === "config.docs") return [];
    if (method === "worktrees.remove") return { ok: true, deletedBranch: null, branchError: null };
    if (method === "worktrees.setup") return params.projectId === "wt-login" ? failedSetup : null;
    if (method === "worktrees.prepare") return { ...failedSetup, status: "running" };
    if (method === "devserver.state") return devState(params.projectId!, params.projectId === "wt-login");
    throw new Error("unexpected " + method);
  });
});

describe("AgentsTab", () => {
  it("shows how far each worktree is prepared and its own dev server, and repeats a failed preparation", async () => {
    setup(app);
    const card = (await screen.findByText("agent/login")).closest("div.rounded-xl") as HTMLElement;
    expect((await within(card).findByText("Fehlgeschlagen: Abhängigkeiten")).getAttribute("title")).toMatch(/Lokale Konfiguration: fertig. 1 Datei kopiert: .env/);
    expect(within(card).getByRole("button", { name: ":4100" }).getAttribute("title")).toBe("Dev-Server öffnen: http://localhost:4100/");
    const quiet = (await screen.findByText("agent/dirty")).closest("div.rounded-xl") as HTMLElement;
    expect((await within(quiet).findByRole("button", { name: "Dev-Server" })).getAttribute("title")).toMatch(/starten und öffnen/);
    await act(async () => {
      fireEvent.click(within(card).getByRole("button", { name: "Vorbereitung wiederholen" }));
    });
    expect(callMock).toHaveBeenCalledWith("worktrees.prepare", { projectId: "wt-login" });
    expect(await within(card).findByText("Wird vorbereitet")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Vorbereitung wiederholen" })).toBeNull();
  });

  it("offers the card's actions on right click, with the agent's dev server", async () => {
    setup(app);
    const card = (await screen.findByText("agent/login")).closest("div.rounded-xl") as HTMLElement;
    await within(card).findByText(":4100");
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    card.dispatchEvent(ev);
    expect(offeredGroups(ev)[0]?.map((i) => i.label)).toEqual([
      "Öffnen",
      "Dev-Server des Agenten öffnen",
      "Dev-Server des Agenten stoppen",
      "Vorbereitung wiederholen",
      "Abschließen",
      "Entfernen",
    ]);
  });

  it("shows only the worktrees of the open project", async () => {
    setup(app);
    expect(await screen.findByText("agent/login")).toBeTruthy();
    expect(screen.getByText("agent/dirty")).toBeTruthy();
    expect(screen.queryByText("agent/fremd")).toBeNull();
  });

  it("shows the sibling worktrees and the main project when a worktree is open", async () => {
    useUi.setState({ activeProjectId: "wt-login" });
    setup(login);
    expect(await screen.findByText("agent/dirty")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Geöffnet" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hauptprojekt öffnen" }));
    expect(useUi.getState().activeProjectId).toBe("app");
  });

  it("ends the terminals of the worktree, removes it and leaves it when it was open", async () => {
    useUi.setState({ activeProjectId: "wt-login" });
    setup(login);
    await openRemoval("agent/login");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Entfernen" }));
    });
    expect(closeTerminalsMock).toHaveBeenCalledWith(["wt-login"]);
    expect(callMock).toHaveBeenCalledWith("worktrees.remove", { projectId: "wt-login", force: false, deleteBranch: false });
    expect(useUi.getState().activeProjectId).toBe("app");
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ tone: "success", title: "Worktree entfernt" });
  });

  it("closes the chat windows of the worktree's sessions once it is removed", async () => {
    useChatWindows.setState({ sessions: ["s-wt", "s-app"] });
    callMock.mockImplementation(async (method: string, params: { sessionId?: string }) => {
      if (method === "projects.list") return [app, login, dirty];
      if (method === "config.docs") return [];
      if (method === "sessions.get") return { id: params.sessionId, projectId: params.sessionId === "s-wt" ? "wt-login" : "app" };
      if (method === "worktrees.remove") return { ok: true, deletedBranch: null, branchError: null };
      throw new Error("unexpected " + method);
    });
    setup(app);
    await openRemoval("agent/login");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Entfernen" }));
    });
    expect(callMock).toHaveBeenCalledWith("worktrees.remove", expect.anything());
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "close_chat_window")).toEqual([["close_chat_window", { sessionId: "s-wt" }]]);
  });

  it("deletes the branch too when the box is ticked", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "projects.list") return [app, login, dirty];
      if (method === "config.docs") return [];
      if (method === "worktrees.remove") return { ok: true, deletedBranch: "agent/login", branchError: null };
      throw new Error("unexpected " + method);
    });
    setup(app);
    await openRemoval("agent/login");
    fireEvent.click(screen.getByRole("checkbox", { name: /Branch agent\/login auch löschen/ }));
    expect(screen.getByText(/ohne Merge gelöscht, seine Commits gehen verloren/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trotzdem entfernen" }));
    });
    expect(callMock).toHaveBeenCalledWith("worktrees.remove", { projectId: "wt-login", force: false, deleteBranch: true });
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ tone: "success", title: "Worktree und Branch gelöscht" });
  });

  it("asks for the typed confirmation right away when the worktree has changes", async () => {
    setup(app);
    await openRemoval("agent/dirty");
    const confirm = screen.getByRole("button", { name: "Trotzdem entfernen" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "LÖSCHEN" } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(callMock).toHaveBeenCalledWith("worktrees.remove", { projectId: "wt-dirty", force: true, deleteBranch: false });
  });

  it("keeps the dialog open and shows why when the folder is still in use", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "projects.list") return [app, login];
      if (method === "config.docs") return [];
      throw new RpcCallError("PATH_NOT_ACCESSIBLE", "Der Worktree-Ordner wird noch von einem anderen Programm benutzt.");
    });
    setup(app);
    await openRemoval("agent/login");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Entfernen" }));
    });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ tone: "error", body: expect.stringMatching(/anderen Programm/) });
  });
});

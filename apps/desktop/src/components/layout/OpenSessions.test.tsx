import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import type { TabSession } from "@/lib/session-tabs";
import { useUi } from "@/stores/ui";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { OpenSessions, SplitViewEntry } = await import("./OpenSessions");

// Asserted: fields the strip does not read may be added to Session without touching this test.
function session(id: string, projectId: string, createdAt: string, over: Partial<Session> = {}): Session {
  return ({
    id,
    projectId,
    claudeSessionId: null,
    cwd: `C:\\code\\${projectId}`,
    title: `Titel ${id}`,
    model: null,
    effort: null,
    profile: "balanced",
    permissionMode: "default",
    status: "idle",
    apiKeySource: null,
    createdAt,
    updatedAt: createdAt,
    lastError: null,
    live: true,
    background: [],
    context: null,
    ...over,
  }) as Session;
}

const names: Record<string, string> = { app: "App", web: "Web" };
const tab = (s: Session): TabSession => ({ ...s, projectName: names[s.projectId]! });

let live: TabSession[] = [];
let stored: Session[] = [];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OpenSessions />
    </QueryClientProvider>,
  );
}

const tabNames = () => screen.getAllByRole("tab").map((t) => t.getAttribute("aria-label")!.split(",")[0]);

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
  live = [];
  stored = [];
  useUi.setState({ view: "workspace", activeProjectId: "app", activeSession: {}, workspaceTab: "git", collapsedGroups: [], splitPanes: [] });
  callMock.mockImplementation(async (method: string, params: { sessionId?: string }) => {
    if (method === "sessions.listLive") return live;
    if (method === "projects.list") return Object.entries(names).map(([id, name]) => ({ id, name }));
    if (method === "sessions.get") {
      const s = stored.find((x) => x.id === params.sessionId);
      if (!s) throw new Error("not found");
      return s;
    }
    if (method === "sessions.close") return { ok: true };
    throw new Error("unexpected " + method);
  });
});

describe("OpenSessions", () => {
  it("renders nothing without live sessions and without an open project", async () => {
    useUi.setState({ view: "home" });
    setup();
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledWith("sessions.listLive", {}));
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("groups tabs per project in a stable order, oldest first", async () => {
    live = [
      tab(session("a2", "app", "2026-10-11T10:03:00Z", { status: "running" })),
      tab(session("w1", "web", "2026-10-11T10:02:00Z")),
      tab(session("a1", "app", "2026-10-11T10:01:00Z")),
    ];
    setup();
    await screen.findByRole("tablist", { name: "Sessions" });
    expect(tabNames()).toEqual(["Titel a1", "Titel a2", "Titel w1"]);
    const groups = document.querySelectorAll<HTMLElement>("[data-project-group]");
    expect([...groups].map((g) => g.dataset.projectGroup)).toEqual(["app", "web"]);
    expect(within(groups[0]!).getAllByRole("tab")).toHaveLength(2);
    expect(groups[1]!.textContent).toContain("Web");
  });

  it("highlights the session open in the workspace and opens another on click", async () => {
    live = [tab(session("a1", "app", "2026-10-11T10:01:00Z")), tab(session("w1", "web", "2026-10-11T10:02:00Z"))];
    useUi.setState({ activeSession: { app: "a1" } });
    setup();
    const active = await screen.findByRole("tab", { name: /^Titel a1/ });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(active.tabIndex).toBe(0);
    const other = screen.getByRole("tab", { name: /^Titel w1/ });
    expect(other.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(other);
    const ui = useUi.getState();
    expect(ui.activeProjectId).toBe("web");
    expect(ui.activeSession.web).toBe("w1");
    expect(ui.workspaceTab).toBe("chat");
    expect(screen.getByRole("tab", { name: /^Titel w1/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("lists a new session without a message while it is open and drops it when you leave", async () => {
    live = [tab(session("a1", "app", "2026-10-11T10:01:00Z"))];
    useUi.setState({ activeSession: { app: null } });
    setup();
    await screen.findByRole("tablist", { name: "Sessions" });
    const group = document.querySelector<HTMLElement>('[data-project-group="app"]')!;
    expect(within(group).getByText("Neue Session")).toBeTruthy();
    // The new session is not a tab yet: Ctrl+Tab and the arrow keys only walk real sessions.
    expect(tabNames()).toEqual(["Titel a1"]);

    fireEvent.click(screen.getByRole("tab", { name: /^Titel a1/ }));
    expect(screen.queryByText("Neue Session")).toBeNull();
  });

  it("collapses a project: its sessions leave the tree and the arrow keys, waiting ones still show", async () => {
    live = [
      tab(session("a1", "app", "2026-10-11T10:01:00Z", { status: "waiting_approval" })),
      tab(session("a2", "app", "2026-10-11T10:02:00Z")),
      tab(session("w1", "web", "2026-10-11T10:03:00Z")),
    ];
    useUi.setState({ activeSession: { app: "a2" } });
    setup();
    await screen.findByRole("tablist", { name: "Sessions" });
    fireEvent.click(screen.getByRole("button", { name: "Sessions von App ausblenden" }));
    expect(tabNames()).toEqual(["Titel w1"]);
    expect(useUi.getState().collapsedGroups).toEqual(["app"]);
    const group = document.querySelector<HTMLElement>('[data-project-group="app"]')!;
    expect(within(group).getByLabelText("2 Sessions ausgeblendet").querySelector(".bg-warning")).toBeTruthy();
    // The new-session button opens the project up again.
    fireEvent.click(screen.getByRole("button", { name: "Neue Session in App" }));
    expect(useUi.getState().collapsedGroups).toEqual([]);
    expect(tabNames()).toEqual(["Titel a1", "Titel a2", "Titel w1"]);
  });

  it("shows the new session also in a project without running sessions", async () => {
    useUi.setState({ activeSession: { app: null } });
    setup();
    expect(await screen.findByText("Neue Session")).toBeTruthy();
  });

  it("selects no tab outside the workspace", async () => {
    live = [tab(session("a1", "app", "2026-10-11T10:01:00Z"))];
    useUi.setState({ view: "home", activeSession: { app: "a1" } });
    setup();
    const t = await screen.findByRole("tab", { name: /^Titel a1/ });
    expect(t.getAttribute("aria-selected")).toBe("false");
  });

  it("shows the open session without a running process as the last tab of its group", async () => {
    live = [tab(session("a1", "app", "2026-10-11T10:05:00Z")), tab(session("w1", "web", "2026-10-11T10:06:00Z"))];
    stored = [session("old", "app", "2026-10-01T09:00:00Z", { live: false })];
    useUi.setState({ activeSession: { app: "old" } });
    setup();
    const t = await screen.findByRole("tab", { name: /^Titel old/ });
    expect(t.getAttribute("aria-selected")).toBe("true");
    expect(t.getAttribute("aria-label")).toContain("Pausiert");
    expect(tabNames()).toEqual(["Titel a1", "Titel old", "Titel w1"]);
    // nothing to end without a process
    expect(screen.queryByRole("button", { name: "Claude-Prozess von Titel old beenden" })).toBeNull();
  });

  it("closes an idle session, but offers no close while Claude works or waits", async () => {
    live = [
      tab(session("a1", "app", "2026-10-11T10:01:00Z")),
      tab(session("a2", "app", "2026-10-11T10:02:00Z", { status: "running" })),
      tab(session("a3", "app", "2026-10-11T10:03:00Z", { status: "waiting_approval" })),
    ];
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Claude-Prozess von Titel a1 beenden" }));
    expect(callMock).toHaveBeenCalledWith("sessions.close", { sessionId: "a1" });
    expect(screen.queryByRole("button", { name: "Claude-Prozess von Titel a2 beenden" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Claude-Prozess von Titel a3 beenden" })).toBeNull();
    expect(screen.getByRole("tab", { name: /^Titel a3/ }).getAttribute("aria-label")).toContain("Freigabe nötig");
  });

  it("moves focus with the arrow keys across project groups", async () => {
    live = [tab(session("a1", "app", "2026-10-11T10:01:00Z")), tab(session("w1", "web", "2026-10-11T10:02:00Z"))];
    setup();
    const first = await screen.findByRole("tab", { name: /^Titel a1/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /^Titel w1/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(useUi.getState().activeSession.web).toBe("w1");
  });
});

describe("OpenSessions tree", () => {
  it("shows the open project without sessions and starts a new session from it", async () => {
    setup();
    const group = await vi.waitFor(() => {
      const g = document.querySelector<HTMLElement>('[data-project-group="app"]');
      if (!g) throw new Error("no group yet");
      return g;
    });
    expect(within(group).queryAllByRole("tab")).toHaveLength(0);
    useUi.setState({ activeSession: { app: "a1" } });
    fireEvent.click(within(group).getByRole("button", { name: "Neue Session in App" }));
    expect(useUi.getState().activeSession.app).toBeNull();
    expect(useUi.getState().workspaceTab).toBe("chat");
  });

  it("lists an agent's sessions under its main project, marked as agent", async () => {
    const projectList = [
      { id: "app", name: "App", parentId: null },
      { id: "wt", name: "App · agent/csv-4y6f", parentId: "app", git: { branch: "agent/csv-4y6f" } },
    ];
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation(async (method: string, params: unknown) => (method === "projects.list" ? projectList : base(method, params)));
    live = [tab(session("a1", "app", "2026-10-11T10:01:00Z")), { ...session("g1", "wt", "2026-10-11T10:02:00Z", { status: "running" }), projectName: "App · agent/csv-4y6f" }];
    useUi.setState({ activeProjectId: "wt", activeSession: { wt: "g1" } });
    setup();
    const agentTab = await screen.findByRole("tab", { name: /^Titel g1, Agent csv-4y6f in App/ });
    await vi.waitFor(() => expect(document.querySelectorAll("[data-project-group]")).toHaveLength(1));
    const group = document.querySelector<HTMLElement>('[data-project-group="app"]')!;
    expect(within(group).getAllByRole("tab").map((t) => t.getAttribute("aria-label")!.split(",")[0])).toEqual(["Titel a1", "Titel g1"]);
    expect(agentTab.getAttribute("aria-selected")).toBe("true");
    expect(agentTab.getAttribute("title")).toContain("Paralleler Agent auf Branch agent/csv-4y6f");
    // A click opens the agent's own worktree, not the main project.
    fireEvent.click(agentTab);
    expect(useUi.getState().activeProjectId).toBe("wt");
  });

  it("lists the sessions under their project", async () => {
    live = [tab(session("w1", "web", "2026-10-11T10:02:00Z")), tab(session("a1", "app", "2026-10-11T10:01:00Z"))];
    setup();
    await screen.findByRole("tab", { name: /^Titel w1/ });
    const web = document.querySelector<HTMLElement>('[data-project-group="web"]')!;
    expect(within(web).getByRole("button", { name: "Web" }).getAttribute("title")).toBe("Web öffnen");
    expect(within(web).getAllByRole("tab").map((t) => t.getAttribute("aria-label")!.split(",")[0])).toEqual(["Titel w1"]);
  });

  it("lists the split view's areas: their sessions without a process, their projects and new sessions", async () => {
    stored = [session("a1", "app", "2026-10-11T10:01:00Z"), session("w1", "web", "2026-10-11T10:02:00Z", { live: false })];
    live = [tab(stored[0]!)];
    useUi.setState({
      activeSession: { app: "a1" },
      splitPanes: [
        { id: "p1", projectId: "web", active: "w1" },
        { id: "p2", projectId: "web", active: null },
        { id: "p3", projectId: "app", active: null },
      ],
    });
    setup();
    await screen.findByRole("tab", { name: /^Titel w1/ });
    expect(tabNames()).toEqual(["Titel a1", "Titel w1"]);
    const web = document.querySelector<HTMLElement>('[data-project-group="web"]')!;
    expect(web.querySelectorAll("[data-pane-new-session]")).toHaveLength(1);
    const app = document.querySelector<HTMLElement>('[data-project-group="app"]')!;
    const paneNew = app.querySelector<HTMLElement>("[data-pane-new-session]")!;

    fireEvent.click(paneNew);
    const ui = useUi.getState();
    expect(ui.activeSession.app).toBeNull();
    expect(ui.splitPanes.find((p) => p.id === "p3")).toMatchObject({ projectId: "app", active: "a1" });
  });
});

describe("SplitViewEntry", () => {
  it("shows the split view with its area count and goes back to it from another view", () => {
    useUi.setState({ view: "settings", splitPanes: [{ id: "p1", projectId: "web", active: null }] });
    render(<SplitViewEntry />);
    const entry = screen.getByRole("button", { name: /Geteilte Ansicht/ });
    expect(entry.getAttribute("aria-current")).toBeNull();
    expect(screen.getByLabelText("2 Bereiche")).toBeTruthy();
    fireEvent.click(entry);
    expect(useUi.getState().view).toBe("workspace");
    expect(screen.getByRole("button", { name: /Geteilte Ansicht/ }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "Teilung aufheben" }));
    expect(useUi.getState().splitPanes).toEqual([]);
    expect(screen.queryByRole("button", { name: /Geteilte Ansicht/ })).toBeNull();
  });
});

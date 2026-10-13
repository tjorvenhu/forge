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

const { OpenSessions } = await import("./OpenSessions");

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
  useUi.setState({ view: "workspace", activeProjectId: "app", activeSession: {}, workspaceTab: "git" });
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

  it("lists the sessions under their project", async () => {
    live = [tab(session("w1", "web", "2026-10-11T10:02:00Z")), tab(session("a1", "app", "2026-10-11T10:01:00Z"))];
    setup();
    await screen.findByRole("tab", { name: /^Titel w1/ });
    const web = document.querySelector<HTMLElement>('[data-project-group="web"]')!;
    expect(within(web).getByRole("button", { name: "Web" }).getAttribute("title")).toBe("Web öffnen");
    expect(within(web).getAllByRole("tab").map((t) => t.getAttribute("aria-label")!.split(",")[0])).toEqual(["Titel w1"]);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "./ui";

beforeEach(() => {
  localStorage.clear();
  useUi.setState({ view: "workspace", activeProjectId: "p1", activeSession: { p1: "s1" }, workspaceTab: "chat", splitPanes: [], splitStash: null });
});

const panes = () => useUi.getState().splitPanes.map(({ projectId, active }) => ({ projectId, active }));

describe("split view", () => {
  it("adds a pane with a session picker, and does not show a session twice", () => {
    const ui = useUi.getState();
    ui.addSplitPane();
    ui.addSplitPane("p1", "s1");
    ui.addSplitPane("p2", "s2");
    ui.addSplitPane("p2", "s2");
    expect(panes()).toEqual([
      { projectId: null, active: null },
      { projectId: "p2", active: "s2" },
    ]);
  });

  it("opens another project in a pane and lets it pick its latest session, unless one is given", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2");
    const id = useUi.getState().splitPanes[0]!.id;
    expect(useUi.getState().splitPanes[0]).toEqual({ id, projectId: "p2", active: null, pick: true });
    ui.setSplitPane(id, "p2", "s2");
    expect(useUi.getState().splitPanes[0]).toEqual({ id, projectId: "p2", active: "s2" });
    ui.setSplitPane(id, "p3", null);
    expect(useUi.getState().splitPanes[0]).toEqual({ id, projectId: "p3", active: null });
    ui.setSplitPane(id, null);
    expect(useUi.getState().splitPanes[0]).toEqual({ id, projectId: null, active: null });
  });

  it("does not pick a session for a pane that another chat shows", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.addSplitPane();
    const picker = useUi.getState().splitPanes[1]!.id;
    ui.setSplitPane(picker, "p1", "s1");
    ui.setSplitPane(picker, "p2", "s2");
    expect(panes()[1]).toEqual({ projectId: null, active: null });
    ui.setSplitPane(picker, "p1", "s3");
    expect(panes()[1]).toEqual({ projectId: "p1", active: "s3" });
  });

  it("leaves the split view as it is when opening a chat already on screen", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.setView("settings");
    ui.openProject("p2", "s2");
    expect(useUi.getState()).toMatchObject({ view: "workspace", activeProjectId: "p1", activeSession: { p1: "s1" }, splitStash: null });
    expect(panes()).toEqual([{ projectId: "p2", active: "s2" }]);
    ui.openProject("p1");
    expect(panes()).toEqual([{ projectId: "p2", active: "s2" }]);
  });

  it("closes the split view when another chat opens and brings it back from the sidebar", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.openProject("p3", "s3");
    expect(useUi.getState()).toMatchObject({ activeProjectId: "p3", activeSession: { p3: "s3" } });
    expect(panes()).toEqual([]);
    expect(useUi.getState().splitStash).toMatchObject({ main: { projectId: "p1", active: "s1" }, panes: [{ projectId: "p2", active: "s2" }] });

    ui.restoreSplit();
    expect(useUi.getState()).toMatchObject({ activeProjectId: "p1", activeSession: { p1: "s1" }, splitStash: null });
    expect(panes()).toEqual([{ projectId: "p2", active: "s2" }]);

    // A new split view replaces the kept one.
    ui.openProject("p3", null);
    ui.addSplitPane("p4", "s4");
    expect(useUi.getState().splitStash).toBeNull();
    expect(panes()).toEqual([{ projectId: "p4", active: "s4" }]);
  });

  it("swaps two areas by drag and drop; a picker cannot take the main area's place", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.addSplitPane("p3", "s3");
    ui.addSplitPane();
    const [a, b, picker] = useUi.getState().splitPanes.map((p) => p.id) as [string, string, string];
    ui.swapSplitAreas(a, b);
    expect(panes()).toEqual([
      { projectId: "p3", active: "s3" },
      { projectId: "p2", active: "s2" },
      { projectId: null, active: null },
    ]);
    ui.swapSplitAreas("main", picker);
    expect(useUi.getState().activeProjectId).toBe("p1");
    ui.swapSplitAreas("main", a);
    expect(useUi.getState()).toMatchObject({ activeProjectId: "p2", activeSession: { p2: "s2" } });
    expect(panes()).toEqual([
      { projectId: "p3", active: "s3" },
      { projectId: "p1", active: "s1" },
      { projectId: null, active: null },
    ]);
  });

  it("swaps places when the main chat switches to a session a pane shows", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.addSplitPane("p1", "s4");
    ui.setActiveSession("p1", "s4");
    expect(panes()).toEqual([
      { projectId: "p2", active: "s2" },
      { projectId: "p1", active: "s1" },
    ]);
  });

  it("promotes a pane to the main chat and puts the main chat in its place", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.setWorkspaceTab("git");
    ui.promoteSplitPane(useUi.getState().splitPanes[0]!.id);
    expect(useUi.getState()).toMatchObject({ activeProjectId: "p2", workspaceTab: "chat", activeSession: { p2: "s2" } });
    expect(panes()).toEqual([{ projectId: "p1", active: "s1" }]);
  });

  it("clears deleted sessions from every chat", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.forgetSessions(["s1", "s2"]);
    expect(useUi.getState().activeSession.p1).toBeNull();
    expect(panes()).toEqual([{ projectId: "p2", active: null }]);
  });

  it("keeps the panes over a restart", () => {
    useUi.getState().addSplitPane("p2", "s2");
    expect(JSON.parse(localStorage.getItem("forge.ui")!).splitPanes).toEqual([expect.objectContaining({ projectId: "p2", active: "s2" })]);
    useUi.getState().closeSplitPanes();
    expect(JSON.parse(localStorage.getItem("forge.ui")!).splitPanes).toEqual([]);
  });
});

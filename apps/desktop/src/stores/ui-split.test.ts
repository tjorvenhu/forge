import { beforeEach, describe, expect, it } from "vitest";
import { useUi } from "./ui";

beforeEach(() => {
  localStorage.clear();
  useUi.setState({ view: "workspace", activeProjectId: "p1", activeSession: { p1: "s1" }, workspaceTab: "chat", splitPanes: [] });
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

  it("swaps places when the main chat opens a session a pane shows", () => {
    const ui = useUi.getState();
    ui.addSplitPane("p2", "s2");
    ui.openProject("p2", "s2");
    expect(useUi.getState()).toMatchObject({ activeProjectId: "p2", activeSession: { p1: "s1", p2: "s2" } });
    expect(panes()).toEqual([{ projectId: "p1", active: "s1" }]);
    ui.setActiveSession("p2", null);
    ui.addSplitPane("p2", "s4");
    ui.setActiveSession("p2", "s4");
    expect(panes()).toEqual([
      { projectId: "p1", active: "s1" },
      { projectId: "p2", active: null },
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

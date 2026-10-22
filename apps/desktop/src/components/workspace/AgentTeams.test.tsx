import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTeam, Project, TeamMember } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { useUi } from "@/stores/ui";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { AgentTeamsSection } = await import("./AgentTeams");
const { TeamGrid } = await import("./TeamBoard");
const { leadState, openTeamStart, teamBusy, useTeamDialog } = await import("@/lib/agent-teams");

const project = { id: "p1", name: "shop", path: "C:\\code\\shop", exists: true } as unknown as Project;
const now = new Date().toISOString();

function member(over: Partial<TeamMember>): TeamMember {
  return {
    id: "a1", role: "developer", agentType: "team-developer", title: "Index bauen", prompt: "Baue den Index", model: "sonnet", background: true,
    state: "working", startedAt: now, endedAt: null, activity: "Edit · src/index.ts", toolUses: 3, files: ["src/index.ts"], result: null, ...over,
  };
}

function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    sessionId: "s1",
    projectId: "p1",
    title: "Volltextsuche bauen",
    leadModel: "opus",
    status: "idle",
    live: true,
    createdAt: now,
    updatedAt: now,
    members: [
      member({}),
      member({ id: "a2", role: "scout", agentType: "team-scout", title: "Suche finden", model: "haiku", state: "done", endedAt: now, activity: null, result: "src/search.ts:10" }),
    ],
    tasks: [
      { id: "1", subject: "Suche verstehen", status: "completed", activeForm: null },
      { id: "2", subject: "Index bauen", status: "in_progress", activeForm: "Baut den Index" },
    ],
    ...over,
  };
}

/** The sidecar of the tests: agent teams switched on, plus the answers a test needs. */
function mockRpc(answers: Record<string, unknown>, settings: Record<string, unknown> = { agentTeams: true }) {
  callMock.mockImplementation(async (method: string) => (method === "settings.get" ? settings : method === "projects.list" ? [] : (answers[method] ?? null)));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

beforeEach(() => {
  callMock.mockReset();
  useTeamDialog.setState({ projectId: null });
  useUi.setState({ activeProjectId: "p1", view: "workspace", taskView: null });
});
afterEach(cleanup);

describe("AgentTeamsSection", () => {
  it("shows a team card with its lead, members and plan, and opens the lead's chat", async () => {
    mockRpc({ "teams.list": [team()] });
    wrap(<AgentTeamsSection project={project} />);
    expect(await screen.findByText("Volltextsuche bauen")).toBeTruthy();
    expect(screen.getByText("Opus")).toBeTruthy();
    expect(screen.getByTitle(/Entwickler: Index bauen|Developer: Index bauen/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^(Öffnen|Open)$/ }));
    expect(useUi.getState().activeSession.p1).toBe("s1");
    expect(useUi.getState().workspaceTab).toBe("chat");
  });

  it("starts a team with the goal and the lead model from the dialog, after warning about the usage", async () => {
    mockRpc({ "teams.list": [], "teams.start": { id: "s9", projectId: "p1" } });
    wrap(<AgentTeamsSection project={project} />);
    fireEvent.click((await screen.findAllByRole("button", { name: /Team starten|Start team/ }))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Erhöhter Verbrauch|Higher usage/)).toBeTruthy();
    // every role with its model
    for (const m of ["Haiku", "Sonnet", "Opus"]) expect(within(dialog).getAllByText(m).length).toBeGreaterThan(0);
    const start = within(dialog).getAllByRole("button", { name: /Team starten|Start team/ }).at(-1) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Fable/ }));
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  Baue die Suche " } });
    fireEvent.click(start);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("teams.start", { projectId: "p1", prompt: "Baue die Suche", leadModel: "fable" }));
    await waitFor(() => expect(useUi.getState().activeSession.p1).toBe("s9"));
  });

  it("stops a working team only after asking", async () => {
    mockRpc({ "teams.list": [team({ status: "running" })], "teams.stop": { stopped: 1 } });
    wrap(<AgentTeamsSection project={project} />);
    await screen.findByText("Volltextsuche bauen");
    fireEvent.click(screen.getByRole("button", { name: /^(Stoppen|Stop)$/ }));
    const dialog = await screen.findByRole("dialog");
    expect(callMock).not.toHaveBeenCalledWith("teams.stop", expect.anything());
    fireEvent.click(within(dialog).getAllByRole("button").at(-1)!);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("teams.stop", { sessionId: "s1" }));
  });

  it("stays hidden while agent teams are switched off, unless one still works", async () => {
    mockRpc({ "teams.list": [] }, { agentTeams: false });
    const { container } = wrap(<AgentTeamsSection project={project} />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("teams.list", { projectId: "p1" }));
    expect(container.textContent).toBe("");
    cleanup();
    mockRpc({ "teams.list": [team({ status: "running" })] }, { agentTeams: false });
    wrap(<AgentTeamsSection project={project} />);
    expect(await screen.findByText("Volltextsuche bauen")).toBeTruthy();
    expect((screen.getAllByRole("button", { name: /Team starten|Start team/ })[0] as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("team board", () => {
  it("shows what each member does and opens its history on click", () => {
    wrap(<TeamGrid team={team()} />);
    expect(screen.getByText(/Edit · src\/index.ts/)).toBeTruthy();
    expect(screen.getByText("src/search.ts:10")).toBeTruthy();
    expect(screen.getByText("Baut den Index")).toBeTruthy();
    fireEvent.click(screen.getByText("Suche finden"));
    expect(useUi.getState().taskView).toMatchObject({ kind: "agent", sessionId: "s1", toolUseId: "a2" });
  });
});

describe("agent team helpers", () => {
  it("reads the lead's state from the session and its members", () => {
    expect(leadState(team({ status: "running" }))).toBe("planning");
    expect(leadState(team({ status: "idle" }))).toBe("waiting");
    expect(leadState(team({ status: "idle", members: [] }))).toBe("idle");
    expect(leadState(team({ status: "waiting_approval" }))).toBe("approval");
    expect(leadState(team({ live: false }))).toBe("stopped");
    expect(teamBusy(team({ status: "idle", members: [] }))).toBe(false);
    expect(teamBusy(team({ live: false, status: "running" }))).toBe(false);
  });

  it("opens the Agents tab of the project with the start dialog", () => {
    useUi.setState({ activeProjectId: "other" });
    openTeamStart("p1");
    expect(useUi.getState()).toMatchObject({ activeProjectId: "p1", workspaceTab: "agents" });
    expect(useTeamDialog.getState().projectId).toBe("p1");
  });
});

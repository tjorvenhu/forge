import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTeam, Project } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { useTerminals } from "@/stores/terminals";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { AgentTeamsSection } = await import("./AgentTeams");
const { teamLinks, memberColor, startTeamTerminal } = await import("@/lib/agent-teams");

const project = { id: "p1", name: "shop", path: "C:\\code\\shop", exists: true } as unknown as Project;

function team(over: Partial<AgentTeam> = {}): AgentTeam {
  return {
    name: "session-1a2b3c4d",
    leadSessionId: "1a2b3c4d-0000",
    projectId: "p1",
    cwd: "C:\\code\\shop",
    active: true,
    createdAt: new Date().toISOString(),
    endedAt: null,
    members: [
      { name: "team-lead", agentId: "team-lead@x", lead: true, agentType: "team-lead", color: null, model: null, prompt: null, joinedAt: "", state: "unknown", lastResult: null },
      { name: "alpha", agentId: "alpha@x", lead: false, agentType: "general-purpose", color: "blue", model: "haiku", prompt: "Du bist alpha.", joinedAt: "", state: "working", lastResult: null },
      { name: "beta", agentId: "beta@x", lead: false, agentType: "general-purpose", color: "green", model: "haiku", prompt: "Du bist beta.", joinedAt: "", state: "idle", lastResult: "write B erledigt" },
    ],
    tasks: [
      { id: "1", subject: "write A", description: "", owner: "alpha", status: "in_progress", blocks: ["3"], blockedBy: [], blocked: false },
      { id: "2", subject: "write B", description: "", owner: "beta", status: "completed", blocks: ["3"], blockedBy: [], blocked: false },
      { id: "3", subject: "combine", description: "", owner: "alpha", status: "pending", blocks: [], blockedBy: ["1", "2"], blocked: true },
    ],
    messages: [{ id: "m1", from: "alpha", to: "beta", kind: "message", text: "hello from alpha", summary: null, ts: new Date().toISOString() }],
    ...over,
  };
}

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AgentTeamsSection project={project} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  useTerminals.setState({ tabs: {}, active: {} });
});
afterEach(cleanup);

describe("AgentTeamsSection", () => {
  it("shows members, the task board with blocked tasks and the messages of a running team", async () => {
    callMock.mockImplementation(async (method: string) => (method === "teams.list" ? [team()] : null));
    renderSection();
    expect(await screen.findByText("session-1a2b3c4d")).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith("teams.list", { projectId: "p1" });
    expect(screen.getByText("write B erledigt")).toBeTruthy();
    expect(screen.getByText("hello from alpha")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1");
    expect(screen.getByText(/#1, #2/)).toBeTruthy();
  });

  it("sends a message to the chosen member", async () => {
    callMock.mockImplementation(async (method: string) => (method === "teams.list" ? [team()] : method === "teams.message" ? { recipients: ["team-lead"] } : null));
    renderSection();
    await screen.findByText("session-1a2b3c4d");
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Bitte Tests ergänzen" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("teams.message", { team: "session-1a2b3c4d", to: "team-lead", text: "Bitte Tests ergänzen" }));
  });

  it("keeps an ended team collapsed and offers no messages to it", async () => {
    callMock.mockImplementation(async (method: string) => (method === "teams.list" ? [team({ active: false, endedAt: new Date().toISOString() })] : null));
    renderSection();
    await screen.findByText("session-1a2b3c4d");
    expect(screen.queryByText("hello from alpha")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("hello from alpha")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("starts a team terminal with the task from the dialog", async () => {
    callMock.mockImplementation(async (method: string) => (method === "teams.list" ? [] : null));
    useUi.setState({ activeProjectId: "p1" });
    renderSection();
    const empty = await screen.findAllByRole("button", { name: /team/i });
    fireEvent.click(empty[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "  Review mit drei Leuten " } });
    fireEvent.click(within(dialog).getAllByRole("button").at(-1)!);
    expect(useUi.getState().terminalRequest).toMatchObject({ projectId: "p1", program: "claude", team: true, prompt: "Review mit drei Leuten" });
  });
});

describe("agent team helpers", () => {
  it("counts the messages between two members in both directions", () => {
    const links = teamLinks([
      { id: "1", from: "alpha", to: "beta", kind: "message", text: "", summary: null, ts: "2026-10-22T10:00:00Z" },
      { id: "2", from: "beta", to: "alpha", kind: "message", text: "", summary: null, ts: "2026-10-22T10:01:00Z" },
      { id: "3", from: "user", to: "alpha", kind: "message", text: "", summary: null, ts: "2026-10-22T10:02:00Z" },
    ]);
    expect(links).toEqual([
      { a: "alpha", b: "beta", count: 2, last: "2026-10-22T10:01:00Z" },
      { a: "alpha", b: "user", count: 1, last: "2026-10-22T10:02:00Z" },
    ]);
  });

  it("uses Claude Code's color of a teammate and the accent for the lead", () => {
    const t = team();
    expect(memberColor(t, "alpha")).toBe("#3e8cf0");
    expect(memberColor(t, "team-lead")).toBe("var(--color-accent)");
    expect(memberColor(t, "unbekannt")).toMatch(/^#/);
  });

  it("opens the project before asking for the team terminal", () => {
    useUi.setState({ activeProjectId: "other" });
    startTeamTerminal("p1", "");
    expect(useUi.getState().activeProjectId).toBe("p1");
    expect(useUi.getState().terminalRequest).toMatchObject({ projectId: "p1", team: true, prompt: null });
  });
});

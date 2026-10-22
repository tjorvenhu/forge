import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Crew, Project } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useUi } from "@/stores/ui";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { CrewTab } = await import("./CrewTab");

const project = { id: "p1", name: "shop", path: "C:\\code\\shop", exists: true, parentId: null, gitEnabled: true } as unknown as Project;
const now = new Date().toISOString();

function crew(over: Partial<Crew> = {}): Crew {
  return {
    id: "c1",
    name: "Shop-Crew",
    projectId: "p1",
    projectName: "shop",
    relayUrl: "https://crew.example",
    membership: "member",
    joinCode: null,
    connection: "online",
    error: null,
    selfId: "me",
    members: [
      { id: "me", name: "Tim", color: "#3e8cf0", self: true, owner: true, online: true, lastSeen: now, branch: "main", files: [], ahead: 0, agents: [] },
      {
        id: "anna",
        name: "Anna",
        color: "#30a46c",
        self: false,
        owner: false,
        online: true,
        lastSeen: now,
        branch: "main",
        files: ["src/api.ts"],
        ahead: 2,
        agents: [{ id: "s9", title: "API bauen", status: "working", task: "Baue die REST-API", files: ["src/api.ts"], lastResult: null, branch: null, updatedAt: now }],
      },
    ],
    tasks: [
      { id: "t1", title: "Login-Seite", detail: "", status: "open", createdBy: "me", assignee: null, owner: null, note: null, source: "user", createdAt: now, updatedAt: now },
      { id: "t2", title: "REST-API", detail: "", status: "in_progress", createdBy: "anna", assignee: "anna", owner: { member: "anna", agent: "API bauen" }, note: null, source: "agent", createdAt: now, updatedAt: now },
      { id: "t3", title: "Projekt aufsetzen", detail: "", status: "done", createdBy: "me", assignee: null, owner: { member: "me", agent: null }, note: "läuft", source: "user", createdAt: now, updatedAt: now },
    ],
    feed: [{ id: "f1", kind: "message", from: "anna", agent: null, to: null, text: "Ich nehme die API", files: [], ts: now }],
    requests: [],
    acceptTasks: "ask",
    autoPull: true,
    shareAgents: "ask",
    shareRequests: [],
    shares: [],
    behind: 0,
    invite: null,
    createdAt: now,
    ...over,
  };
}

function mockRpc(answers: Record<string, unknown>) {
  callMock.mockImplementation(async (method: string) => (method in answers ? answers[method] : null));
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <CrewTab project={project} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  useUi.setState({ crewRequest: null });
});
afterEach(cleanup);

describe("CrewTab", () => {
  it("offers to start or join a crew when the project has none", async () => {
    mockRpc({ "crew.list": [] });
    renderTab();
    expect(await screen.findByText("Gemeinsam an diesem Projekt arbeiten")).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith("crew.list", { projectId: "p1" });
    expect(screen.getByRole("button", { name: /Crew starten/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Beitritt anfragen/ })).toBeTruthy();
  });

  it("starts a crew with the given name", async () => {
    mockRpc({ "crew.list": [], "crew.create": crew() });
    renderTab();
    fireEvent.change(await screen.findByPlaceholderText("shop"), { target: { value: "Team Shop" } });
    fireEvent.click(screen.getByRole("button", { name: /Crew starten/ }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.create", { projectId: "p1", name: "Team Shop" }));
  });

  it("checks an invite code and asks to join with this project", async () => {
    mockRpc({
      "crew.list": [],
      "crew.inspect": { crewName: "Shop-Crew", projectName: "shop", remote: "github.com/a/shop", cloneUrl: null, from: "Anna", relayUrl: "https://crew.example", expiresAt: new Date(Date.now() + 3600_000).toISOString(), expired: false, projectIds: ["p1"], joined: false },
      "crew.join": crew({ membership: "pending", joinCode: "1234-5678" }),
    });
    renderTab();
    fireEvent.change(await screen.findByPlaceholderText("forge-crew1.…"), { target: { value: "forge-crew1.abcdefghijklmnopqrstuvwxyz" } });
    expect(await screen.findByText("Passt zu diesem Projekt (gleiches origin).")).toBeTruthy();
    expect(screen.getByText("Anna")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Beitritt anfragen/ }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.join", { projectId: "p1", code: "forge-crew1.abcdefghijklmnopqrstuvwxyz" }));
  });

  it("shows the check code while waiting to be let in", async () => {
    mockRpc({ "crew.list": [crew({ membership: "pending", joinCode: "4821-0937" })] });
    renderTab();
    expect(await screen.findByText("Warte auf Freigabe")).toBeTruthy();
    expect(screen.getByTestId("crew-join-code").textContent).toBe("4821-0937");
  });

  it("shows members with their agents, the task board and the feed", async () => {
    mockRpc({ "crew.list": [crew()] });
    renderTab();
    expect(await screen.findByText("Shop-Crew")).toBeTruthy();
    expect(screen.getAllByText("Anna").length).toBeGreaterThan(0);
    expect(screen.getByText("API bauen")).toBeTruthy();
    expect(screen.getByText("Baue die REST-API")).toBeTruthy();
    expect(screen.getByText("2 ungepushte Commits")).toBeTruthy();
    expect(within(screen.getByTestId("crew-column-open")).getByText("Login-Seite")).toBeTruthy();
    expect(within(screen.getByTestId("crew-column-in_progress")).getByText("REST-API")).toBeTruthy();
    // finished tasks fold away until asked for
    const done = screen.getByTestId("crew-column-done");
    expect(within(done).queryByText("Projekt aufsetzen")).toBeNull();
    fireEvent.click(within(done).getByRole("button", { expanded: false }));
    expect(within(done).getByText("Projekt aufsetzen")).toBeTruthy();
    expect(screen.getByText("Ich nehme die API")).toBeTruthy();
  });

  it("lets a newcomer in after checking the code", async () => {
    mockRpc({ "crew.list": [crew({ requests: [{ id: "r1", name: "Ben", code: "1111-2222", at: now }] })], "crew.respond": crew() });
    renderTab();
    expect(await screen.findByText("Ben möchte beitreten")).toBeTruthy();
    expect(screen.getByText("1111-2222")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Hereinlassen/ }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.respond", { crewId: "c1", requestId: "r1", accept: true }));
  });

  it("sends a message to the crew", async () => {
    mockRpc({ "crew.list": [crew()], "crew.message": crew().feed[0] });
    renderTab();
    const field = await screen.findByPlaceholderText(/Nachricht an die Crew/);
    fireEvent.change(field, { target: { value: "Ich mache das Frontend" } });
    fireEvent.click(screen.getByRole("button", { name: /^Senden$/ }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.message", { crewId: "c1", text: "Ich mache das Frontend", to: null }));
  });

  it("offers to take over pushed commits", async () => {
    mockRpc({ "crew.list": [crew({ behind: 3 })], "crew.pull": { output: "ok" } });
    renderTab();
    const banner = (await screen.findByText("3 Commits der Crew fehlen in deinem Projekt.")).parentElement!;
    fireEvent.click(within(banner).getByRole("button", { name: /Übernehmen/ }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.pull", { crewId: "c1" }));
  });

  it("starts an agent on an open task", async () => {
    mockRpc({ "crew.list": [crew()], "crew.taskStart": { sessionId: "s1" } });
    renderTab();
    const open = await screen.findByTestId("crew-column-open");
    fireEvent.click(within(open).getByRole("button", { name: /Mit Agent starten/ }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.taskStart", { crewId: "c1", taskId: "t1" }));
    await waitFor(() => expect(useUi.getState().activeSession.p1).toBe("s1"));
  });

  it("asks another member for a session to watch live or to take over", async () => {
    mockRpc({ "crew.list": [crew()], "crew.shareAsk": { id: "x1", agentTitle: "API bauen" } });
    renderTab();
    await screen.findByText("API bauen");
    fireEvent.click(screen.getByRole("button", { name: "Live ansehen" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.shareAsk", { crewId: "c1", memberId: "anna", agentId: "s9", mode: "view" }));
    fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.shareAsk", { crewId: "c1", memberId: "anna", agentId: "s9", mode: "takeover" }));
  });

  it("answers a request for one of our sessions, also for good", async () => {
    const request = { id: "q1", from: "anna", agentId: "s1", agentTitle: "Login bauen", mode: "takeover" as const, at: now };
    mockRpc({ "crew.list": [crew({ shareRequests: [request] })], "crew.shareRespond": crew() });
    renderTab();
    expect(await screen.findByText("Anna möchte deine Session übernehmen")).toBeTruthy();
    expect(screen.getByText("Login bauen")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Immer erlauben" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.shareRespond", { crewId: "c1", requestId: "q1", accept: true, always: true }));
  });

  it("shows how far a requested session got and opens its copy", async () => {
    const shares = [
      { id: "x1", member: "anna", agentId: "s9", agentTitle: "API bauen", mode: "view" as const, state: "live" as const, received: 2, total: 2, sessionId: "m1", projectId: "p1", error: null, at: now },
      { id: "x2", member: "anna", agentId: "s8", agentTitle: "Tests", mode: "takeover" as const, state: "transferring" as const, received: 1, total: 4, sessionId: null, projectId: null, error: null, at: now },
    ];
    mockRpc({ "crew.list": [crew({ shares })], "crew.shareStop": { ok: true } });
    renderTab();
    expect(await screen.findByText(/überträgt 25/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(useUi.getState().activeSession.p1).toBe("m1");
    fireEvent.click(screen.getAllByRole("button", { name: "Beenden" })[0]!);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("crew.shareStop", { crewId: "c1", requestId: expect.any(String) }));
  });
});

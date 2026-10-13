import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentReview } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { useAgentReview } from "@/stores/agent-review";
import { useToasts } from "@/stores/toast";
import { useUi } from "@/stores/ui";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
const closeTerminalsMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@/lib/terminal-registry", () => ({ closeProjectTerminals: (ids: string[]) => closeTerminalsMock(ids) }));

const { AgentReviewDialog } = await import("./AgentReviewDialog");

const review = (over: Partial<AgentReview> = {}): AgentReview => ({
  projectId: "wt",
  rootId: "app",
  rootName: "App",
  branch: "agent/csv-4y6f",
  targetBranch: "main",
  targetPath: "C:\\code\\app",
  sessionId: "s1",
  sessionTitle: "CSV-Export",
  sessionStatus: "idle",
  summary: "CSV-Export in **src/export.ts** gebaut.",
  busy: false,
  commits: [{ hash: "abc1234", subject: "CSV-Export" }],
  ahead: 1,
  behind: 2,
  filesChanged: 3,
  uncommitted: 0,
  mergeBlocker: null,
  ...over,
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AgentReviewDialog />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
  closeTerminalsMock.mockReset();
  useToasts.setState({ toasts: [] });
  useAgentReview.setState({ queue: ["wt"] });
  useUi.setState({ view: "workspace", activeProjectId: "wt", activeSession: {} });
});

describe("AgentReviewDialog", () => {
  it("shows summary and changes, merges and goes back to the main project", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "agents.review") return review();
      if (method === "agents.finish") return { action: "merge", outcome: "merged", branch: "agent/csv-4y6f", targetBranch: "main", commits: 1, files: [], sessionId: null, branchError: null, message: "1 Commit übernommen." };
      throw new Error("unexpected " + method);
    });
    setup();
    expect(await screen.findByText("src/export.ts")).toBeTruthy();
    expect(screen.getByText(/1 Commit\. 3 Dateien geändert\. main hat 2 neue Commits/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Zusammenführen/ }));
    await vi.waitFor(() => expect(useAgentReview.getState().queue).toEqual([]));
    expect(callMock).toHaveBeenCalledWith("agents.finish", { projectId: "wt", action: "merge" });
    expect(closeTerminalsMock).toHaveBeenCalledWith(["wt"]);
    expect(useUi.getState().activeProjectId).toBe("app");
    expect(useToasts.getState().toasts.map((t) => t.title)).toEqual(["Agent zusammengeführt"]);
  });

  it("asks before discarding and blocks merging with a reason", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "agents.review") return review({ mergeBlocker: "Der Agent hat nichts geändert.", ahead: 0, commits: [] });
      if (method === "agents.finish") return { action: "discard", outcome: "discarded", branch: "agent/csv-4y6f", targetBranch: "main", commits: 0, files: [], sessionId: null, branchError: null, message: "Agent verworfen." };
      throw new Error("unexpected " + method);
    });
    setup();
    expect(await screen.findByText("Der Agent hat nichts geändert.")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Zusammenführen/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Verwerfen/ }));
    expect(callMock).not.toHaveBeenCalledWith("agents.finish", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Endgültig verwerfen" }));
    await vi.waitFor(() => expect(callMock).toHaveBeenCalledWith("agents.finish", { projectId: "wt", action: "discard" }));
    await vi.waitFor(() => expect(useAgentReview.getState().queue).toEqual([]));
  });

  it("puts the decision off with Später", async () => {
    callMock.mockImplementation(async () => review());
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Später" }));
    expect(useAgentReview.getState().queue).toEqual([]);
    expect(callMock).not.toHaveBeenCalledWith("agents.finish", expect.anything());
  });
});

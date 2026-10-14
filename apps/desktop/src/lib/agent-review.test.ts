import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { SessionEvent } from "@forge/protocol";
import { useAgentReview } from "@/stores/agent-review";
import { useToasts } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { agentAutoMerged, agentTurnEnded } from "./agent-review";
import { useChatWindows } from "./chat-windows";
import { keys } from "./queries";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const turn = (sessionId: string, over: Record<string, unknown> = {}) =>
  ({ sessionId, seq: 1, ts: "2026-10-13T10:00:00Z", body: { type: "turn.result", isError: false, subtype: "success", text: "Fertig.", ...over } }) as unknown as SessionEvent;

function cache() {
  const qc = new QueryClient();
  qc.setQueryData(keys.projects, [
    { id: "app", parentId: null, tags: [] },
    { id: "wt", parentId: "app", tags: [] },
  ]);
  qc.setQueryData(keys.liveSessions, [
    { id: "main-s", projectId: "app", background: [] },
    { id: "agent-s", projectId: "wt", background: [] },
    { id: "busy-s", projectId: "wt", background: [{ id: "t1" }] },
  ]);
  return qc;
}

describe("agentTurnEnded", () => {
  beforeEach(() => {
    useAgentReview.setState({ queue: [] });
    useUi.setState({ view: "workspace", activeProjectId: "app", activeSession: { app: "main-s" } });
  });

  it("asks about an agent whose turn ended, once", () => {
    const qc = cache();
    agentTurnEnded(qc, turn("agent-s"));
    agentTurnEnded(qc, turn("agent-s"));
    expect(useAgentReview.getState().queue).toEqual(["wt"]);
  });

  it("leaves plain sessions, failed turns, background work and the open chat alone", () => {
    const qc = cache();
    agentTurnEnded(qc, turn("main-s"));
    agentTurnEnded(qc, turn("agent-s", { isError: true, subtype: "error_during_execution" }));
    agentTurnEnded(qc, turn("busy-s"));
    useUi.setState({ activeProjectId: "wt", activeSession: { wt: "agent-s" } });
    agentTurnEnded(qc, turn("agent-s"));
    expect(useAgentReview.getState().queue).toEqual([]);
  });

  it("never opens the dialog by itself with auto-merge: a skipped merge is a notice whose button opens it", () => {
    const qc = cache();
    qc.setQueryData(keys.projects, [
      { id: "app", parentId: null, tags: ["auto-merge"] },
      { id: "wt", parentId: "app", tags: [] },
    ]);
    agentTurnEnded(qc, turn("agent-s"));
    agentAutoMerged({ rootId: "app", worktreeId: "wt", branch: "agent/x", outcome: "merged", message: "Automatisch zusammengeführt: 1 Commit", sessionIds: ["agent-s"] });
    agentAutoMerged({ rootId: "app", worktreeId: "wt", branch: "agent/x", outcome: "conflict", message: "Konflikte", sessionIds: ["agent-s"] });
    expect(useAgentReview.getState().queue).toEqual([]);
    agentAutoMerged({ rootId: "app", worktreeId: "wt", branch: "agent/x", outcome: "skipped", message: "Nicht automatisch zusammengeführt: Tests rot", sessionIds: ["agent-s"] });
    expect(useAgentReview.getState().queue).toEqual([]);
    const notice = useToasts.getState().toasts.find((t) => t.title === "agent/x nicht zusammengeführt");
    expect(notice?.body).toBe("Tests rot");
    notice?.action?.onClick();
    expect(useAgentReview.getState().queue).toEqual(["wt"]);
  });

  it("closes the chat windows of an agent merged automatically, and only then", () => {
    invoke.mockClear();
    useChatWindows.setState({ sessions: ["agent-s", "main-s"] });
    agentAutoMerged({ rootId: "app", worktreeId: "wt", branch: "agent/x", outcome: "waiting", message: "Wartet", sessionIds: ["agent-s"] });
    expect(invoke).not.toHaveBeenCalled();
    agentAutoMerged({ rootId: "app", worktreeId: "wt", branch: "agent/x", outcome: "merged", message: "1 Commit", sessionIds: ["agent-s"] });
    expect(invoke).toHaveBeenCalledWith("close_chat_window", { sessionId: "agent-s" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

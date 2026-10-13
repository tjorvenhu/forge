import type { QueryClient } from "@tanstack/react-query";
import type { ResultOf, SessionEvent } from "@forge/protocol";
import { useAgentReview } from "@/stores/agent-review";
import { useUi } from "@/stores/ui";
import { keys } from "./queries";
import { openSessionId } from "./session-tabs";
import { isInterrupted } from "./working";

/**
 * A turn of a parallel agent ended: ask whether to merge or discard its branch. Not while the user
 * reads that very chat (they talk to the agent and may want more), and not while background work of
 * the agent is still running.
 */
export function agentTurnEnded(qc: QueryClient, ev: SessionEvent) {
  const b = ev.body;
  if (b.type !== "turn.result" || b.isError || isInterrupted(b)) return;
  const session =
    qc.getQueryData<ResultOf<"sessions.get">>(keys.session(ev.sessionId)) ??
    qc.getQueryData<ResultOf<"sessions.listLive">>(keys.liveSessions)?.find((s) => s.id === ev.sessionId);
  if (!session || session.background.length) return;
  const project = qc.getQueryData<ResultOf<"projects.list">>(keys.projects)?.find((p) => p.id === session.projectId);
  if (!project?.parentId) return;
  if (openSessionId(useUi.getState()) === session.id) return;
  useAgentReview.getState().request(project.id);
}

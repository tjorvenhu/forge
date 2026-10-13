import type { QueryClient } from "@tanstack/react-query";
import type { ResultOf, ServerEventPayload, SessionEvent } from "@forge/protocol";
import { useAgentReview } from "@/stores/agent-review";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { keys } from "./queries";
import { openSessionId } from "./session-tabs";
import { isInterrupted } from "./working";

/**
 * A turn of a parallel agent ended: ask whether to merge or discard its branch. Not while the user
 * reads that very chat (they talk to the agent and may want more), not while background work of
 * the agent is still running, and not with auto-merge: the sidecar merges and asks only when it can't.
 */
export function agentTurnEnded(qc: QueryClient, ev: SessionEvent) {
  const b = ev.body;
  if (b.type !== "turn.result" || b.isError || isInterrupted(b)) return;
  const session =
    qc.getQueryData<ResultOf<"sessions.get">>(keys.session(ev.sessionId)) ??
    qc.getQueryData<ResultOf<"sessions.listLive">>(keys.liveSessions)?.find((s) => s.id === ev.sessionId);
  if (!session || session.background.length) return;
  const projects = qc.getQueryData<ResultOf<"projects.list">>(keys.projects);
  const project = projects?.find((p) => p.id === session.projectId);
  if (!project?.parentId) return;
  if (projects?.find((p) => p.id === project.parentId)?.tags.includes("auto-merge")) return;
  if (openSessionId(useUi.getState()) === session.id) return;
  useAgentReview.getState().request(project.id);
}

/**
 * Result of an auto-merge. With auto-merge on, no dialog opens by itself: what FORGE could not merge
 * is a notice whose button opens the dialog.
 */
export function agentAutoMerged(e: ServerEventPayload<"agent.autoMerge">) {
  const title = e.branch ?? "Agent";
  if (e.outcome === "merged") toast.success(`${title} zusammengeführt`, e.message.replace(/^Automatisch zusammengeführt:\s*/, ""));
  else if (e.outcome === "conflict") toast.notify({ tone: "warning", title: `${title}: Konflikte`, body: e.message });
  else {
    toast.notify({
      tone: "warning",
      title: `${title} nicht zusammengeführt`,
      body: e.message.replace(/^Nicht automatisch zusammengeführt:\s*/, ""),
      action: { label: "Ansehen", onClick: () => useAgentReview.getState().request(e.worktreeId) },
    });
  }
}

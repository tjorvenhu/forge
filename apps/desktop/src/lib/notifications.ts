import type { QueryClient } from "@tanstack/react-query";
import type { ResultOf, SessionEvent } from "@forge/protocol";
import { rpc } from "./rpc";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { isInterrupted } from "./working";

export type NotifyKind = "done" | "approval" | "error";

/** Which session events get a sound and a notification; null for all others. */
export function notifyKind(body: SessionEvent["body"]): NotifyKind | null {
  if (body.type === "approval.request" || body.type === "automation.confirm") return "approval";
  if (body.type === "error") return "error";
  if (body.type === "turn.result") {
    if (isInterrupted(body)) return null;
    return body.isError ? "error" : "done";
  }
  return null;
}

const lastNotified = new Map<string, number>();

/**
 * One signal per session and kind within a few seconds: an error event is often followed by a failed
 * turn.result, and importing a terminal session replays many past results at once.
 */
export function shouldNotify(sessionId: string, kind: NotifyKind): boolean {
  const key = `${sessionId}:${kind}`;
  const prev = lastNotified.get(key) ?? 0;
  lastNotified.set(key, Date.now());
  return Date.now() - prev > 3000;
}

/** Shows a notification at the bottom right that leads to the session. */
export async function notifySession(qc: QueryClient, ev: SessionEvent, kind: NotifyKind) {
  const live = qc.getQueryData<ResultOf<"sessions.listLive">>(["liveSessions"])?.find((s) => s.id === ev.sessionId);
  const session = live ?? qc.getQueryData<ResultOf<"sessions.get">>(["session", ev.sessionId]) ?? (await rpc.call("sessions.get", { sessionId: ev.sessionId }).catch(() => null));
  if (!session) return;
  const projectName = live?.projectName ?? qc.getQueryData<ResultOf<"projects.list">>(["projects"])?.find((p) => p.id === session.projectId)?.name;
  const where = [projectName, session.title ?? "Ohne Titel"].filter(Boolean).join(": ");
  const b = ev.body;
  const detail =
    b.type === "approval.request" ? (b.title ?? b.toolName) : b.type === "error" ? b.message : b.type === "turn.result" && b.isError ? (b.text ?? b.subtype) : null;
  const action = { label: "Session öffnen", onClick: () => useUi.getState().openProject(session.projectId, session.id) };
  if (kind === "approval") {
    const tool = b.type === "approval.request" ? b.toolName : "";
    const title =
      b.type === "automation.confirm" ? "Auto-Commit wartet" : tool === "AskUserQuestion" ? "Rückfrage von Claude" : tool === "ExitPlanMode" ? "Plan zur Freigabe" : "Freigabe nötig";
    const text = b.type === "automation.confirm" ? "Mögliche Secrets gefunden. Trotzdem committen?" : tool === "AskUserQuestion" || tool === "ExitPlanMode" ? null : detail;
    toast.notify({ tone: "warning", title, body: [where, text].filter(Boolean).join("\n"), action, duration: 12_000 });
  }
  else if (kind === "error") toast.notify({ tone: "error", title: "Fehler in der Session", body: [where, detail?.slice(0, 300)].filter(Boolean).join("\n"), action });
  else {
    // The session cache is updated synchronously by session.updated; the live list is refetched later.
    const background = (qc.getQueryData<ResultOf<"sessions.get">>(["session", ev.sessionId]) ?? session).background;
    if (background.length) {
      toast.notify({
        tone: "info",
        title: "Durchlauf beendet, Aufgabe läuft weiter",
        body: `${where}\nIm Hintergrund: ${background.map((t) => t.description).join(", ")}. Claude meldet sich, wenn sie fertig ist.`,
        action,
        duration: 8000,
      });
    } else toast.notify({ tone: "success", title: "Claude ist fertig", body: where, action, duration: 6000 });
  }
}

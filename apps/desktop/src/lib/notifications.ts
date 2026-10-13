import type { QueryClient } from "@tanstack/react-query";
import type { ResultOf, SessionEvent } from "@forge/protocol";
import { rpc } from "./rpc";
import { desktopNotify, type NotifyTarget } from "./native";
import { isInterrupted } from "./working";

export type NotifyKind = "done" | "approval" | "error";

/** Which session events get a sound and a notification; null for all others. */
export function notifyKind(body: SessionEvent["body"]): NotifyKind | null {
  if (body.type === "approval.request") return "approval";
  // Claude asked for the user (tool notify): sounds like a decision that waits.
  if (body.type === "notify") return "approval";
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

/**
 * A Windows notification (not inside the app), unless switched off in the settings. The text names
 * project and session; a click on it opens the session (chat_windows.rs).
 */
function notify(qc: QueryClient, title: string, lines: Array<string | null | undefined>, open: NotifyTarget) {
  if (qc.getQueryData<ResultOf<"settings.get">>(["settings"])?.desktopNotifications === false) return;
  void desktopNotify(title, lines.filter(Boolean).join("\n"), open);
}

/** The session of an event with "Projekt: Titel". */
async function sessionContext(qc: QueryClient, sessionId: string) {
  const live = qc.getQueryData<ResultOf<"sessions.listLive">>(["liveSessions"])?.find((s) => s.id === sessionId);
  const session = live ?? qc.getQueryData<ResultOf<"sessions.get">>(["session", sessionId]) ?? (await rpc.call("sessions.get", { sessionId }).catch(() => null));
  if (!session) return null;
  const projectName = live?.projectName ?? qc.getQueryData<ResultOf<"projects.list">>(["projects"])?.find((p) => p.id === session.projectId)?.name;
  const where = [projectName, session.title ?? "Ohne Titel"].filter(Boolean).join(": ");
  return { session, where, open: { projectId: session.projectId, sessionId: session.id } };
}

/** Tells the user that FORGE continued a session after a usage limit, or gave up doing so. */
export async function notifyAutoContinue(qc: QueryClient, ev: SessionEvent) {
  const b = ev.body;
  if (b.type !== "auto_continue" || (b.state !== "resumed" && b.state !== "exhausted" && b.state !== "failed")) return;
  const ctx = await sessionContext(qc, ev.sessionId);
  if (!ctx) return;
  if (b.state === "resumed") notify(qc, "Automatisch fortgesetzt", [ctx.where, "Das Nutzungslimit ist zurückgesetzt, Claude arbeitet weiter."], ctx.open);
  else notify(qc, "Nicht automatisch fortgesetzt", [ctx.where, b.message], ctx.open);
}

/** Windows notification for a finished turn, a needed decision or an error. */
export async function notifySession(qc: QueryClient, ev: SessionEvent, kind: NotifyKind) {
  const ctx = await sessionContext(qc, ev.sessionId);
  if (!ctx) return;
  const { session, where, open } = ctx;
  const b = ev.body;
  const detail =
    b.type === "approval.request" ? (b.title ?? b.toolName) : b.type === "error" ? b.message : b.type === "turn.result" && b.isError ? (b.text ?? b.subtype) : null;
  if (b.type === "notify") {
    notify(qc, b.urgent ? "Claude braucht dich" : "Claude meldet sich", [where, b.message], open);
    return;
  }
  if (kind === "approval") {
    const tool = b.type === "approval.request" ? b.toolName : "";
    const title = tool === "AskUserQuestion" ? "Rückfrage von Claude" : tool === "ExitPlanMode" ? "Plan zur Freigabe" : "Freigabe nötig";
    const text = tool === "AskUserQuestion" || tool === "ExitPlanMode" ? null : detail;
    notify(qc, title, [where, text], open);
  } else if (kind === "error") notify(qc, "Fehler in der Session", [where, detail?.slice(0, 300)], open);
  else {
    // The session cache is updated synchronously by session.updated; the live list is refetched later.
    const background = (qc.getQueryData<ResultOf<"sessions.get">>(["session", ev.sessionId]) ?? session).background;
    if (background.length) {
      notify(qc, "Durchlauf beendet, Aufgabe läuft weiter", [where, `Im Hintergrund: ${background.map((t) => t.description).join(", ")}. Claude meldet sich, wenn sie fertig ist.`], open);
    } else notify(qc, "Claude ist fertig", [where], open);
  }
}

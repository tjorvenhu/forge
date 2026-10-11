import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { EffortLevel, PermissionMode, Project, Session } from "@forge/protocol";
import { call, keys, queryClient, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { NO_OPTIONS, useDrafts, type PendingFile } from "@/stores/drafts";
import { isClearCommand } from "./SlashCommandMenu";

const PROFILE_MODE: Record<Project["profile"], PermissionMode> = { safe: "default", balanced: "acceptEdits", autonomous: "bypassPermissions" };

/**
 * Model, effort and plan mode for the composer. A running session changes them over RPC; for a session
 * that has not started yet they are kept in the draft of the project, so they do not leak to another one.
 */
export function useComposerOptions(project: Project, session: Session | null, draftKey: string) {
  const settings = useSettings();
  const qc = useQueryClient();
  const options = useDrafts((s) => s.drafts[draftKey]?.options ?? NO_OPTIONS);
  const planOnly = options.planOnly ?? project.tags.includes("plan-first");
  const model = session ? session.model : (options.model ?? project.defaultModel ?? settings.data?.defaultModel ?? null);
  const effort = session ? session.effort : (options.effort ?? project.defaultEffort ?? settings.data?.defaultEffort ?? null);
  const isPlan = session ? session.permissionMode === "plan" : planOnly;

  const update = async (run: () => Promise<Session>, errorTitle: string) => {
    try {
      const s = await run();
      qc.setQueryData(keys.session(s.id), s);
    } catch (e) {
      toast.error(errorTitle, errorMessage(e));
    }
  };

  const changeModel = async (next: string | null) => {
    if (!session) return useDrafts.getState().setOptions(draftKey, { model: next });
    if (next) await update(() => call("sessions.setModel", { sessionId: session.id, model: next }), "Modell nicht gewechselt");
  };

  const changeEffort = async (next: EffortLevel | null) => {
    if (!session) return useDrafts.getState().setOptions(draftKey, { effort: next });
    await update(() => call("sessions.setEffort", { sessionId: session.id, effort: next }), "Effort nicht gewechselt");
  };

  const togglePlan = async () => {
    if (!session) return useDrafts.getState().setOptions(draftKey, { planOnly: !planOnly });
    const mode: PermissionMode = isPlan ? PROFILE_MODE[session.profile] : "plan";
    await update(() => call("sessions.setPermissionMode", { sessionId: session.id, mode }), "Modus nicht gewechselt");
  };

  return { model, effort, planOnly, isPlan, changeModel, changeEffort, togglePlan };
}

/** Starts a session or sends into the running one; afterwards drops only what was sent from the draft. */
export function useSendMessage({
  project,
  session,
  draftKey,
  resumeClaudeSessionId,
  options,
}: {
  project: Project;
  session: Session | null;
  draftKey: string;
  resumeClaudeSessionId?: string;
  options: { model: string | null; effort: EffortLevel | null; planOnly: boolean };
}) {
  const qc = useQueryClient();
  const [sending, setSending] = useState(false);

  const send = async (text: string, files: PendingFile[]): Promise<boolean> => {
    if (isClearCommand(text)) {
      clearConversation(project.id, session, draftKey);
      return true;
    }
    const prompt = text.trim() || (files.length ? "Siehe Anhang." : "");
    if (!prompt || sending) return false;
    setSending(true);
    const attachments = files.map((f) => f.attachment);
    try {
      if (!session) {
        const s = await call("sessions.start", { projectId: project.id, prompt, model: options.model, effort: options.effort, planOnly: options.planOnly, resumeClaudeSessionId, attachments });
        qc.setQueryData(keys.session(s.id), s);
        void qc.invalidateQueries({ queryKey: keys.sessions(project.id) });
        // The next new session starts from the project defaults again.
        useDrafts.getState().setOptions(draftKey, { planOnly: undefined, model: undefined, effort: undefined });
        useUi.getState().setActiveSession(project.id, s.id);
      } else {
        const s = await call("sessions.send", { sessionId: session.id, text: prompt, attachments });
        qc.setQueryData(keys.session(s.id), s);
      }
      // Only drop what was sent: with sending allowed mid-turn the user may already be typing the next message.
      const sentIds = new Set(files.map((f) => f.id));
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      const drafts = useDrafts.getState();
      drafts.updateFiles(draftKey, (cur) => cur.filter((f) => !sentIds.has(f.id)));
      if ((drafts.drafts[draftKey]?.text ?? "") === text) drafts.setText(draftKey, "");
      return true;
    } catch (e) {
      toast.error("Nachricht nicht gesendet", errorMessage(e));
      return false;
    } finally {
      setSending(false);
    }
  };

  return { send, sending };
}

/**
 * /clear like in the terminal: the chat starts over as a new, empty session. The previous session stays in
 * the list and can be continued; an idle Claude process is ended, a working one keeps running.
 */
export function clearConversation(projectId: string, session: Session | null, draftKey: string) {
  useDrafts.getState().setText(draftKey, "");
  useUi.getState().setActiveSession(projectId, null);
  if (session?.live && (session.status === "idle" || session.status === "error")) {
    void call("sessions.close", { sessionId: session.id }).catch((e: unknown) => toast.error("Claude-Prozess nicht beendet", errorMessage(e)));
  }
}

export async function compactSession(sessionId: string) {
  try {
    queryClient.setQueryData(keys.session(sessionId), await call("sessions.send", { sessionId, text: "/compact", attachments: [] }));
  } catch (e) {
    toast.error("Komprimieren fehlgeschlagen", errorMessage(e));
  }
}

export async function stopSession(sessionId: string) {
  try {
    await call("sessions.stop", { sessionId });
  } catch (e) {
    toast.error("Stop fehlgeschlagen", errorMessage(e));
  }
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MAX_PROMPT_CHARS, type EffortLevel, type PermissionMode, type Project, type Session } from "@forge/protocol";
import { call, keys, queryClient, useSettings } from "@/lib/queries";
import { uploadFile } from "@/lib/attachments";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { NO_OPTIONS, useDrafts, type PendingFile } from "@/stores/drafts";
import { usePendingMessages } from "@/stores/pending-messages";
import { useSessionEvents } from "@/stores/session-events";
import { isClearCommand } from "./SlashCommandMenu";
import { focusComposer, MAIN_SLOT, type ChatSlot } from "./chat-slot";
import { t } from "@/i18n";

export const PROFILE_MODE: Record<Project["profile"], PermissionMode> = { safe: "default", balanced: "acceptEdits", autonomous: "bypassPermissions" };

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

  /** Shows the change right away (`optimistic`), sends it, and goes back if the session refused it. */
  const update = async (optimistic: Partial<Session>, run: () => Promise<Session>, errorTitle: string) => {
    const key = keys.session(session!.id);
    const before = qc.getQueryData<Session>(key);
    if (before) qc.setQueryData(key, { ...before, ...optimistic });
    try {
      const s = await run();
      qc.setQueryData(keys.session(s.id), s);
    } catch (e) {
      if (before) qc.setQueryData(key, before);
      toast.error(errorTitle, errorMessage(e));
    }
  };

  const changeModel = async (next: string | null) => {
    if (!session) return useDrafts.getState().setOptions(draftKey, { model: next });
    if (next) await update({ model: next }, () => call("sessions.setModel", { sessionId: session.id, model: next }), t.chat.send.modelNotChanged);
  };

  const changeEffort = async (next: EffortLevel | null) => {
    if (!session) return useDrafts.getState().setOptions(draftKey, { effort: next });
    await update({ effort: next }, () => call("sessions.setEffort", { sessionId: session.id, effort: next }), t.chat.send.effortNotChanged);
  };

  const togglePlan = async () => {
    if (!session) return useDrafts.getState().setOptions(draftKey, { planOnly: !planOnly });
    const mode: PermissionMode = isPlan ? PROFILE_MODE[session.profile] : "plan";
    await update({ permissionMode: mode }, () => call("sessions.setPermissionMode", { sessionId: session.id, mode }), t.chat.send.modeNotChanged);
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
  slot = MAIN_SLOT,
}: {
  project: Project;
  session: Session | null;
  draftKey: string;
  resumeClaudeSessionId?: string;
  options: { model: string | null; effort: EffortLevel | null; planOnly: boolean };
  /** the chat the composer sits in; a started session opens there */
  slot?: ChatSlot;
}) {
  const qc = useQueryClient();
  const [sending, setSending] = useState(false);

  const send = async (text: string, files: PendingFile[]): Promise<boolean> => {
    if (isClearCommand(text)) {
      clearConversation(project.id, session, draftKey, slot);
      return true;
    }
    let prompt = text.trim() || (files.length ? t.chat.send.seeAttachment : "");
    if (!prompt || sending) return false;
    setSending(true);
    const attachments = files.map((f) => f.attachment);
    if (prompt.length > MAX_PROMPT_CHARS) {
      // Beyond what one protocol line takes: the text goes as a file, Claude reads it from there.
      try {
        attachments.push({ kind: "path", path: await uploadFile(new Blob([prompt], { type: "text/plain" }), t.chat.send.longMessageFile) });
        prompt = t.chat.send.longMessagePrompt(t.chat.send.longMessageFile);
      } catch (e) {
        setSending(false);
        toast.error(t.chat.task.messageNotSent, errorMessage(e));
        return false;
      }
    }
    // Shown in the chat at once and the composer empties; the real message replaces it when it arrives.
    // Slash commands are not echoed as messages, so they get no placeholder.
    const pendingKey = session?.id ?? draftKey;
    const pendingId = prompt.startsWith("/")
      ? null
      : usePendingMessages.getState().add(pendingKey, {
          text: prompt,
          files: files.map((f) => f.name),
          afterSeq: session ? (useSessionEvents.getState().buffers[session.id]?.lastSeq ?? 0) : 0,
        });
    if ((useDrafts.getState().drafts[draftKey]?.text ?? "") === text) useDrafts.getState().setText(draftKey, "");
    try {
      if (!session) {
        const s = await call("sessions.start", { projectId: project.id, prompt, model: options.model, effort: options.effort, planOnly: options.planOnly, resumeClaudeSessionId, attachments });
        qc.setQueryData(keys.session(s.id), s);
        void qc.invalidateQueries({ queryKey: keys.sessions(project.id) });
        // The next new session starts from the project defaults again.
        useDrafts.getState().setOptions(draftKey, { planOnly: undefined, model: undefined, effort: undefined });
        usePendingMessages.getState().move(draftKey, s.id);
        slot.select(project.id, s.id);
      } else {
        const s = await call("sessions.send", { sessionId: session.id, text: prompt, attachments });
        qc.setQueryData(keys.session(s.id), s);
      }
      // Only drop what was sent: with sending allowed mid-turn the user may already be typing the next message.
      const sentIds = new Set(files.map((f) => f.id));
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      useDrafts.getState().updateFiles(draftKey, (cur) => cur.filter((f) => !sentIds.has(f.id)));
      return true;
    } catch (e) {
      if (pendingId !== null) usePendingMessages.getState().remove(pendingKey, pendingId);
      // The text comes back, unless the user started typing something new meanwhile.
      if (!(useDrafts.getState().drafts[draftKey]?.text ?? "")) useDrafts.getState().setText(draftKey, text);
      toast.error(t.chat.task.messageNotSent, errorMessage(e));
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
export function clearConversation(projectId: string, session: Session | null, draftKey: string, slot: ChatSlot = MAIN_SLOT) {
  useDrafts.getState().setText(draftKey, "");
  slot.select(projectId, null);
  // The new chat mounts a fresh composer, so the focus of the old one is gone.
  requestAnimationFrame(() => focusComposer(slot));
  if (session?.live && (session.status === "idle" || session.status === "error")) {
    void call("sessions.close", { sessionId: session.id }).catch((e: unknown) => toast.error(t.chat.send.processNotClosed, errorMessage(e)));
  }
}

export async function compactSession(sessionId: string) {
  try {
    queryClient.setQueryData(keys.session(sessionId), await call("sessions.send", { sessionId, text: "/compact", attachments: [] }));
  } catch (e) {
    toast.error(t.chat.send.compactFailed, errorMessage(e));
  }
}

/** "Claude stoppt …" shows on the click; the sidecar's status follows. */
export async function stopSession(sessionId: string) {
  const key = keys.session(sessionId);
  const before = queryClient.getQueryData<Session>(key);
  const busy = !!before && (before.status === "running" || before.status === "waiting_approval" || before.status === "starting");
  if (busy) queryClient.setQueryData(key, { ...before, status: "stopping" as const });
  try {
    await call("sessions.stop", { sessionId });
    if (busy) toast.notify({ tone: "stopped", title: t.chat.send.stopped, body: t.chat.send.stoppedDetail });
  } catch (e) {
    const now = queryClient.getQueryData<Session>(key);
    if (before && now?.status === "stopping") queryClient.setQueryData(key, before);
    toast.error(t.chat.send.stopFailed, errorMessage(e));
  }
}

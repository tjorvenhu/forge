import { create } from "zustand";
import type { Attachment, EffortLevel } from "@forge/protocol";
import { splitActive } from "./ui";

export interface PendingFile {
  id: string;
  name: string;
  attachment: Attachment;
  /** object URL for pasted images */
  preview: string | null;
  isImage: boolean;
}

/** Choices for a session that has not started yet; undefined means "not picked", so project defaults apply. */
export interface DraftOptions {
  planOnly?: boolean;
  model?: string | null;
  effort?: EffortLevel | null;
}

interface Draft {
  text: string;
  files: PendingFile[];
  options: DraftOptions;
}

interface DraftState {
  drafts: Record<string, Draft>;
  setText: (key: string, text: string) => void;
  updateFiles: (key: string, fn: (cur: PendingFile[]) => PendingFile[]) => void;
  setOptions: (key: string, patch: DraftOptions) => void;
  clear: (key: string) => void;
}

const EMPTY: Draft = { text: "", files: [], options: {} };

/**
 * Draft key of the composer: the session id, or the project plus the terminal session to adopt. A new
 * session in a split pane (`pane`) has its own draft, apart from one in the main chat of the same project.
 */
export function draftKey(projectId: string, sessionId: string | null, resumeClaudeSessionId?: string, pane?: string | null): string {
  return sessionId ?? `new:${projectId}:${resumeClaudeSessionId ?? ""}${pane ? `:${pane}` : ""}`;
}

/** Draft key of whatever the chat of a project currently shows (activeSession value of the UI store). */
export function activeDraftKey(projectId: string, active: string | null | undefined): string {
  const { sessionId, externalId } = splitActive(active);
  return draftKey(projectId, sessionId, externalId ?? undefined);
}

export const NO_FILES: PendingFile[] = [];
export const NO_OPTIONS: DraftOptions = {};

/** Unsent composer input per session, so switching sessions does not lose it. Kept in memory only. */
export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  setText: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? EMPTY), text } } })),
  updateFiles: (key, fn) =>
    set((s) => {
      const cur = s.drafts[key] ?? EMPTY;
      return { drafts: { ...s.drafts, [key]: { ...cur, files: fn(cur.files) } } };
    }),
  setOptions: (key, patch) =>
    set((s) => {
      const cur = s.drafts[key] ?? EMPTY;
      return { drafts: { ...s.drafts, [key]: { ...cur, options: { ...cur.options, ...patch } } } };
    }),
  clear: (key) =>
    set((s) => {
      const next = { ...s.drafts };
      delete next[key];
      return { drafts: next };
    }),
}));

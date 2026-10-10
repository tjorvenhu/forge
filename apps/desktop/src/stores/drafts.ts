import { create } from "zustand";
import type { Attachment } from "@forge/protocol";

export interface PendingFile {
  id: string;
  name: string;
  attachment: Attachment;
  /** object URL for pasted images */
  preview: string | null;
  isImage: boolean;
}

interface Draft {
  text: string;
  files: PendingFile[];
}

interface DraftState {
  drafts: Record<string, Draft>;
  setText: (key: string, text: string) => void;
  updateFiles: (key: string, fn: (cur: PendingFile[]) => PendingFile[]) => void;
  clear: (key: string) => void;
}

const EMPTY: Draft = { text: "", files: [] };
export const NO_FILES: PendingFile[] = [];

/** Unsent composer input per session, so switching sessions does not lose it. Kept in memory only. */
export const useDrafts = create<DraftState>((set) => ({
  drafts: {},
  setText: (key, text) => set((s) => ({ drafts: { ...s.drafts, [key]: { ...(s.drafts[key] ?? EMPTY), text } } })),
  updateFiles: (key, fn) =>
    set((s) => {
      const cur = s.drafts[key] ?? EMPTY;
      return { drafts: { ...s.drafts, [key]: { ...cur, files: fn(cur.files) } } };
    }),
  clear: (key) =>
    set((s) => {
      const next = { ...s.drafts };
      delete next[key];
      return { drafts: next };
    }),
}));

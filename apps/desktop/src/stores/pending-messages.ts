import { create } from "zustand";
import type { SessionEvent } from "@forge/protocol";

/**
 * A message the user just sent, shown in the chat right away instead of after the round trip to the
 * sidecar. It disappears once the real user.message event is in the session buffer.
 */
export interface PendingMessage {
  id: number;
  text: string;
  files: string[];
  /** last seq of the buffer when it was sent; the real event comes after it */
  afterSeq: number;
  sentAt: number;
}

interface PendingState {
  /** keyed by session id, or by the draft key of a session that is being started */
  pending: Record<string, PendingMessage[]>;
  add: (key: string, msg: Omit<PendingMessage, "id" | "sentAt">) => number;
  remove: (key: string, id: number) => void;
  /** a started session got its id: its pending message moves over */
  move: (from: string, to: string) => void;
  /** drops what the buffer now has as real events (same text, after the recorded seq), and very old ones */
  settle: (key: string, events: readonly SessionEvent[]) => void;
}

/** Held back messages (sent while Claude works) can take a while; after this they are dropped anyway. */
export const PENDING_MAX_AGE_MS = 10 * 60_000;

let nextId = 1;
const norm = (t: string) => t.replace(/\s+/g, " ").trim();

export const usePendingMessages = create<PendingState>((set, get) => ({
  pending: {},
  add: (key, msg) => {
    const id = nextId++;
    set((s) => ({ pending: { ...s.pending, [key]: [...(s.pending[key] ?? []), { ...msg, id, sentAt: Date.now() }] } }));
    return id;
  },
  remove: (key, id) =>
    set((s) => {
      const list = (s.pending[key] ?? []).filter((m) => m.id !== id);
      const pending = { ...s.pending };
      if (list.length) pending[key] = list;
      else delete pending[key];
      return { pending };
    }),
  move: (from, to) =>
    set((s) => {
      const moving = s.pending[from];
      if (!moving?.length) return s;
      const pending = { ...s.pending };
      delete pending[from];
      pending[to] = [...(pending[to] ?? []), ...moving.map((m) => ({ ...m, afterSeq: 0 }))];
      return { pending };
    }),
  settle: (key, events) => {
    const list = get().pending[key];
    if (!list?.length) return;
    const now = Date.now();
    const used = new Set<number>();
    const keep = list.filter((m) => {
      if (now - m.sentAt > PENDING_MAX_AGE_MS) return false;
      const hit = events.find((e) => e.seq > m.afterSeq && !used.has(e.seq) && e.body.type === "user.message" && norm(e.body.text) === norm(m.text));
      if (!hit) return true;
      used.add(hit.seq);
      return false;
    });
    if (keep.length === list.length) return;
    set((s) => {
      const pending = { ...s.pending };
      if (keep.length) pending[key] = keep;
      else delete pending[key];
      return { pending };
    });
  },
}));

const NONE: PendingMessage[] = [];
export const usePending = (key: string | null) => usePendingMessages((s) => (key ? (s.pending[key] ?? NONE) : NONE));

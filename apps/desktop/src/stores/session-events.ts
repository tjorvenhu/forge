import { create } from "zustand";
import type { SessionEvent } from "@forge/protocol";
import { useCardStore } from "./card-state";

/** Page size of sessions.events; mirrors EVENT_PAGE_LIMIT in the sidecar. */
export const EVENT_PAGE_SIZE = 20_000;

/**
 * Whether persisted events older than this page exist. A short page is the whole rest of the log;
 * seqs start at 1 and have no gaps, so a full page starting at 1 is complete as well.
 */
export function pageHasOlder(page: readonly SessionEvent[]): boolean {
  return page.length >= EVENT_PAGE_SIZE && page[0]!.seq > 1;
}

function mergeBySeq(a: readonly SessionEvent[], b: readonly SessionEvent[]): SessionEvent[] {
  const bySeq = new Map<number, SessionEvent>();
  for (const e of a) bySeq.set(e.seq, e);
  for (const e of b) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((x, y) => x.seq - y.seq);
}

export interface SessionBuffer {
  loaded: boolean;
  events: SessionEvent[];
  lastSeq: number;
  /** the history is loaded newest first in pages; true while older pages are still in the database */
  hasOlder: boolean;
  /** live text deltas keyed by `${messageId}:${index}`, dropped once the final text arrives */
  streaming: Record<string, string>;
  /** last time the buffer was loaded or received an event, for evicting old ones */
  usedAt: number;
}

interface SessionEventsState {
  buffers: Record<string, SessionBuffer>;
  /** the newest page of the persisted history */
  setHistory: (sessionId: string, events: SessionEvent[]) => void;
  /** a page loaded with beforeSeq = the oldest seq in the buffer; ignored while the buffer is not loaded */
  prependOlder: (sessionId: string, events: SessionEvent[]) => void;
  apply: (ev: SessionEvent) => void;
  /** forgets one session, e.g. after it was deleted */
  drop: (sessionId: string) => void;
  /** keeps the buffers in `keep` and at most `max` of the others, most recently used first */
  evict: (keep: ReadonlySet<string>, max: number) => void;
  /** after a sidecar restart: events may have been missed, so every buffer reloads its history */
  markAllStale: () => void;
}

const empty = (): SessionBuffer => ({ loaded: false, events: [], lastSeq: 0, hasOlder: false, streaming: {}, usedAt: Date.now() });

export const useSessionEvents = create<SessionEventsState>((set, get) => ({
  buffers: {},
  setHistory: (sessionId, events) =>
    set((s) => {
      const cur = s.buffers[sessionId] ?? empty();
      // Live events may have arrived while history was loading, and a reload after a sidecar
      // restart finds older pages the user already loaded; merge by seq.
      const first = events[0]?.seq ?? Infinity;
      let older = cur.events.filter((e) => e.seq < first);
      // More than a page was missed: the kept events would leave a hole, so page them in again.
      if (older.length && pageHasOlder(events) && older.at(-1)!.seq + 1 < first) older = [];
      const merged = mergeBySeq(older.concat(events), cur.events.filter((e) => e.seq >= first));
      return {
        buffers: {
          ...s.buffers,
          [sessionId]: {
            ...cur,
            loaded: true,
            events: merged,
            lastSeq: merged.at(-1)?.seq ?? 0,
            hasOlder: older.length ? cur.hasOlder : pageHasOlder(events),
            usedAt: Date.now(),
          },
        },
      };
    }),
  prependOlder: (sessionId, events) =>
    set((s) => {
      const cur = s.buffers[sessionId];
      if (!cur?.loaded) return s;
      const merged = mergeBySeq(events, cur.events);
      return {
        buffers: {
          ...s.buffers,
          [sessionId]: { ...cur, events: merged, lastSeq: Math.max(cur.lastSeq, merged.at(-1)?.seq ?? 0), hasOlder: pageHasOlder(events), usedAt: Date.now() },
        },
      };
    }),
  apply: (ev) =>
    set((s) => {
      const cur = s.buffers[ev.sessionId] ?? empty();
      const b = ev.body;
      if (b.type === "assistant.delta") {
        const key = `${b.messageId}:${b.index}`;
        return {
          buffers: { ...s.buffers, [ev.sessionId]: { ...cur, streaming: { ...cur.streaming, [key]: (cur.streaming[key] ?? "") + b.text } } },
        };
      }
      if (ev.seq <= cur.lastSeq) return s;
      let streaming = cur.streaming;
      if (b.type === "assistant.text") {
        const key = `${b.messageId}:${b.index}`;
        if (key in streaming) {
          streaming = { ...streaming };
          delete streaming[key];
        }
      }
      if (b.type === "turn.result") streaming = {};
      return {
        buffers: { ...s.buffers, [ev.sessionId]: { ...cur, events: [...cur.events, ev], lastSeq: ev.seq, streaming, usedAt: Date.now() } },
      };
    }),
  drop: (sessionId) => {
    useCardStore.getState().dropSession(sessionId);
    set((s) => {
      if (!(sessionId in s.buffers)) return s;
      const buffers = { ...s.buffers };
      delete buffers[sessionId];
      return { buffers };
    });
  },
  evict: (keep, max) => {
    const others = Object.entries(get().buffers)
      .filter(([id]) => !keep.has(id))
      .sort(([, a], [, b]) => b.usedAt - a.usedAt);
    for (const [id] of others.slice(max)) get().drop(id);
  },
  markAllStale: () =>
    set((s) => ({
      buffers: Object.fromEntries(Object.entries(s.buffers).map(([id, b]) => [id, { ...b, loaded: false, streaming: {} }])),
    })),
}));

/**
 * Pages older history into a loaded buffer: one page, or with `untilSeq` as many as it takes until
 * that seq is covered. Resolves false when the buffer is gone or no older pages are left before
 * that point; fetch errors propagate.
 */
export async function loadOlderPages(
  sessionId: string,
  fetchPage: (beforeSeq: number) => Promise<SessionEvent[]>,
  opts: { untilSeq?: number; beforeApply?: () => void } = {},
): Promise<boolean> {
  const { untilSeq, beforeApply } = opts;
  do {
    const b = useSessionEvents.getState().buffers[sessionId];
    const oldest = b?.loaded ? b.events[0] : undefined;
    if (untilSeq !== undefined && oldest && oldest.seq <= untilSeq) return true;
    if (!oldest || !b?.hasOlder) return false;
    const page = await fetchPage(oldest.seq);
    beforeApply?.();
    useSessionEvents.getState().prependOlder(sessionId, page);
    if (!page.length) return false;
  } while (untilSeq !== undefined);
  return true;
}

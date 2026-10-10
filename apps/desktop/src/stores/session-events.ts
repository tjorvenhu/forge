import { create } from "zustand";
import type { SessionEvent } from "@forge/protocol";

interface SessionBuffer {
  loaded: boolean;
  events: SessionEvent[];
  lastSeq: number;
  /** live text deltas keyed by `${messageId}:${index}`, dropped once the final text arrives */
  streaming: Record<string, string>;
}

interface SessionEventsState {
  buffers: Record<string, SessionBuffer>;
  setHistory: (sessionId: string, events: SessionEvent[]) => void;
  apply: (ev: SessionEvent) => void;
}

const empty = (): SessionBuffer => ({ loaded: false, events: [], lastSeq: 0, streaming: {} });

export const useSessionEvents = create<SessionEventsState>((set) => ({
  buffers: {},
  setHistory: (sessionId, events) =>
    set((s) => {
      const cur = s.buffers[sessionId] ?? empty();
      // Live events may have arrived while history was loading; merge by seq.
      const bySeq = new Map<number, SessionEvent>();
      for (const e of [...events, ...cur.events]) bySeq.set(e.seq, e);
      const merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
      return {
        buffers: {
          ...s.buffers,
          [sessionId]: { ...cur, loaded: true, events: merged, lastSeq: merged.at(-1)?.seq ?? 0 },
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
        buffers: { ...s.buffers, [ev.sessionId]: { ...cur, events: [...cur.events, ev], lastSeq: ev.seq, streaming } },
      };
    }),
}));

import { create } from "zustand";
import { useSessionEvents } from "./session-events";

interface MessageEditState {
  /** the prompt being edited in the chat, one at a time */
  target: { sessionId: string; seq: number } | null;
  start: (sessionId: string, seq: number) => void;
  stop: () => void;
}

export const useMessageEdit = create<MessageEditState>((set) => ({
  target: null,
  start: (sessionId, seq) => set({ target: { sessionId, seq } }),
  stop: () => set({ target: null }),
}));

/** Seq of the session's last prompt the user can edit (typed in FORGE or the Claude app), from the loaded events. */
export function lastEditablePrompt(sessionId: string): number | null {
  const events = useSessionEvents.getState().buffers[sessionId]?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const b = events[i]!.body;
    // A message to a background task is not editable: it would go again without the note naming the task.
    if (b.type === "user.message" && b.uuid && b.source !== "auto" && !b.task && !b.text.trimStart().startsWith("<")) return events[i]!.seq;
  }
  return null;
}

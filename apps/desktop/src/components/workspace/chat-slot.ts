import { createContext, useContext } from "react";
import { useUi } from "@/stores/ui";

/**
 * Which chat a component sits in: the main chat of the workspace (`pane` null) or a split pane. Starting,
 * forking or clearing a session changes the session of this chat, not the main one.
 */
export interface ChatSlot {
  pane: string | null;
  /** shows another session in this chat; null starts a new one */
  select: (projectId: string, active: string | null) => void;
}

export const MAIN_SLOT: ChatSlot = { pane: null, select: (projectId, active) => useUi.getState().setActiveSession(projectId, active) };

export const ChatSlotContext = createContext<ChatSlot>(MAIN_SLOT);

export const useChatSlot = () => useContext(ChatSlotContext);

/** The split view around the chats of the workspace; null in a chat window. */
export interface SplitLayout {
  /** chats on screen, the main one included */
  shown: number;
  /** how many chats the area holds at its current size */
  capacity: number;
}

export const SplitLayoutContext = createContext<SplitLayout | null>(null);

export const useSplitLayout = () => useContext(SplitLayoutContext);

/** Id of the composer field; only the main chat has it, keyboard shortcuts and "Neue Session" focus that one. */
export const composerInputId = (slot: ChatSlot) => (slot.pane ? undefined : "composer-input");

export function focusComposer(slot: ChatSlot) {
  const el = slot.pane ? document.querySelector<HTMLElement>(`[data-split-pane="${slot.pane}"] [data-composer]`) : document.getElementById("composer-input");
  el?.focus();
}

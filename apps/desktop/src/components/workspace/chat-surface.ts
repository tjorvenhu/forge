import { createContext, useContext } from "react";

/** The chat panel's root element; dialogs of the chat (e.g. /usage) open over it, not over the whole window. */
export const ChatSurface = createContext<HTMLElement | null>(null);

export const useChatSurface = () => useContext(ChatSurface);

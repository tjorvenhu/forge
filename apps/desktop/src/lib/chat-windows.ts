import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { draftKey, useDrafts } from "@/stores/drafts";
import { splitActive, useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { errorMessage, isTauri } from "./rpc";

/**
 * Session chats in their own windows. The shell (chat_windows.rs) owns the list of open chat
 * windows and broadcasts it; every window keeps a copy here.
 */

/** What a chat window shows; set by the shell before the page loads. */
export interface ChatWindowTarget {
  projectId: string;
  sessionId: string | null;
  draft?: string | null;
}

const CHANGED = "chat-windows://changed";
const REATTACH = "chat-windows://reattach";
/** Main window to a chat window: come back, and bring the draft along. */
const RECALL = "chat-windows://recall";
/** A chat window that does not answer a recall (hung webview) is closed after this. */
const RECALL_FALLBACK_MS = 1500;

export function parseChatWindowTarget(raw: unknown): ChatWindowTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== "string" || !r.projectId) return null;
  const sessionId = typeof r.sessionId === "string" && r.sessionId ? r.sessionId : null;
  const draft = typeof r.draft === "string" ? r.draft : null;
  return { projectId: r.projectId, sessionId, draft };
}

let target: ChatWindowTarget | null | undefined;

/** The chat this window was opened for; null in the main window. */
export function chatWindowTarget(): ChatWindowTarget | null {
  target ??= typeof window === "undefined" ? null : parseChatWindowTarget((window as { __FORGE_CHAT__?: unknown }).__FORGE_CHAT__);
  return target;
}

export const isChatWindow = () => chatWindowTarget() !== null;

/** Ids of the sessions shown in chat windows. */
export const useChatWindows = create<{ sessions: readonly string[] }>(() => ({ sessions: [] }));

export function useInChatWindow(sessionId: string | null): boolean {
  return useChatWindows((s) => !!sessionId && s.sessions.includes(sessionId));
}

/** Opens the session in its own window, or brings its window to the front. The draft moves along. */
export async function openChatWindow(projectId: string, sessionId: string, title: string | null, opts: { drag?: boolean } = {}) {
  const key = draftKey(projectId, sessionId);
  const draft = useDrafts.getState().drafts[key]?.text || null;
  try {
    // drag: torn off by dragging; the window opens under the cursor and follows it until the button is released.
    await invoke("open_chat_window", { target: { projectId, sessionId, draft }, title: title ?? "Ohne Titel", position: null, drag: opts.drag === true });
    // The window owns the draft from now on; it comes back with "Zurückholen".
    if (draft) useDrafts.getState().setText(key, "");
  } catch (e) {
    toast.error("Fenster nicht geöffnet", errorMessage(e));
  }
}

/** Main window: asks the chat window of the session to come back; closes it if it does not answer. */
export function recallChatWindow(sessionId: string) {
  void emit(RECALL, sessionId);
  setTimeout(() => {
    if (useChatWindows.getState().sessions.includes(sessionId)) void invoke("close_chat_window", { sessionId }).catch(() => {});
  }, RECALL_FALLBACK_MS);
}

/** Chat window: the main window shows this chat again (with the unsent text) and this window closes. */
export async function reattachChatWindow() {
  const t = chatWindowTarget();
  if (!t) return;
  const { sessionId } = splitActive(useUi.getState().activeSession[t.projectId]);
  const draft = useDrafts.getState().drafts[draftKey(t.projectId, sessionId)]?.text || null;
  try {
    await invoke("reattach_chat_window", { target: { projectId: t.projectId, sessionId, draft } });
  } catch (e) {
    toast.error("Nicht zurückgeholt", errorMessage(e));
  }
}

/** Chat window: tells the shell which session it shows now (fork, /clear) and under which title. */
export function reportChatWindow(sessionId: string | null, title: string) {
  if (!isTauri()) return;
  void invoke("update_chat_window", { sessionId, title }).catch(() => {});
}

/** Puts a chat window's UI store on its chat before the first render. */
export function prepareChatWindowUi(t: ChatWindowTarget) {
  useUi.setState((s) => ({
    view: "workspace",
    activeProjectId: t.projectId,
    workspaceTab: "chat",
    activeSession: { ...s.activeSession, [t.projectId]: t.sessionId },
  }));
  if (t.draft) useDrafts.getState().setText(draftKey(t.projectId, t.sessionId), t.draft);
}

/** Applies a chat that came back from its window to the main window. */
export function applyReattach(t: ChatWindowTarget) {
  useUi.getState().openProject(t.projectId, t.sessionId);
  // Also when empty: the text may have been sent from the chat window meanwhile.
  useDrafts.getState().setText(draftKey(t.projectId, t.sessionId), t.draft ?? "");
}

/** Every window: keeps the list of chat windows current. The main window also takes chats back. */
export async function startChatWindowTracking() {
  if (!isTauri()) return;
  await listen<string[]>(CHANGED, (e) => useChatWindows.setState({ sessions: e.payload }));
  if (isChatWindow()) {
    await listen<string>(RECALL, (e) => {
      const t = chatWindowTarget()!;
      if (splitActive(useUi.getState().activeSession[t.projectId]).sessionId === e.payload) void reattachChatWindow();
    });
  } else {
    await listen<unknown>(REATTACH, (e) => {
      const t = parseChatWindowTarget(e.payload);
      if (t) applyReattach(t);
    });
  }
  useChatWindows.setState({ sessions: await invoke<string[]>("chat_windows") });
}

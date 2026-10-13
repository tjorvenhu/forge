import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Attachment } from "@forge/protocol";
import { draftKey, useDrafts, type PendingFile } from "@/stores/drafts";
import { splitActive, useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { errorMessage, isTauri } from "./rpc";

/**
 * Session chats in their own windows. The shell (chat_windows.rs) owns the list of open chat
 * windows and broadcasts it; every window keeps a copy here.
 */

/** An attachment of the draft on its way to another window. */
export interface ChatWindowFile {
  name: string;
  isImage: boolean;
  attachment: Attachment;
}

/** What a chat window shows; set by the shell before the page loads. */
export interface ChatWindowTarget {
  projectId: string;
  sessionId: string | null;
  draft?: string | null;
  files?: ChatWindowFile[];
}

const MAIN = "main";
const CHANGED = "chat-windows://changed";
const REATTACH = "chat-windows://reattach";
/** Shell to the main window: open this session (its Windows notification was clicked). */
const OPEN_SESSION = "chat-windows://open-session";
/** Main window to a chat window: come back, and bring the draft along. */
const RECALL = "chat-windows://recall";
/** Chat window to the main window: show this file of the project (a path clicked in its chat). */
const OPEN_FILE = "chat-windows://open-file";

interface FileTarget {
  projectId: string;
  path: string;
  line: number | null;
}

function parseFileTarget(raw: unknown): FileTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== "string" || typeof r.path !== "string" || !r.path) return null;
  return { projectId: r.projectId, path: r.path, line: typeof r.line === "number" && r.line > 0 ? r.line : null };
}

/** Chat window: the main window opens the file in its Files tab and comes to the front; a chat window has no Files tab. */
export async function openFileInMain(projectId: string, path: string, line: number | null) {
  try {
    await emitTo(MAIN, OPEN_FILE, { projectId, path, line } satisfies FileTarget);
    await invoke("show_main_window");
  } catch (e) {
    toast.error("Datei nicht geöffnet", errorMessage(e));
  }
}
/** A chat window that does not answer a recall (hung webview) is closed after this. */
const RECALL_FALLBACK_MS = 1500;

function parseFiles(raw: unknown): ChatWindowFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f: unknown) => {
    if (!f || typeof f !== "object") return [];
    const r = f as Record<string, unknown>;
    const a = Attachment.safeParse(r.attachment);
    return typeof r.name === "string" && a.success ? [{ name: r.name, isImage: r.isImage === true, attachment: a.data }] : [];
  });
}

export function parseChatWindowTarget(raw: unknown): ChatWindowTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.projectId !== "string" || !r.projectId) return null;
  const sessionId = typeof r.sessionId === "string" && r.sessionId ? r.sessionId : null;
  const draft = typeof r.draft === "string" ? r.draft : null;
  return { projectId: r.projectId, sessionId, draft, files: parseFiles(r.files) };
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

interface MovingDraft {
  text: string;
  files: PendingFile[];
}

/**
 * Takes text and attachments out of this window's draft before they travel: whatever stayed behind
 * would come back as an old copy once the chat returns.
 */
function takeDraft(key: string): MovingDraft {
  const d = useDrafts.getState().drafts[key];
  const taken = { text: d?.text ?? "", files: d?.files ?? [] };
  useDrafts.getState().setText(key, "");
  useDrafts.getState().updateFiles(key, () => []);
  return taken;
}

function putBack(key: string, d: MovingDraft) {
  useDrafts.getState().setText(key, d.text);
  useDrafts.getState().updateFiles(key, () => d.files);
}

/** Image previews are object URLs, valid only in the window that made them. */
function releasePreviews(files: readonly PendingFile[]) {
  for (const f of files) if (f.preview?.startsWith("blob:")) URL.revokeObjectURL(f.preview);
}

const toWire = (files: readonly PendingFile[]): ChatWindowFile[] => files.map((f) => ({ name: f.name, isImage: f.isImage, attachment: f.attachment }));

function fromWire(files: readonly ChatWindowFile[]): PendingFile[] {
  return files.map((f) => ({
    id: crypto.randomUUID(),
    name: f.name,
    attachment: f.attachment,
    isImage: f.isImage,
    preview: f.isImage && f.attachment.kind === "data" ? `data:${f.attachment.mediaType};base64,${f.attachment.base64}` : null,
  }));
}

function replaceFiles(key: string, files: readonly ChatWindowFile[]) {
  releasePreviews(useDrafts.getState().drafts[key]?.files ?? []);
  useDrafts.getState().updateFiles(key, () => fromWire(files));
}

/** Opens the session in its own window, or brings its window to the front. The draft moves along. */
export async function openChatWindow(projectId: string, sessionId: string, title: string | null, opts: { drag?: boolean } = {}) {
  const key = draftKey(projectId, sessionId);
  const draft = takeDraft(key);
  try {
    // drag: torn off by dragging; the window opens under the cursor and follows it until the button is released.
    const opened = await invoke<boolean>("open_chat_window", {
      target: { projectId, sessionId, draft: draft.text || null, files: toWire(draft.files) },
      title: title ?? "Ohne Titel",
      position: null,
      drag: opts.drag === true,
    });
    // The new window owns the draft from now on; it comes back with "Zurückholen". A window that
    // already showed the session keeps its own, so nothing moved.
    if (opened) releasePreviews(draft.files);
    else putBack(key, draft);
  } catch (e) {
    putBack(key, draft);
    toast.error("Fenster nicht geöffnet", errorMessage(e));
  }
}

/** Main window: asks the chat window of the session to come back; closes it if it does not answer. */
export function recallChatWindow(sessionId: string) {
  void emit(RECALL, sessionId);
  let stop = () => {};
  // Once the window is gone the fallback must not fire: a window opened again for the same session meanwhile would close.
  const timer = setTimeout(() => {
    stop();
    if (useChatWindows.getState().sessions.includes(sessionId)) void invoke("close_chat_window", { sessionId }).catch(() => {});
  }, RECALL_FALLBACK_MS);
  stop = useChatWindows.subscribe((s) => {
    if (s.sessions.includes(sessionId)) return;
    clearTimeout(timer);
    stop();
  });
}

/** Main window: closes the chat windows of deleted sessions. Their drafts are dropped, not handed back. */
export function closeChatWindows(sessionIds: Iterable<string>) {
  const open = useChatWindows.getState().sessions;
  for (const id of sessionIds) if (open.includes(id)) void invoke("close_chat_window", { sessionId: id }).catch(() => {});
}

/** Chat window: what goes back to the main window, taken out of this window's draft. */
function handBack(t: ChatWindowTarget): { key: string; draft: MovingDraft; target: ChatWindowTarget } {
  const { sessionId } = splitActive(useUi.getState().activeSession[t.projectId]);
  const key = draftKey(t.projectId, sessionId);
  const draft = takeDraft(key);
  return { key, draft, target: { projectId: t.projectId, sessionId, draft: draft.text || null, files: toWire(draft.files) } };
}

/** Chat window: the main window shows this chat again (with the unsent text) and this window closes. */
export async function reattachChatWindow() {
  const t = chatWindowTarget();
  if (!t) return;
  const back = handBack(t);
  try {
    await invoke("reattach_chat_window", { target: back.target });
  } catch (e) {
    putBack(back.key, back.draft);
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
  const key = draftKey(t.projectId, t.sessionId);
  if (t.draft) useDrafts.getState().setText(key, t.draft);
  if (t.files?.length) replaceFiles(key, t.files);
}

/** Applies a chat that came back from its window to the main window. */
export function applyReattach(t: ChatWindowTarget) {
  useUi.getState().openProject(t.projectId, t.sessionId);
  const key = draftKey(t.projectId, t.sessionId);
  // Also when empty: the text may have been sent from the chat window meanwhile.
  useDrafts.getState().setText(key, t.draft ?? "");
  replaceFiles(key, t.files ?? []);
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
    // Closed with X: like "Zurückholen", so the unsent draft is not lost. "Zurückholen" and closing
    // from the main window destroy the window in the shell and do not come through here.
    await getCurrentWindow().onCloseRequested(async () => {
      try {
        await emitTo(MAIN, REATTACH, handBack(chatWindowTarget()!).target);
      } catch {
        // The window closes anyway.
      }
    });
  } else {
    await listen<unknown>(REATTACH, (e) => {
      const t = parseChatWindowTarget(e.payload);
      if (t) applyReattach(t);
    });
    await listen<unknown>(OPEN_SESSION, (e) => {
      const t = parseChatWindowTarget(e.payload);
      if (t?.sessionId) useUi.getState().openProject(t.projectId, t.sessionId);
    });
    await listen<unknown>(OPEN_FILE, (e) => {
      const t = parseFileTarget(e.payload);
      if (!t) return;
      const ui = useUi.getState();
      if (ui.view !== "workspace" || ui.activeProjectId !== t.projectId) ui.openProject(t.projectId);
      useUi.getState().openFile(t.projectId, t.path, t.line);
    });
  }
  useChatWindows.setState({ sessions: await invoke<string[]>("chat_windows") });
}

import { useEffect } from "react";
import { findMatches, findPattern } from "@/lib/find-text";
import { hasPrimaryModifier } from "@/lib/platform";

/**
 * Search in the chat (Ctrl+F) instead of the WebView's own find: every chat on screen (main chat, split
 * panes, chat window) registers here; the shortcut, the palette and the context menu open the search bar
 * of the chat with the cursor in it, else the main chat.
 */
export interface ChatFindTarget {
  /** the chat's surface; it counts while it is on screen */
  el: HTMLElement;
  /** split pane id; null for the main chat and a chat window */
  pane: string | null;
  open: (seed: string) => void;
}

const targets = new Set<ChatFindTarget>();

const onScreen = (el: HTMLElement) => el.isConnected && el.getClientRects().length > 0;

/** The chat the search belongs to: the one with the cursor in it, else the main chat, else any on screen. */
export function chatFindTarget(active: Element | null = document.activeElement): ChatFindTarget | null {
  const shown = [...targets].filter((t) => onScreen(t.el));
  return shown.find((t) => active && t.el.contains(active)) ?? shown.find((t) => t.pane === null) ?? shown[0] ?? null;
}

/** Selected text inside `el` as a search seed: one short line, else nothing. */
export function selectedSeed(el?: Element | null): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  if (el && !el.contains(sel.getRangeAt(0).commonAncestorContainer)) return "";
  const text = sel.toString().trim();
  return text && !text.includes("\n") && text.length <= 100 ? text : "";
}

/** Opens the search bar of the current chat; false when no chat is on screen. */
export function openChatFind(seed?: string): boolean {
  const t = chatFindTarget();
  if (!t) return false;
  t.open(seed ?? selectedSeed(t.el));
  return true;
}

const dialogOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;

/**
 * Opens the search once the chat is on screen and a closing dialog (the palette) is gone: the dialog gives
 * the focus back to where it was when it unmounts, which would take it out of the search field again.
 */
export function openChatFindSoon(seed = "", deadline = performance.now() + 1500) {
  if (!dialogOpen() && chatFindTarget()) {
    setTimeout(() => openChatFind(seed), 30);
    return;
  }
  if (performance.now() < deadline) requestAnimationFrame(() => openChatFindSoon(seed, deadline));
}

/** Editors and the terminal keep their own Ctrl+F. */
const OWN_FIND = ".xterm, .cm-editor, .monaco-editor";

export function handleChatFindKey(e: KeyboardEvent) {
  if (!hasPrimaryModifier(e) || e.altKey || e.shiftKey || e.defaultPrevented || e.key.toLowerCase() !== "f") return;
  if (e.target instanceof Element && e.target.closest(OWN_FIND)) return;
  if (dialogOpen()) return;
  if (openChatFind()) e.preventDefault();
}

/** Registers a chat for Ctrl+F; the key listener lives as long as any chat does. */
export function registerChatFind(t: ChatFindTarget): () => void {
  if (!targets.size) window.addEventListener("keydown", handleChatFindKey);
  targets.add(t);
  return () => {
    targets.delete(t);
    if (!targets.size) window.removeEventListener("keydown", handleChatFindKey);
  };
}

export function useChatFindTarget(el: HTMLElement | null, pane: string | null, open: (seed: string) => void) {
  useEffect(() => (el ? registerChatFind({ el, pane, open }) : undefined), [el, pane, open]);
}

// ---- marking the words on screen

/** Text that is no chat content: inputs, the search bar itself. */
const SKIP = "textarea, input, script, style, [data-find-skip]";

/** Ranges of the matches in the text nodes under `root`. */
export function matchRanges(root: Element, words: string[], phrase: boolean): Range[] {
  const pattern = findPattern(words, phrase);
  if (!pattern) return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    for (const [start, end] of findMatches(n.nodeValue ?? "", pattern)) {
      const r = document.createRange();
      r.setStart(n, start);
      r.setEnd(n, end);
      out.push(r);
    }
  }
  return out;
}

/** Ranges per chat; CSS highlights are one registry per document, so all chats share the two names. */
const marked = new Map<object, { all: Range[]; current: Range[] }>();

function paint() {
  // CSS Custom Highlight API (WebView2); test environments lack it.
  if (typeof Highlight === "undefined" || typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const m of marked.values()) {
    all.push(...m.all);
    current.push(...m.current);
  }
  CSS.highlights.set("forge-find", new Highlight(...all));
  CSS.highlights.set("forge-find-current", new Highlight(...current));
}

/**
 * Marks the words in the chat thread under `surface` (rows with `[data-chat-thread]`), stronger inside the
 * row of the current hit (`[data-find-current]`). Follows the DOM: the thread is virtualized, rows come and go
 * while scrolling, and answers grow while streaming.
 */
export function useFindMarks(surface: HTMLElement | null, words: string[], phrase: boolean) {
  const key = words.join(" ");
  useEffect(() => {
    if (!surface || !key) return;
    const id = {};
    const list = key.split(" ");
    let frame = 0;
    const apply = () => {
      frame = 0;
      const all: Range[] = [];
      surface.querySelectorAll("[data-chat-thread]").forEach((el) => all.push(...matchRanges(el, list, phrase)));
      const current = all.filter((r) => r.startContainer.parentElement?.closest("[data-find-current]"));
      marked.set(id, { all, current });
      paint();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    const mo = new MutationObserver(schedule);
    mo.observe(surface, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-find-current"] });
    return () => {
      mo.disconnect();
      if (frame) cancelAnimationFrame(frame);
      marked.delete(id);
      paint();
    };
  }, [surface, key, phrase]);
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { chatFindTarget, handleChatFindKey, matchRanges, registerChatFind } from "./chat-find";

/** A chat surface; jsdom lays nothing out, so "on screen" is stubbed. */
function surface(shown = true) {
  const el = document.createElement("div");
  el.innerHTML = `<textarea></textarea><button>x</button>`;
  el.getClientRects = () => (shown ? [{}] : []) as unknown as DOMRectList;
  document.body.appendChild(el);
  return el;
}

function ctrlF(target: EventTarget = document.body, extra: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true, ...extra });
  target.dispatchEvent(e);
  return e;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((c) => c());
  document.body.innerHTML = "";
});

describe("Ctrl+F in the chat", () => {
  it("opens the search of the chat with the cursor in it, else the main chat, instead of the WebView's find", () => {
    const main = surface();
    const pane = surface();
    const openMain = vi.fn();
    const openPane = vi.fn();
    cleanups.push(registerChatFind({ el: main, pane: null, open: openMain }), registerChatFind({ el: pane, pane: "p2", open: openPane }));

    pane.querySelector("textarea")!.focus();
    expect(ctrlF(pane.querySelector("textarea")!).defaultPrevented).toBe(true);
    expect(openPane).toHaveBeenCalledWith("");
    expect(openMain).not.toHaveBeenCalled();

    (document.activeElement as HTMLElement).blur();
    expect(ctrlF().defaultPrevented).toBe(true);
    expect(openMain).toHaveBeenCalledTimes(1);
  });

  it("leaves Ctrl+F alone without a chat on screen, in editors, with other modifiers and behind dialogs", () => {
    const hidden = surface(false);
    const open = vi.fn();
    cleanups.push(registerChatFind({ el: hidden, pane: null, open }));
    expect(chatFindTarget()).toBeNull();
    expect(ctrlF().defaultPrevented).toBe(false);

    const shown = surface();
    cleanups.push(registerChatFind({ el: shown, pane: null, open }));
    const editor = document.createElement("div");
    editor.className = "cm-editor";
    shown.appendChild(editor);
    expect(ctrlF(editor).defaultPrevented).toBe(false);
    expect(ctrlF(document.body, { shiftKey: true }).defaultPrevented).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    expect(ctrlF().defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
    dialog.remove();
    expect(ctrlF().defaultPrevented).toBe(true);
  });

  it("takes a short selected text inside the chat as the search", () => {
    const el = surface();
    const open = vi.fn();
    cleanups.push(registerChatFind({ el, pane: null, open }));
    const p = document.createElement("p");
    p.textContent = "Der Stripe-Webhook";
    el.appendChild(p);
    const r = document.createRange();
    r.setStart(p.firstChild!, 4);
    r.setEnd(p.firstChild!, 18);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(r);
    handleChatFindKey(new KeyboardEvent("keydown", { key: "F", ctrlKey: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("Stripe-Webhook");
    window.getSelection()!.removeAllRanges();
  });

  it("stops listening when the last chat is gone", () => {
    const open = vi.fn();
    registerChatFind({ el: surface(), pane: null, open })();
    expect(ctrlF().defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("marking the words on screen", () => {
  it("finds ranges in text nodes, but not in inputs or the search bar", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>Der <b>Webhook</b> für Stripe läuft</p><textarea>stripe</textarea><div data-find-skip>Stripe</div><code>stripe_key</code>`;
    const ranges = matchRanges(root, ["stripe", "webhook"], false);
    expect(ranges.map((r) => r.toString())).toEqual(["Webhook", "Stripe", "stripe"]);
    expect(matchRanges(root, [], false)).toEqual([]);
  });
});

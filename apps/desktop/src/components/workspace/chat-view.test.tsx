import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { ChatItem } from "./chat-items";
import { ChatViewToggle, chatView, filterChatItems, setChatView } from "./chat-view";

afterEach(cleanup);

const user = (key: string, text: string): ChatItem => ({ kind: "user", key, seq: 1, text, ts: "", uuid: null, attachments: [], remote: false, auto: false, edited: false, task: null });
const answer = (key: string, text: string): ChatItem => ({ kind: "assistant", key, seq: 2, text, streaming: false, ts: "" });
const tool = (key: string): ChatItem =>
  ({ kind: "tool", key, ts: "", use: { type: "tool.use", toolUseId: key, name: "Bash", input: {}, parentToolUseId: null }, result: null, approval: null, blocked: null, todos: null, superseded: false }) as ChatItem;
const result = (key: string): ChatItem => ({ kind: "result", key, ts: "", body: { type: "turn.result" } }) as unknown as ChatItem;

const chat = [user("u1", "Baue den Warenkorb"), answer("a1", "Ich schaue mir das an."), tool("t1"), answer("a2", "Fertig."), result("r1"), user("u2", "Jetzt Tests"), tool("t2"), answer("a3", " "), answer("a4", "Tests laufen.")];

describe("chat views", () => {
  it("keeps everything in the whole view", () => {
    const f = filterChatItems(chat, "all");
    expect(f.items).toBe(chat);
    expect(f.turnStarts.size).toBe(0);
  });

  it("shows only the user's prompts", () => {
    expect(filterChatItems(chat, "prompts").items.map((i) => i.key)).toEqual(["u1", "u2"]);
  });

  it("shows only Claude's texts and marks the first answer of each turn", () => {
    const f = filterChatItems(chat, "answers");
    expect(f.items.map((i) => i.key)).toEqual(["a1", "a2", "a4"]);
    expect([...f.turnStarts]).toEqual(["a1", "a4"]);
  });

  it("remembers the view per session and switches it from the header", () => {
    expect(chatView("s-view")).toBe("all");
    render(
      <TooltipProvider>
        <ChatViewToggle sessionId="s-view" compact={false} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Prompts" }));
    expect(chatView("s-view")).toBe("prompts");
    expect(screen.getByRole("radio", { name: "Prompts" }).getAttribute("aria-checked")).toBe("true");
    setChatView("s-view", "answers");
    expect(chatView("s-other")).toBe("all");
  });
});

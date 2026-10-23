import { describe, expect, it } from "vitest";
import { buildChatItems, relativeTo, rowSpacing, startsAnswer } from "./chat-items";

describe("chat rows of a member's session", () => {
  it("folds results and approvals into their tool call and leaves subagents out", () => {
    const items = buildChatItems([
      { type: "user.message", text: "Bau den Header" },
      { type: "assistant.text", messageId: "m1", index: 0, text: "Mache ich." },
      { type: "tool.use", toolUseId: "t1", name: "Edit", input: { file_path: "C:\\p\\src\\a.ts", old_string: "a", new_string: "b" }, parentToolUseId: null },
      { type: "approval.request", requestId: "r1", toolUseId: "t1", toolName: "Edit", input: {}, title: null, description: null, reason: null, allowSessionScope: true, outsideProject: false },
      { type: "approval.resolved", requestId: "r1", decision: "allow", scope: "once", source: "user", message: null },
      { type: "tool.result", toolUseId: "t1", isError: false, content: { text: "ok", truncated: false } },
      { type: "tool.use", toolUseId: "a1", name: "Agent", input: { description: "Suche" }, parentToolUseId: null },
      { type: "tool.use", toolUseId: "s1", name: "Read", input: { file_path: "x" }, parentToolUseId: "a1" },
      { type: "assistant.text", messageId: "m2", index: 0, text: "im Subagenten", parentToolUseId: "a1" },
      { type: "turn.result", subtype: "success", isError: false, durationMs: 12000, numTurns: 3, inputTokens: 6, outputTokens: 504, cacheReadTokens: 0, text: "fertig" },
      { type: "user.message", text: "<system-reminder>intern</system-reminder>" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "result"]);
    const edit = items[2];
    expect(edit?.kind === "tool" && edit.result?.text).toBe("ok");
    expect(edit?.kind === "tool" && edit.approval?.resolved?.decision).toBe("allow");
    expect(startsAnswer(items[0], items[1]!)).toBe(true);
    expect(startsAnswer(items[1], items[2]!)).toBe(false);
    expect(rowSpacing(items[2], items[3]!)).toBe("tight");
    expect(rowSpacing(items[3], items[4]!)).toBe("tight");
  });

  it("keeps only the newest todo list open and the latest text of a message", () => {
    const items = buildChatItems([
      { type: "tool.use", toolUseId: "t1", name: "TodoWrite", input: { todos: [{ content: "A", status: "pending" }] }, parentToolUseId: null },
      { type: "assistant.text", messageId: "m", index: 0, text: "erst" },
      { type: "assistant.text", messageId: "m", index: 0, text: "dann" },
      { type: "tool.use", toolUseId: "t2", name: "TodoWrite", input: { todos: [{ content: "A", status: "completed" }] }, parentToolUseId: null },
    ]);
    expect(items.map((i) => (i.kind === "tool" ? `todo:${i.superseded}` : i.kind === "assistant" ? i.text : i.kind))).toEqual(["todo:true", "dann", "todo:false"]);
  });

  it("shows paths inside the session's folder relative to it", () => {
    expect(relativeTo("C:\\Users\\a\\forge\\src\\x.ts", "C:\\Users\\a\\forge")).toBe("src/x.ts");
    expect(relativeTo("c:/users/a/forge/src/x.ts", "C:\\Users\\a\\forge\\")).toBe("src/x.ts");
    expect(relativeTo("/home/a/forge/x.ts", "/home/a/forge")).toBe("x.ts");
    expect(relativeTo("/etc/hosts", "/home/a/forge")).toBe("/etc/hosts");
    expect(relativeTo("src/x.ts", null)).toBe("src/x.ts");
  });
});

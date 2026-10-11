import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionEventBody } from "@forge/protocol";
import { appendStreaming, buildChatItems, buildEventItems, itemIndexForSeq, lastUserPrompt, reuseStableItems, rowSpacing, toolDisplayName, toolSummary } from "./chat-items";
import { useSessionEvents } from "@/stores/session-events";

let seq = 0;
const ev = (body: SessionEventBody, s = ++seq): SessionEvent => ({ seq: s, sessionId: "s1", ts: "2026-10-10T12:00:00.000Z", body });

describe("buildChatItems", () => {
  it("groups tool use, approval and result into one card and keeps message order", () => {
    seq = 0;
    const events = [
      ev({ type: "user.message", text: "Bitte testen" }),
      ev({ type: "assistant.text", messageId: "m1", index: 0, text: "Ich starte die Tests." }),
      ev({ type: "tool.use", toolUseId: "t1", name: "Bash", input: { command: "pnpm test" }, parentToolUseId: null }),
      ev({
        type: "approval.request",
        requestId: "r1",
        toolUseId: "t1",
        toolName: "Bash",
        input: { command: "pnpm test" },
        title: "Run pnpm test",
        description: null,
        reason: null,
        allowSessionScope: true,
        outsideProject: false,
      }),
      ev({ type: "approval.resolved", requestId: "r1", decision: "allow", scope: "once", source: "user", message: null }),
      ev({ type: "tool.result", toolUseId: "t1", isError: false, content: { text: "12 passed", truncated: false } }),
      ev({ type: "turn.result", subtype: "success", isError: false, durationMs: 1200, numTurns: 2, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, text: "ok" }),
    ];
    const items = buildChatItems(events, {});
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "result"]);
    const tool = items[2];
    expect(tool?.kind).toBe("tool");
    if (tool?.kind === "tool") {
      expect(tool.result?.content.text).toBe("12 passed");
      expect(tool.approval?.resolved?.decision).toBe("allow");
    }
  });

  it("shows streaming text until the final text for the same block arrives", () => {
    seq = 0;
    const base = [ev({ type: "user.message", text: "hi" })];
    const streaming = { "m1:0": "Hal" };
    expect(buildChatItems(base, streaming).at(-1)).toMatchObject({ kind: "assistant", text: "Hal", streaming: true });
    const final = [...base, ev({ type: "assistant.text", messageId: "m1", index: 0, text: "Hallo" })];
    const items = buildChatItems(final, streaming);
    expect(items.filter((i) => i.kind === "assistant")).toHaveLength(1);
    expect(items.at(-1)).toMatchObject({ text: "Hallo", streaming: false });
  });

  it("attaches policy blocks to the tool and marks superseded todo lists", () => {
    seq = 0;
    const todo = (status: string) => ({ todos: [{ content: "A", status, activeForm: "Mache A" }] });
    const items = buildChatItems(
      [
        ev({ type: "tool.use", toolUseId: "t1", name: "TodoWrite", input: todo("in_progress"), parentToolUseId: null }),
        ev({ type: "tool.use", toolUseId: "t2", name: "Bash", input: { command: "git push --force" }, parentToolUseId: null }),
        ev({ type: "policy.blocked", toolUseId: "t2", toolName: "Bash", rule: "git-force-push", message: "Force-Push ist in FORGE gesperrt." }),
        ev({ type: "tool.use", toolUseId: "t3", name: "TodoWrite", input: todo("completed"), parentToolUseId: null }),
      ],
      {},
    );
    const [first, bash, last] = items;
    expect(first).toMatchObject({ kind: "tool", superseded: true });
    expect(bash).toMatchObject({ kind: "tool", blocked: { rule: "git-force-push" } });
    expect(last).toMatchObject({ kind: "tool", superseded: false, todos: [{ status: "completed" }] });
  });

  it("finds the last prompt for retry and summarizes tools", () => {
    seq = 0;
    expect(lastUserPrompt([ev({ type: "user.message", text: "eins" }), ev({ type: "user.message", text: "zwei" })])).toBe("zwei");
    expect(toolSummary("Read", { file_path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolSummary("Grep", { pattern: "foo", path: "src" })).toBe("foo in src");
  });
});

describe("session event store", () => {
  it("merges history with live events, ignores duplicates and clears streaming on final text", () => {
    const st = useSessionEvents.getState();
    st.apply({ seq: 3, sessionId: "x", ts: "t", body: { type: "user.message", text: "live" } });
    st.apply({ seq: 0, sessionId: "x", ts: "t", body: { type: "assistant.delta", messageId: "m", index: 0, text: "Hal" } });
    st.apply({ seq: 0, sessionId: "x", ts: "t", body: { type: "assistant.delta", messageId: "m", index: 0, text: "lo" } });
    expect(useSessionEvents.getState().buffers.x?.streaming["m:0"]).toBe("Hallo");
    st.setHistory("x", [
      { seq: 1, sessionId: "x", ts: "t", body: { type: "user.message", text: "a" } },
      { seq: 2, sessionId: "x", ts: "t", body: { type: "user.message", text: "b" } },
      { seq: 3, sessionId: "x", ts: "t", body: { type: "user.message", text: "live" } },
    ]);
    st.apply({ seq: 2, sessionId: "x", ts: "t", body: { type: "user.message", text: "dup" } });
    st.apply({ seq: 4, sessionId: "x", ts: "t", body: { type: "assistant.text", messageId: "m", index: 0, text: "Hallo" } });
    const b = useSessionEvents.getState().buffers.x!;
    expect(b.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(b.streaming).toEqual({});
  });
});

describe("search focus and compaction", () => {
  it("finds the item for a search hit, also when the exact event is not shown on its own", () => {
    seq = 0;
    const items = buildChatItems(
      [
        ev({ type: "user.message", text: "a" }),
        ev({ type: "assistant.text", messageId: "m1", index: 0, text: "b" }),
        ev({ type: "tool.use", toolUseId: "t1", name: "Read", input: {}, parentToolUseId: null }),
        ev({ type: "user.message", text: "c" }),
      ],
      {},
    );
    expect(items[itemIndexForSeq(items, 2)]).toMatchObject({ kind: "assistant", text: "b" });
    expect(items[itemIndexForSeq(items, 3)]).toMatchObject({ kind: "assistant", text: "b" });
    expect(items[itemIndexForSeq(items, 4)]).toMatchObject({ kind: "user", text: "c" });
    expect(itemIndexForSeq(items, 0)).toBe(-1);
  });

  it("shows a compaction as a notice with token counts", () => {
    seq = 0;
    const items = buildChatItems([ev({ type: "context.compacted", trigger: "auto", preTokens: 170_000, postTokens: 12_400 })], {});
    expect(items[0]).toMatchObject({ kind: "notice", tone: "info" });
    expect((items[0] as { text: string }).text).toMatch(/^Kontext automatisch komprimiert: vorher 170k, nachher 12k Tokens\./);
  });

  it("summarises questions and plans in cards and the activity feed", () => {
    expect(toolSummary("AskUserQuestion", { questions: [{ question: "Welche Datenbank?" }] })).toBe("Welche Datenbank?");
    expect(toolSummary("ExitPlanMode", { plan: "x" })).toBe("Plan zur Freigabe");
  });
});

describe("stable chat items", () => {
  it("keeps unchanged items and only replaces the ones a new event touched", () => {
    seq = 0;
    const base = [
      ev({ type: "user.message", text: "Bitte lesen" }),
      ev({ type: "tool.use", toolUseId: "t1", name: "TodoWrite", input: { todos: [{ content: "a", status: "pending" }] }, parentToolUseId: null }),
      ev({ type: "tool.use", toolUseId: "t2", name: "Read", input: { file_path: "a.ts" }, parentToolUseId: null }),
    ];
    const first = buildEventItems(base);
    const withResult = [...base, ev({ type: "tool.result", toolUseId: "t2", isError: false, content: { text: "inhalt", truncated: false } })];
    const second = reuseStableItems(first, buildEventItems(withResult));
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).not.toBe(first[2]);
    expect(reuseStableItems(second, buildEventItems(withResult))).toBe(second);
  });

  it("adds streaming text after the events and drops it once the final text is there", () => {
    seq = 0;
    const items = buildEventItems([ev({ type: "assistant.text", messageId: "m1", index: 0, text: "fertig" })]);
    expect(appendStreaming(items, {})).toBe(items);
    expect(appendStreaming(items, { "m1:0": "fer" })).toBe(items);
    const live = appendStreaming(items, { "m2:0": "Ich schau" });
    expect(live.at(-1)).toMatchObject({ kind: "assistant", key: "am2:0", streaming: true, text: "Ich schau" });
    expect(live[0]).toBe(items[0]);
  });
});

describe("usage limit in the chat", () => {
  const reset = Date.parse("2026-10-10T17:10:00.000Z") / 1000;
  const limit = (status: string, extra: Partial<Extract<SessionEventBody, { type: "rate_limit" }>> = {}): SessionEventBody => ({ type: "rate_limit", status, resetsAt: reset, limitType: "five_hour", ...extra });
  const failed: SessionEventBody = { type: "turn.result", subtype: "success", isError: true, durationMs: 10, numTurns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, text: "You've hit your limit" };

  it("shows no notice for warnings or allowed reports, however often they come", () => {
    seq = 0;
    const items = buildEventItems([ev({ type: "user.message", text: "x" }), ev(limit("allowed_warning")), ev(limit("allowed_warning")), ev(limit("allowed"))]);
    expect(items.map((i) => i.kind)).toEqual(["user"]);
  });

  it("shows a real stop in German without raw status names", () => {
    seq = 0;
    const items = buildEventItems([ev(limit("rejected")), ev(limit("rejected", { overageInUse: true }))]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "notice", card: { title: "Nutzungslimit erreicht", detail: expect.stringMatching(/^5-Stunden-Limit · zurückgesetzt um \d\d:\d\d$/) } });
    expect(JSON.stringify(items)).not.toMatch(/rejected|allowed/);
  });

  it("replaces the stop notice with the plan card and closes the plan once something follows", () => {
    seq = 0;
    const scheduled: SessionEventBody = { type: "auto_continue", state: "scheduled", scheduledFor: "2026-10-10T17:12:00.000Z", resetKnown: true, attempt: 1, message: null };
    const planned = buildEventItems([ev({ type: "user.message", text: "Bau das" }), ev(limit("rejected")), ev(failed), ev(scheduled)]);
    expect(planned.map((i) => i.kind)).toEqual(["user", "result", "autoContinue"]);
    expect(planned.at(-1)).toMatchObject({ open: true });

    const ran = buildEventItems([
      ...[ev({ type: "user.message", text: "Bau das" }, 1), ev(limit("rejected"), 2), ev(failed, 3), ev(scheduled, 4)],
      ev({ type: "auto_continue", state: "resumed", scheduledFor: "2026-10-10T17:12:00.000Z", attempt: 1, message: null }, 5),
      ev({ type: "user.message", text: "Das Nutzungslimit ist zurückgesetzt.", source: "auto" }, 6),
    ]);
    expect(ran.map((i) => (i.kind === "autoContinue" ? `${i.body.state}:${i.open}` : i.kind))).toEqual(["user", "result", "scheduled:false", "resumed:false", "user"]);
    expect(ran.at(-1)).toMatchObject({ kind: "user", auto: true });

    const overruled = buildEventItems([ev(scheduled, 1), ev({ type: "user.message", text: "Mach ich selbst" }, 2)]);
    expect(overruled[0]).toMatchObject({ kind: "autoContinue", open: false });
  });
});

describe("notifications stored as prompts", () => {
  it("hides task notifications and reminders that older versions stored as user messages", () => {
    seq = 0;
    const events = [
      ev({ type: "user.message", text: "Starte den Build im Hintergrund" }),
      ev({ type: "background.task", taskId: "b1", state: "completed", description: "pnpm build", summary: null }),
      ev({ type: "user.message", text: "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>" }),
      ev({ type: "user.message", text: "  <system-reminder>Context left</system-reminder>" }),
      ev({ type: "assistant.text", messageId: "m1", index: 0, text: "Der Build ist fertig." }),
    ];
    const items = buildEventItems(events);
    expect(items.map((i) => i.kind)).toEqual(["user", "notice", "assistant"]);
    expect(lastUserPrompt(events)).toBe("Starte den Build im Hintergrund");
  });

  it("keeps prompts that only mention the tags", () => {
    seq = 0;
    const items = buildEventItems([ev({ type: "user.message", text: "Was bedeutet <task-notification> im Log?" })]);
    expect(items).toMatchObject([{ kind: "user" }]);
  });
});

describe("chat layout helpers", () => {
  it("separates turns and stacks one-line rows tightly", () => {
    seq = 0;
    const items = buildEventItems([
      ev({ type: "user.message", text: "a" }),
      ev({ type: "assistant.text", messageId: "m1", index: 0, text: "b" }),
      ev({ type: "tool.use", toolUseId: "t1", name: "Read", input: {}, parentToolUseId: null }),
      ev({ type: "tool.use", toolUseId: "t2", name: "Bash", input: {}, parentToolUseId: null }),
      ev({ type: "tool.use", toolUseId: "t3", name: "AskUserQuestion", input: {}, parentToolUseId: null }),
      ev({ type: "turn.result", subtype: "success", isError: false, durationMs: 1, numTurns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null, text: null }),
      ev({ type: "user.message", text: "c" }),
    ]);
    expect(items.map((it, i) => rowSpacing(items[i - 1], it))).toEqual(["first", "block", "block", "tight", "block", "tight", "turn"]);
  });

  it("shows MCP tools by server and tool name", () => {
    expect(toolDisplayName("Bash")).toBe("Bash");
    expect(toolDisplayName("mcp__github__create_issue")).toBe("github: create_issue");
  });
});

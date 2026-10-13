import { describe, expect, it } from "vitest";
import type { SessionEvent, SessionEventBody } from "@forge/protocol";
import { agentCall } from "./TaskThread";

const ev = (seq: number, body: SessionEventBody): SessionEvent => ({ seq, sessionId: "s1", ts: "2026-10-13T10:00:00Z", body });
const launch: SessionEventBody = { type: "tool.result", toolUseId: "ta1", isError: false, content: { text: "Async agent launched successfully.\nagentId: a1", truncated: false } };

describe("agentCall", () => {
  it("takes a background subagent's answer from the end of its task, not the launch notice", () => {
    const use: SessionEventBody = { type: "tool.use", toolUseId: "ta1", name: "Agent", input: { prompt: "Recherche", run_in_background: true }, parentToolUseId: null };
    const started = [ev(1, use), ev(2, launch)];
    expect(agentCall(started, "ta1").result).toBeNull();
    const done = ev(3, { type: "background.task", taskId: "a1", description: "Recherche", state: "completed", summary: "Drei Routen gefunden.", toolUseId: "ta1" });
    expect(agentCall([...started, done], "ta1").result).toEqual({ isError: false, text: "Drei Routen gefunden." });
  });

  it("recognises the background subagent by its launch notice when the call is on an older page", () => {
    const failed = ev(3, { type: "background.task", taskId: "a1", description: "Recherche", state: "failed", summary: "Abgebrochen.", toolUseId: "ta1" });
    expect(agentCall([ev(2, launch), failed], "ta1").result).toEqual({ isError: true, text: "Abgebrochen." });
  });

  it("keeps the tool result of a subagent in the foreground", () => {
    const use: SessionEventBody = { type: "tool.use", toolUseId: "tf1", name: "Agent", input: { prompt: "Prüfe" }, parentToolUseId: null };
    const result: SessionEventBody = { type: "tool.result", toolUseId: "tf1", isError: false, content: { text: "Alles gut.", truncated: false } };
    expect(agentCall([ev(1, use), ev(2, result)], "tf1").result).toEqual({ isError: false, text: "Alles gut." });
  });
});

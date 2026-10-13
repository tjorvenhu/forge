import { describe, expect, it } from "vitest";
import type { BackgroundTask, ServerEvent, Session, SessionStatus } from "@forge/protocol";
import { JobWatcher } from "../src/sessions/job-done.js";

interface Fake {
  status: SessionStatus;
  background: BackgroundTask[];
  parent: string | null;
}

const task: BackgroundTask = { taskId: "t1", description: "Build", taskType: "local_bash", toolUseId: null, startedAt: "2026-10-13T10:00:00Z", summary: null };

function setup(sessions: Record<string, Partial<Fake>>) {
  const all = new Map<string, Fake>(Object.entries(sessions).map(([id, s]) => [id, { status: "idle", background: [], parent: null, ...s }]));
  const done: string[] = [];
  const watcher = new JobWatcher({
    session: (id) => {
      const s = all.get(id);
      return s ? ({ id, status: s.status, background: s.background } as unknown as Session) : null;
    },
    parent: (id) => all.get(id)?.parent ?? null,
    children: (id) => [...all.entries()].filter(([, s]) => s.parent === id).map(([c]) => c),
    emit: (e: ServerEvent) => {
      if (e.event === "session.done") done.push(e.payload.sessionId);
    },
  });
  /** a turn ends; the session's status still says running when turn.result is recorded */
  const turnEnds = (id: string, isError = false) => {
    const s = all.get(id)!;
    s.status = "running";
    watcher.onServerEvent({
      event: "session.event",
      payload: { seq: 1, sessionId: id, ts: "", body: { type: "turn.result", subtype: isError ? "error_during_execution" : "success", isError, text: null, durationMs: 1, numTurns: 1, inputTokens: null, outputTokens: null, cacheReadTokens: null } },
    });
    s.status = "idle";
  };
  return { all, done, turnEnds };
}

describe("JobWatcher", () => {
  it("announces a plain turn as done", () => {
    const { done, turnEnds } = setup({ s: {} });
    turnEnds("s");
    expect(done).toEqual(["s"]);
  });

  it("waits for background tasks: the turn Claude starts after them is the end of the job", () => {
    const { all, done, turnEnds } = setup({ s: { background: [task] } });
    turnEnds("s");
    expect(done).toEqual([]);
    all.get("s")!.background = [];
    turnEnds("s");
    expect(done).toEqual(["s"]);
  });

  it("announces the starting session once, when its last agent is done, and not the agents themselves", () => {
    const { all, done, turnEnds } = setup({ p: {}, a: { parent: "p", status: "running" }, b: { parent: "p", status: "running" } });
    turnEnds("p");
    expect(done).toEqual([]);
    turnEnds("a");
    expect(done).toEqual([]);
    all.get("b")!.status = "waiting_approval";
    turnEnds("a");
    expect(done).toEqual([]);
    all.get("b")!.status = "running";
    turnEnds("b");
    expect(done).toEqual(["p"]);
  });

  it("leaves an agent that ends during its starter's turn to that turn's end", () => {
    const { all, done, turnEnds } = setup({ p: { status: "running" }, a: { parent: "p", status: "running" } });
    turnEnds("a");
    expect(done).toEqual([]);
    expect(all.get("p")!.status).toBe("running");
    turnEnds("p");
    expect(done).toEqual(["p"]);
  });

  it("counts an agent with background tasks as still at work", () => {
    const { all, done, turnEnds } = setup({ p: {}, a: { parent: "p", status: "running", background: [task] } });
    turnEnds("p");
    turnEnds("a");
    expect(done).toEqual([]);
    all.get("a")!.background = [];
    turnEnds("a");
    expect(done).toEqual(["p"]);
  });

  it("announces an agent on its own when its starter is not waiting for it", () => {
    const { done, turnEnds } = setup({ p: {}, a: { parent: "p", status: "running" } });
    turnEnds("a");
    expect(done).toEqual(["a"]);
  });

  it("forgets a waiting job after a failed turn", () => {
    const { all, done, turnEnds } = setup({ s: { background: [task] } });
    turnEnds("s");
    all.get("s")!.background = [];
    turnEnds("s", true);
    expect(done).toEqual([]);
  });
});

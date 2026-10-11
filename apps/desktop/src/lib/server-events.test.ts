import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ServerEvent, Session, SessionEvent } from "@forge/protocol";
import { useSessionEvents } from "@/stores/session-events";
import type * as NotificationsNs from "./notifications";
import { useUi } from "@/stores/ui";
import { keys } from "./queries";
import { createGitRefresher, evictSessionBuffers, startServerEvents } from "./server-events";

type NotificationsModule = typeof NotificationsNs;

vi.mock("./sounds", () => ({ playSound: vi.fn() }));
vi.mock("./notifications", async (orig) => ({ ...(await orig<NotificationsModule>()), notifySession: vi.fn(async () => {}) }));

function fakeSource() {
  const listeners = new Set<(e: ServerEvent) => void>();
  const status = new Set<(up: boolean) => void>();
  return {
    source: {
      subscribe: (l: (e: ServerEvent) => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      onStatus: (l: (up: boolean) => void) => {
        status.add(l);
        return () => void status.delete(l);
      },
    },
    emit: (e: ServerEvent) => listeners.forEach((l) => l(e)),
    setUp: (up: boolean) => status.forEach((l) => l(up)),
    listenerCount: () => listeners.size,
  };
}

const sessionEvent = (sessionId: string, seq: number, body: SessionEvent["body"]): ServerEvent =>
  ({ event: "session.event", payload: { sessionId, seq, ts: "2026-10-11T10:00:00.000Z", body } }) as ServerEvent;

const toolResult = { type: "tool.result", toolUseId: "t", isError: false, content: { text: "", truncated: false } } as SessionEvent["body"];

let qc: QueryClient;
let stop: (() => void) | null = null;

beforeEach(() => {
  qc = new QueryClient();
  useSessionEvents.setState({ buffers: {} });
});
afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
});

describe("server event routing", () => {
  it("puts session events into the buffer and session updates into the cache", () => {
    const f = fakeSource();
    stop = startServerEvents(qc, f.source);
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    f.emit(sessionEvent("s1", 1, { type: "user.message", text: "Hallo" }));
    expect(useSessionEvents.getState().buffers.s1?.events.map((e) => e.seq)).toEqual([1]);

    const session = { id: "s1", projectId: "p1", status: "running" } as Session;
    f.emit({ event: "session.updated", payload: session } as ServerEvent);
    expect(qc.getQueryData(keys.session("s1"))).toBe(session);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.sessions("p1") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.liveSessions });
  });

  it("stops routing after unsubscribing", () => {
    const f = fakeSource();
    startServerEvents(qc, f.source)();
    expect(f.listenerCount()).toBe(0);
    f.emit(sessionEvent("s9", 1, { type: "user.message", text: "x" }));
    expect(useSessionEvents.getState().buffers.s9).toBeUndefined();
  });

  it("refreshes git for every project, also when events of two projects come close together", () => {
    vi.useFakeTimers();
    const f = fakeSource();
    stop = startServerEvents(qc, f.source);
    qc.setQueryData(keys.session("a"), { id: "a", projectId: "pA" });
    qc.setQueryData(keys.session("b"), { id: "b", projectId: "pB" });
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    f.emit(sessionEvent("a", 1, toolResult));
    vi.advanceTimersByTime(100);
    f.emit(sessionEvent("b", 1, toolResult));
    vi.advanceTimersByTime(400);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.git("pA") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.git("pB") });
  });

  it("reloads everything after the sidecar came back", () => {
    const f = fakeSource();
    stop = startServerEvents(qc, f.source);
    useSessionEvents.getState().setHistory("s1", []);
    useSessionEvents.getState().apply({ sessionId: "s1", seq: 0, ts: "t", body: { type: "assistant.delta", messageId: "m", index: 0, text: "Hal" } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    f.setUp(true);
    expect(invalidate).not.toHaveBeenCalled();
    f.setUp(false);
    f.setUp(true);

    expect(invalidate).toHaveBeenCalledWith();
    expect(useSessionEvents.getState().buffers.s1).toMatchObject({ loaded: false, streaming: {} });
  });
});

describe("git refresher", () => {
  it("debounces per project", () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const git = createGitRefresher(qc, 400);
    git.schedule("p1");
    vi.advanceTimersByTime(300);
    git.schedule("p1");
    vi.advanceTimersByTime(300);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: keys.git("p1") });
    expect(invalidate.mock.calls.filter(([f]) => JSON.stringify(f) === JSON.stringify({ queryKey: keys.git("p1") }))).toHaveLength(1);
  });
});

describe("buffer eviction", () => {
  it("keeps live and shown sessions and the most recently used others", () => {
    vi.useFakeTimers();
    const st = useSessionEvents.getState();
    for (const [i, id] of ["old", "live", "shown", "recent"].entries()) {
      vi.setSystemTime(1_000 + i * 1_000);
      st.setHistory(id, []);
    }
    qc.setQueryData(keys.liveSessions, [{ id: "live" }]);
    useUi.setState({ activeSession: { p1: "shown", p2: null } });

    evictSessionBuffers(qc, 1);

    expect(Object.keys(useSessionEvents.getState().buffers).sort()).toEqual(["live", "recent", "shown"]);
  });
});

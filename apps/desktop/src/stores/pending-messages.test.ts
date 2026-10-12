import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@forge/protocol";
import { PENDING_MAX_AGE_MS, usePendingMessages } from "./pending-messages";

const user = (seq: number, text: string): SessionEvent => ({ seq, sessionId: "s", ts: "t", body: { type: "user.message", text } });
const list = (key: string) => usePendingMessages.getState().pending[key] ?? [];

describe("pending messages", () => {
  beforeEach(() => usePendingMessages.setState({ pending: {} }));
  afterEach(() => vi.useRealTimers());

  it("stays until the real message with the same text comes after the recorded seq", () => {
    const st = usePendingMessages.getState();
    st.add("s", { text: "Mach  weiter", files: [], afterSeq: 5 });
    // Same text earlier in the history (an older prompt) is not the echo.
    st.settle("s", [user(3, "Mach weiter")]);
    expect(list("s")).toHaveLength(1);
    st.settle("s", [user(3, "Mach weiter"), user(6, "anders")]);
    expect(list("s")).toHaveLength(1);
    st.settle("s", [user(3, "Mach weiter"), user(7, "Mach weiter")]);
    expect(list("s")).toHaveLength(0);
  });

  it("matches two equal messages to two separate events", () => {
    const st = usePendingMessages.getState();
    st.add("s", { text: "ok", files: [], afterSeq: 0 });
    st.add("s", { text: "ok", files: [], afterSeq: 0 });
    st.settle("s", [user(1, "ok")]);
    expect(list("s")).toHaveLength(1);
    st.settle("s", [user(1, "ok"), user(2, "ok")]);
    expect(list("s")).toHaveLength(0);
  });

  it("moves the message of a started session to its id and drops it on failure or when very old", () => {
    vi.useFakeTimers();
    const st = usePendingMessages.getState();
    const id = st.add("new:p:", { text: "Hallo", files: ["a.png"], afterSeq: 3 });
    st.move("new:p:", "s1");
    expect(list("new:p:")).toHaveLength(0);
    expect(list("s1")).toMatchObject([{ id, text: "Hallo", afterSeq: 0, files: ["a.png"] }]);
    st.remove("s1", id);
    expect(usePendingMessages.getState().pending).toEqual({});

    st.add("s2", { text: "hängt", files: [], afterSeq: 0 });
    vi.advanceTimersByTime(PENDING_MAX_AGE_MS + 1);
    st.settle("s2", []);
    expect(list("s2")).toHaveLength(0);
  });
});

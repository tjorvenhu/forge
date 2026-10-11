import { beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@forge/protocol";
import { buildEventItems, reuseStableItems } from "@/components/workspace/chat-items";
import { EVENT_PAGE_SIZE, pageHasOlder, useSessionEvents } from "./session-events";

const ev = (seq: number, text = `m${seq}`): SessionEvent => ({ seq, sessionId: "s", ts: "2026-10-10T12:00:00.000Z", body: { type: "user.message", text } });
/** events from..to inclusive */
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ev(from + i));
const seqs = () => useSessionEvents.getState().buffers.s!.events.map((e) => e.seq);
const buffer = () => useSessionEvents.getState().buffers.s!;

beforeEach(() => useSessionEvents.setState({ buffers: {} }));

describe("pageHasOlder", () => {
  it("is true only for a full page that does not start at the first event", () => {
    expect(pageHasOlder([])).toBe(false);
    expect(pageHasOlder(range(5, 10))).toBe(false);
    expect(pageHasOlder(range(1, EVENT_PAGE_SIZE))).toBe(false);
    expect(pageHasOlder(range(2, EVENT_PAGE_SIZE + 1))).toBe(true);
  });
});

describe("paged history", () => {
  const firstPage = range(EVENT_PAGE_SIZE + 1, 2 * EVENT_PAGE_SIZE);

  it("marks a full first page as having older events", () => {
    useSessionEvents.getState().setHistory("s", firstPage);
    expect(buffer().hasOlder).toBe(true);
    useSessionEvents.getState().setHistory("t", range(1, 3));
    expect(useSessionEvents.getState().buffers.t!.hasOlder).toBe(false);
  });

  it("prepends an older page in ascending order without duplicates and keeps live events", () => {
    const st = useSessionEvents.getState();
    st.setHistory("s", firstPage);
    st.apply(ev(2 * EVENT_PAGE_SIZE + 1, "live"));
    // The older page overlaps by one event; the overlap must not show twice.
    st.prependOlder("s", range(2, EVENT_PAGE_SIZE + 1));
    const s = seqs();
    expect(s.length).toBe(2 * EVENT_PAGE_SIZE);
    expect(s[0]).toBe(2);
    expect(s.at(-1)).toBe(2 * EVENT_PAGE_SIZE + 1);
    expect(s.every((v, i) => i === 0 || v > s[i - 1]!)).toBe(true);
    expect(buffer().lastSeq).toBe(2 * EVENT_PAGE_SIZE + 1);
    expect(buffer().hasOlder).toBe(true);

    st.prependOlder("s", [ev(1)]);
    expect(seqs()[0]).toBe(1);
    expect(buffer().hasOlder).toBe(false);
    // A live event after the prepend still appends.
    st.apply(ev(2 * EVENT_PAGE_SIZE + 2, "next"));
    expect(seqs().at(-1)).toBe(2 * EVENT_PAGE_SIZE + 2);
  });

  it("ignores a page for a buffer that was dropped or is reloading", () => {
    const st = useSessionEvents.getState();
    st.prependOlder("s", range(1, 3));
    expect(useSessionEvents.getState().buffers.s).toBeUndefined();
    st.setHistory("s", range(10, 12));
    st.markAllStale();
    st.prependOlder("s", range(1, 3));
    expect(seqs()).toEqual([10, 11, 12]);
  });

  it("keeps loaded older pages when the history reloads after a sidecar restart", () => {
    const st = useSessionEvents.getState();
    st.setHistory("s", range(101, 100 + EVENT_PAGE_SIZE));
    st.prependOlder("s", range(51, 100));
    expect(buffer().hasOlder).toBe(false);
    st.markAllStale();
    // Two events were missed: the reloaded newest page starts two events later.
    st.setHistory("s", range(103, 102 + EVENT_PAGE_SIZE));
    expect(seqs()[0]).toBe(51);
    expect(seqs().length).toBe(EVENT_PAGE_SIZE + 52);
    expect(buffer().hasOlder).toBe(false);
  });

  it("drops loaded events that would leave a hole after a long outage", () => {
    const st = useSessionEvents.getState();
    st.setHistory("s", range(1, 10));
    st.markAllStale();
    st.setHistory("s", range(EVENT_PAGE_SIZE + 1, 2 * EVENT_PAGE_SIZE));
    expect(seqs()[0]).toBe(EVENT_PAGE_SIZE + 1);
    expect(buffer().hasOlder).toBe(true);
  });
});

describe("chat items after a prepend", () => {
  it("keeps the identity of the rows that were already shown", () => {
    const newer = range(4, 6);
    const before = buildEventItems(newer);
    const after = reuseStableItems(before, buildEventItems([...range(1, 3), ...newer]));
    expect(after.map((i) => i.key)).toEqual(["u1", "u2", "u3", "u4", "u5", "u6"]);
    expect(after.slice(3)).toEqual(before);
    after.slice(3).forEach((item, i) => expect(item).toBe(before[i]));
  });
});

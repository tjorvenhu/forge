import { afterEach, describe, expect, it } from "vitest";
import { RelayCore, crewRelay } from "./crew-relay";

const ROOM = "abcdefghijklmnopqrstuv";
const msg = (from = "m1") => JSON.stringify({ from, kid: "room:1", iv: "aaa", tag: "bbb", data: "ccc" });

function reader() {
  const chunks: string[] = [];
  let closed = false;
  return { chunks, closed: () => closed, write: (c: string) => void chunks.push(c), close: () => void (closed = true) };
}

let core: RelayCore;
afterEach(() => core?.close());

describe("crew relay", () => {
  it("numbers messages, replays what a reader missed and then streams live", () => {
    core = new RelayCore();
    expect(core.post(ROOM, msg(), "ip")).toEqual({ status: 200, body: { seq: 1 } });
    expect(core.post(ROOM, msg(), "ip").body).toEqual({ seq: 2 });
    const r = reader();
    const sub = core.subscribe(ROOM, 1, r);
    expect("stop" in sub).toBe(true);
    expect(r.chunks[0]).toMatch(/^id: 2\ndata: \{"seq":2,/);
    expect(r.chunks[1]).toBe('event: ready\ndata: {"seq":2}\n\n');
    core.post(ROOM, msg("m2"), "ip");
    expect(r.chunks[2]).toMatch(/^id: 3\ndata: .*"from":"m2"/);
    if ("stop" in sub) sub.stop();
    core.post(ROOM, msg(), "ip");
    expect(r.chunks).toHaveLength(3);
  });

  it("tells a reader about a gap when the relay no longer has what it missed", () => {
    core = new RelayCore({ maxMessages: 2 });
    for (let i = 0; i < 4; i++) core.post(ROOM, msg(), "ip");
    const r = reader();
    core.subscribe(ROOM, 1, r);
    expect(r.chunks[0]).toBe("event: gap\ndata: {}\n\n");
    // A reader ahead of the relay (it restarted) also gets a gap.
    const late = reader();
    core.subscribe("zyxwvutsrqponmlkjihgfe", 10, late);
    expect(late.chunks[0]).toBe("event: gap\ndata: {}\n\n");
  });

  it("refuses invalid rooms and messages, large bodies and floods", () => {
    core = new RelayCore({ postsPerMinute: 2, maxBodyBytes: 100 });
    expect(core.post("kurz", msg(), "ip").status).toBe(404);
    expect(core.post(ROOM, "kein json", "ip").status).toBe(400);
    expect(core.post(ROOM, null, "ip2").status).toBe(413);
    expect(core.post(ROOM, JSON.stringify({ from: "m1", kid: "room:1", iv: "a", tag: "b", data: "<script>" }), "ip3").status).toBe(400);
    expect(core.post(ROOM, msg(), "ip4").status).toBe(200);
    expect(core.post(ROOM, msg(), "ip4").status).toBe(200);
    expect(core.post(ROOM, msg(), "ip4").status).toBe(429);
  });

  it("drops old messages and empty rooms", () => {
    let now = 1_000_000;
    core = new RelayCore({ ttlMs: 1000, now: () => now });
    core.post(ROOM, msg(), "ip");
    now += 5000;
    core.prune();
    expect(core.stats().rooms).toBe(0);
  });

  it("is one instance for all routes of the process", () => {
    expect(crewRelay()).toBe(crewRelay());
  });
});

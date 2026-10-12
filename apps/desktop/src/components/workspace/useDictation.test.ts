import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ServerEvent } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
const listeners = new Set<(e: ServerEvent) => void>();
vi.mock("@/lib/rpc", async (orig) => ({
  ...(await orig<typeof RpcModuleNs>()),
  rpc: {
    call: (...a: unknown[]) => callMock(...a),
    subscribe: (l: (e: ServerEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  },
}));

const { useDictation } = await import("./useDictation");
const { useToasts } = await import("@/stores/toast");

const RATE = 16_000;
const BLOCK = 4096;

/** Stands in for the Web Audio graph: `feed` delivers microphone blocks like the browser does. */
class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  readonly sampleRate = RATE;
  readonly destination = {};
  proc = { onaudioprocess: null as ((e: { inputBuffer: { length: number; getChannelData: () => Float32Array } }) => void) | null, connect: vi.fn(), disconnect: vi.fn() };
  closed = false;
  constructor() {
    FakeAudioContext.last = this;
  }
  createMediaStreamSource() {
    return { connect: vi.fn() };
  }
  createScriptProcessor() {
    return this.proc;
  }
  async close() {
    this.closed = true;
  }
  feed(blocks: number, level = 0.2) {
    for (let i = 0; i < blocks; i++) {
      const block = new Float32Array(BLOCK).fill(level);
      this.proc.onaudioprocess!({ inputBuffer: { length: BLOCK, getChannelData: () => block } });
    }
  }
}

const track = { stop: vi.fn() };
const calls = (method: string) => callMock.mock.calls.filter(([m]) => m === method).map(([, p]) => p as Record<string, unknown>);

/** voice.start answers when `open` is called; the rest answers at once. */
function serviceAnswers(stopText = "Bitte die Tests ausführen.") {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  callMock.mockImplementation(async (method: string) => {
    if (method === "voice.start") {
      await opened;
      return { id: "v1" };
    }
    if (method === "voice.stop") return { text: stopText };
    return {};
  });
  return { open };
}

beforeEach(() => {
  callMock.mockReset();
  track.stop.mockReset();
  listeners.clear();
  useToasts.setState({ toasts: [] });
  vi.stubGlobal("AudioContext", FakeAudioContext);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useDictation", () => {
  it("streams the microphone to Claude, shows the live text and hands over the result", async () => {
    const { open } = serviceAnswers();
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText, ["FORGE"]));
    await act(async () => {
      void result.current.start();
      await waitFor(() => expect(FakeAudioContext.last?.proc.onaudioprocess).toBeTruthy());
    });
    expect(calls("voice.start")).toEqual([{ language: "de", keyterms: ["FORGE"] }]);
    expect(result.current.state).toBe("recording");

    // Words spoken before the connection is open wait and go out in order.
    act(() => FakeAudioContext.last!.feed(2));
    expect(calls("voice.audio")).toHaveLength(0);
    await act(async () => open());
    await waitFor(() => expect(calls("voice.audio")).toHaveLength(2));
    act(() => FakeAudioContext.last!.feed(2));
    expect(calls("voice.audio")).toHaveLength(4);
    expect(calls("voice.audio")[0]).toMatchObject({ id: "v1" });
    expect(atob(calls("voice.audio")[0]!.pcm as string).length).toBe(BLOCK * 2);

    act(() => listeners.forEach((l) => l({ event: "voice.transcript", payload: { id: "v1", text: "Bitte die" } })));
    expect(result.current.live).toBe("Bitte die");
    act(() => listeners.forEach((l) => l({ event: "voice.transcript", payload: { id: "other", text: "fremd" } })));
    expect(result.current.live).toBe("Bitte die");

    await act(() => result.current.stop());
    expect(calls("voice.stop")).toEqual([{ id: "v1" }]);
    expect(onText).toHaveBeenCalledWith("Bitte die Tests ausführen.");
    expect(result.current).toMatchObject({ state: "idle", live: "" });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeAudioContext.last!.closed).toBe(true);
  });

  it("keeps what was said when stopped before the connection is open", async () => {
    const { open } = serviceAnswers("Kurz.");
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText, []));
    await act(async () => {
      void result.current.start();
      await waitFor(() => expect(FakeAudioContext.last?.proc.onaudioprocess).toBeTruthy());
    });
    act(() => FakeAudioContext.last!.feed(3));
    let stopped!: Promise<void>;
    act(() => {
      stopped = result.current.stop();
    });
    await act(async () => {
      open();
      await stopped;
    });
    expect(calls("voice.audio")).toHaveLength(3);
    expect(callMock.mock.calls.map(([m]) => m).at(-1)).toBe("voice.stop");
    expect(onText).toHaveBeenCalledWith("Kurz.");
    expect(calls("voice.cancel")).toHaveLength(0);
  });

  it("drops a cancelled recording", async () => {
    const { open } = serviceAnswers();
    const onText = vi.fn();
    const { result } = renderHook(() => useDictation(onText, []));
    await act(async () => {
      open();
      await result.current.start();
    });
    expect(result.current.state).toBe("recording");
    act(() => result.current.cancel());
    await waitFor(() => expect(calls("voice.cancel")).toEqual([{ id: "v1" }]));
    expect(calls("voice.stop")).toHaveLength(0);
    expect(onText).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
  });

  it("explains a refused microphone and a failed connection", async () => {
    callMock.mockResolvedValue({ id: "v1" });
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => Promise.reject(new DOMException("denied", "NotAllowedError"))) } });
    const first = renderHook(() => useDictation(vi.fn(), []));
    await act(() => first.result.current.start());
    expect(first.result.current.state).toBe("idle");
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ tone: "error", title: "Mikrofon nicht verfügbar", body: expect.stringMatching(/Datenschutz/) });
    await waitFor(() => expect(calls("voice.cancel")).toEqual([{ id: "v1" }]));

    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
    callMock.mockRejectedValue(new Error("Die Spracheingabe braucht die Anmeldung bei Claude (Pro oder Max)."));
    const second = renderHook(() => useDictation(vi.fn(), []));
    await act(() => second.result.current.start());
    expect(second.result.current.state).toBe("idle");
    expect(useToasts.getState().toasts.at(-1)).toMatchObject({ title: "Spracheingabe nicht gestartet", body: expect.stringMatching(/Anmeldung bei Claude/) });
    expect(track.stop).toHaveBeenCalled();
  });
});

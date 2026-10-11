import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { cardKey, useCardState, useCardStore } from "./card-state";
import { useSessionEvents } from "./session-events";
import { useTerminals } from "./terminals";

afterEach(cleanup);

describe("card state", () => {
  it("survives unmounting, like a chat row scrolled out of view", () => {
    const key = cardKey("s1", "r1", "reason");
    const first = renderHook(() => useCardState(key, ""));
    act(() => first.result.current[1]("zu riskant"));
    first.unmount();

    const second = renderHook(() => useCardState(key, ""));
    expect(second.result.current[0]).toBe("zu riskant");
    act(() => second.result.current[1]((cur) => `${cur}!`));
    expect(second.result.current[0]).toBe("zu riskant!");
  });

  it("is dropped together with the session buffer", () => {
    useCardStore.getState().set(cardKey("gone", "r", "sent"), true);
    useCardStore.getState().set(cardKey("kept", "r", "sent"), true);
    useSessionEvents.getState().setHistory("gone", []);
    useSessionEvents.getState().drop("gone");
    expect(useSessionEvents.getState().buffers.gone).toBeUndefined();
    expect(useCardStore.getState().values.has(cardKey("gone", "r", "sent"))).toBe(false);
    expect(useCardStore.getState().values.has(cardKey("kept", "r", "sent"))).toBe(true);
  });
});

describe("terminal tabs", () => {
  it("keeps tabs per project and falls back to the output tab when the shown one closes", () => {
    const t = useTerminals.getState();
    const a = t.add("pA", { program: "shell", cwd: "C:/a", claudePath: null });
    t.add("pB", { program: "shell", cwd: "C:/b", claudePath: null });
    const a2 = t.add("pA", { program: "shell", cwd: "C:/a", claudePath: null });

    const s = useTerminals.getState();
    expect(s.tabs.pA?.map((x) => x.label)).toEqual(["Terminal 1", "Terminal 2"]);
    expect(s.tabs.pB?.map((x) => x.cwd)).toEqual(["C:/b"]);
    expect(s.active.pA).toBe(a2);

    useTerminals.getState().remove("pA", a2);
    expect(useTerminals.getState().active.pA).toBe("output");
    expect(useTerminals.getState().tabs.pA?.map((x) => x.key)).toEqual([a]);
  });
});

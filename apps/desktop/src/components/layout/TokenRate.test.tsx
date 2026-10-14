import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTokensFlowing } from "./TokenRate";

describe("useTokensFlowing", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is hidden while nothing flows", () => {
    const { result } = renderHook(() => useTokensFlowing(0));
    expect(result.current).toBe(false);
  });

  it("stays through a short pause and hides after two quiet seconds", () => {
    const { result, rerender } = renderHook(({ rate }) => useTokensFlowing(rate), { initialProps: { rate: 42 } });
    expect(result.current).toBe(true);
    rerender({ rate: 0 });
    act(() => vi.advanceTimersByTime(1900));
    expect(result.current).toBe(true);
    rerender({ rate: 12 });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current).toBe(true);
    rerender({ rate: 0 });
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(false);
  });
});

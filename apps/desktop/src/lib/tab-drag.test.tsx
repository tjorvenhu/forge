import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isTornOff, movedEnough, TEAR_OFF_PX, useTabTearOff, windowPositionFor } from "./tab-drag";

afterEach(cleanup);

const strip = { top: 0, bottom: 48, left: 0, right: 1000 };
const viewport = { width: 1200, height: 800 };

describe("tab tear-off rules", () => {
  it("starts a drag only after a few pixels", () => {
    expect(movedEnough(3, 2)).toBe(false);
    expect(movedEnough(6, 0)).toBe(true);
  });

  it("tears off clearly below the strip or outside the window, not sideways in the strip", () => {
    expect(isTornOff(strip, 900, 30, viewport)).toBe(false);
    expect(isTornOff(strip, 500, 48 + TEAR_OFF_PX - 1, viewport)).toBe(false);
    expect(isTornOff(strip, 500, 48 + TEAR_OFF_PX + 1, viewport)).toBe(true);
    expect(isTornOff(strip, -5, 20, viewport)).toBe(true);
    expect(isTornOff(strip, 500, -1, viewport)).toBe(true);
  });

  it("puts the new window under the pointer, never off screen", () => {
    expect(windowPositionFor(800, 400)).toEqual({ x: 680, y: 384 });
    expect(windowPositionFor(10, 5)).toEqual({ x: 0, y: 0 });
  });
});

function Strip({ onTearOff, onClick }: { onTearOff: (id: string, p: { x: number; y: number }) => void; onClick: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { drag, handlers, consumeClick } = useTabTearOff(ref, onTearOff);
  return (
    <div ref={ref}>
      <button {...handlers("s1", "Titel")} onClick={() => !consumeClick() && onClick()}>
        Tab
      </button>
      {drag && <span data-testid="ghost">{drag.tornOff ? "lösen" : "ziehen"}</span>}
    </div>
  );
}

describe("useTabTearOff", () => {
  // jsdom lays nothing out: the strip's box is 0..0, so anything past TEAR_OFF_PX below it tears off.
  it("opens a window when the tab is dropped away from the strip and skips the click", () => {
    const onTearOff = vi.fn();
    const onClick = vi.fn();
    render(<Strip onTearOff={onTearOff} onClick={onClick} />);
    const tab = screen.getByText("Tab");
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 10, clientY: 10, pointerType: "mouse" });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 12, clientY: 20 });
    expect(screen.getByTestId("ghost").textContent).toBe("ziehen");
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 30, clientY: 200 });
    expect(screen.getByTestId("ghost").textContent).toBe("lösen");
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 30, clientY: 200, screenX: 500, screenY: 300 });
    fireEvent.click(tab);
    expect(onTearOff).toHaveBeenCalledWith("s1", { x: 380, y: 284 });
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ghost")).toBeNull();
  });

  it("keeps a plain click a click and a drag inside the strip a no-op", () => {
    const onTearOff = vi.fn();
    const onClick = vi.fn();
    render(<Strip onTearOff={onTearOff} onClick={onClick} />);
    const tab = screen.getByText("Tab");
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 10, clientY: 10, pointerType: "mouse" });
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 11, clientY: 10 });
    fireEvent.click(tab);
    expect(onClick).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(tab, { button: 0, pointerId: 2, clientX: 10, clientY: 10, pointerType: "mouse" });
    fireEvent.pointerMove(tab, { pointerId: 2, clientX: 60, clientY: 20 });
    fireEvent.pointerUp(tab, { pointerId: 2, clientX: 60, clientY: 20 });
    expect(onTearOff).not.toHaveBeenCalled();
  });

  it("cancels with Escape", () => {
    const onTearOff = vi.fn();
    render(<Strip onTearOff={onTearOff} onClick={() => {}} />);
    const tab = screen.getByText("Tab");
    fireEvent.pointerDown(tab, { button: 0, pointerId: 1, clientX: 10, clientY: 10, pointerType: "mouse" });
    fireEvent.pointerMove(tab, { pointerId: 1, clientX: 30, clientY: 200 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(tab, { pointerId: 1, clientX: 30, clientY: 200, screenX: 500, screenY: 300 });
    expect(onTearOff).not.toHaveBeenCalled();
  });
});

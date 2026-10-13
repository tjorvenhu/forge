import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { isTornOff, movedEnough, TEAR_OFF_PX, useTabTearOff } from "./tab-drag";

afterEach(cleanup);

/** The sidebar list: 240 px wide, 400 px high, at the left edge. */
const list = { top: 100, bottom: 500, left: 0, right: 240 };
const viewport = { width: 1200, height: 800 };

describe("tear-off rules", () => {
  it("starts a drag only after a few pixels", () => {
    expect(movedEnough(3, 2)).toBe(false);
    expect(movedEnough(6, 0)).toBe(true);
  });

  it("tears off clearly outside the list or the window, not inside it", () => {
    expect(isTornOff(list, 200, 300, viewport)).toBe(false);
    expect(isTornOff(list, 240 + TEAR_OFF_PX - 1, 300, viewport)).toBe(false);
    expect(isTornOff(list, 240 + TEAR_OFF_PX + 1, 300, viewport)).toBe(true);
    expect(isTornOff(list, 100, 500 + TEAR_OFF_PX + 1, viewport)).toBe(true);
    expect(isTornOff(list, -5, 300, viewport)).toBe(true);
  });
});

function List({ onTearOff, onClick }: { onTearOff: (id: string) => void; onClick: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { drag, handlers, consumeClick } = useTabTearOff(ref, onTearOff);
  return (
    <div
      ref={(el) => {
        ref.current = el;
        if (el) el.getBoundingClientRect = () => ({ ...list, x: 0, y: 100, width: 240, height: 400, toJSON: () => ({}) });
      }}
    >
      <button {...handlers("s1", "Titel")} onClick={() => !consumeClick() && onClick()}>
        Session
      </button>
      {drag && <span data-testid="ghost">{drag.label}</span>}
    </div>
  );
}

const down = (el: HTMLElement, pointerId = 1) => fireEvent.pointerDown(el, { button: 0, pointerId, clientX: 100, clientY: 200, pointerType: "mouse" });

describe("useTabTearOff", () => {
  it("tears off as soon as the entry leaves the list, before the button is released", () => {
    const onTearOff = vi.fn();
    const onClick = vi.fn();
    render(<List onTearOff={onTearOff} onClick={onClick} />);
    const entry = screen.getByText("Session");
    down(entry);
    fireEvent.pointerMove(entry, { pointerId: 1, clientX: 150, clientY: 210 });
    expect(screen.getByTestId("ghost").textContent).toBe("Titel");
    expect(onTearOff).not.toHaveBeenCalled();
    fireEvent.pointerMove(entry, { pointerId: 1, clientX: 400, clientY: 220 });
    expect(onTearOff).toHaveBeenCalledWith("s1");
    expect(screen.queryByTestId("ghost")).toBeNull();
    // Further moves and the release belong to the new window.
    fireEvent.pointerMove(entry, { pointerId: 1, clientX: 600, clientY: 220 });
    fireEvent.pointerUp(entry, { pointerId: 1 });
    fireEvent.click(entry);
    expect(onTearOff).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps a plain click a click and a drag inside the list a no-op", () => {
    const onTearOff = vi.fn();
    const onClick = vi.fn();
    render(<List onTearOff={onTearOff} onClick={onClick} />);
    const entry = screen.getByText("Session");
    down(entry);
    fireEvent.pointerUp(entry, { pointerId: 1 });
    fireEvent.click(entry);
    expect(onClick).toHaveBeenCalledTimes(1);

    down(entry, 2);
    fireEvent.pointerMove(entry, { pointerId: 2, clientX: 180, clientY: 260 });
    fireEvent.pointerUp(entry, { pointerId: 2 });
    fireEvent.click(entry);
    expect(onTearOff).not.toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("cancels with Escape", () => {
    const onTearOff = vi.fn();
    render(<List onTearOff={onTearOff} onClick={() => {}} />);
    const entry = screen.getByText("Session");
    down(entry);
    fireEvent.pointerMove(entry, { pointerId: 1, clientX: 150, clientY: 210 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerMove(entry, { pointerId: 1, clientX: 400, clientY: 220 });
    expect(onTearOff).not.toHaveBeenCalled();
  });
});

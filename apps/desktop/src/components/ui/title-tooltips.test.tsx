import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TitleTooltips } from "./title-tooltips";

describe("TitleTooltips", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows a FORGE tooltip instead of the native one and restores the title afterwards", () => {
    render(
      <>
        <TitleTooltips />
        <button title="Ton anhören">
          <span>Fertig</span>
        </button>
      </>,
    );
    const button = screen.getByRole("button");
    fireEvent.pointerOver(screen.getByText("Fertig"));
    expect(button.hasAttribute("title")).toBe(false);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole("tooltip").textContent).toBe("Ton anhören");

    fireEvent.pointerOut(button, { relatedTarget: document.body });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("Ton anhören");
  });

  it("hides on click and keeps the title when React changed it meanwhile", () => {
    render(
      <>
        <TitleTooltips />
        <button title="Alt">x</button>
      </>,
    );
    const button = screen.getByRole("button");
    fireEvent.pointerOver(button);
    act(() => vi.advanceTimersByTime(450));
    button.setAttribute("title", "Neu");
    fireEvent.pointerDown(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("Neu");
  });
});

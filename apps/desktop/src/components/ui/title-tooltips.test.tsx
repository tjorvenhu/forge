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

  it("keeps the accessible name of an icon-only button while the title is removed", () => {
    render(
      <>
        <TitleTooltips />
        <button title="Status aktualisieren">
          <svg aria-hidden />
        </button>
        <button title="Hinweis">Speichern</button>
      </>,
    );
    const icon = screen.getByRole("button", { name: "Status aktualisieren" });
    fireEvent.pointerOver(icon);
    expect(icon.hasAttribute("title")).toBe(false);
    expect(screen.getByRole("button", { name: "Status aktualisieren" })).toBe(icon);

    fireEvent.pointerOut(icon, { relatedTarget: document.body });
    expect(icon.hasAttribute("aria-label")).toBe(false);
    expect(icon.getAttribute("title")).toBe("Status aktualisieren");

    const text = screen.getByRole("button", { name: "Speichern" });
    fireEvent.pointerOver(text);
    expect(text.hasAttribute("aria-label")).toBe(false);
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

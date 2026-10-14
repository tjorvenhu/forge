import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TipText, TitleTooltips } from "./title-tooltips";

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

  it("shows the next tooltip at once when the pointer moves straight on, and waits again after a click", () => {
    render(
      <>
        <TitleTooltips />
        <button title="Eins">a</button>
        <button title="Zwei">b</button>
      </>,
    );
    const [one, two] = screen.getAllByRole("button");
    fireEvent.pointerOver(one!);
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole("tooltip").textContent).toBe("Eins");
    fireEvent.pointerOut(one!, { relatedTarget: two });
    fireEvent.pointerOver(two!);
    act(() => vi.advanceTimersByTime(10));
    expect(screen.getByRole("tooltip").textContent).toBe("Zwei");

    fireEvent.pointerDown(two!);
    fireEvent.pointerOut(two!, { relatedTarget: one });
    fireEvent.pointerOver(one!);
    act(() => vi.advanceTimersByTime(10));
    expect(screen.queryByRole("tooltip")).toBeNull();
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

  it("mutes the title of an enclosing element so only one tooltip shows", () => {
    render(
      <>
        <TitleTooltips />
        <button title="Außen">
          <span>Text</span>
          <span title="Innen">Bild</span>
        </button>
      </>,
    );
    const outer = screen.getByRole("button");
    const inner = screen.getByText("Bild");
    fireEvent.pointerOver(inner);
    expect(outer.hasAttribute("title")).toBe(false);
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole("tooltip").textContent).toBe("Innen");

    fireEvent.pointerOut(inner, { relatedTarget: screen.getByText("Text") });
    fireEvent.pointerOver(screen.getByText("Text"));
    expect(inner.getAttribute("title")).toBe("Innen");
    expect(outer.hasAttribute("title")).toBe(false);
    act(() => vi.advanceTimersByTime(10));
    expect(screen.getByRole("tooltip").textContent).toBe("Außen");

    fireEvent.pointerOut(outer, { relatedTarget: document.body });
    expect(outer.getAttribute("title")).toBe("Außen");
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

describe("TipText", () => {
  afterEach(cleanup);

  it("turns a heading, list items and a shortcut into structure", () => {
    const { container } = render(<TipText text={"Untere Leiste einblenden (Strg+J)\n- Terminal\n- Dev-Server\n\nKlicken zum Öffnen."} />);
    expect(screen.getByText("Untere Leiste einblenden").className).toContain("min-w-0");
    expect(screen.getByText("Untere Leiste einblenden").parentElement!.className).toContain("font-medium");
    expect(container.querySelector("kbd")!.textContent).toBe("Strg+J");
    expect(screen.getByText("Terminal").previousElementSibling!.textContent).toBe("-");
    expect(screen.getByText("Klicken zum Öffnen.").parentElement!.className).toContain("text-muted");
  });

  it("keeps a single line plain", () => {
    const { container } = render(<TipText text="Ton anhören" />);
    expect(container.textContent).toBe("Ton anhören");
    expect(container.querySelector(".font-medium")).toBeNull();
    expect(container.querySelector("kbd")).toBeNull();
  });
});

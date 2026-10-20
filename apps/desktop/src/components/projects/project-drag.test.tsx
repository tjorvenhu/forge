import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProjectWithStatus } from "@forge/protocol";
import { dropTargetProps, startProjectDrag, useProjectDrag } from "./project-drag";

const shop = { id: "p1", name: "Shop", group: "Kunde Meyer", parentId: null } as ProjectWithStatus;

function setup(onDrop = vi.fn(), onClick = vi.fn()) {
  render(
    <div>
      <section {...dropTargetProps("kunde meyer", "Kunde Meyer")}>
        <button onPointerDown={(e) => startProjectDrag(e, shop, onDrop)} onClick={onClick}>
          Shop
        </button>
      </section>
      <section {...dropTargetProps("vanturis", "Vanturis")}>
        <span>Vanturis</span>
      </section>
      <section {...dropTargetProps("", null)}>
        <span>Ohne Gruppe</span>
      </section>
    </div>,
  );
  return { onDrop, onClick, card: screen.getByText("Shop") };
}

/** jsdom has no layout: the element "under the pointer" is whatever the test says. */
function pointAt(el: Element) {
  document.elementFromPoint = () => el;
}

const move = (x: number, y: number) => window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));
const up = (x: number, y: number) => window.dispatchEvent(new MouseEvent("pointerup", { clientX: x, clientY: y }));

afterEach(async () => {
  cleanup();
  useProjectDrag.setState({ project: null, over: null });
  // The click swallowed after a drop is only waited for until the next task.
  await new Promise((r) => setTimeout(r, 0));
});

describe("dragging a project onto a group", () => {
  it("moves it into the group under the pointer and swallows the click of the release", () => {
    const { onDrop, onClick, card } = setup();
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    pointAt(screen.getByText("Vanturis"));
    move(40, 80);
    expect(useProjectDrag.getState().project?.id).toBe("p1");
    expect(useProjectDrag.getState().over).toEqual({ key: "vanturis", name: "Vanturis" });
    up(40, 80);
    fireEvent.click(card);
    expect(onDrop).toHaveBeenCalledWith(shop, "Vanturis");
    expect(onClick).not.toHaveBeenCalled();
    expect(useProjectDrag.getState().project).toBeNull();
  });

  it("takes it out of its group on the section without group", () => {
    const { onDrop, card } = setup();
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    pointAt(screen.getByText("Ohne Gruppe"));
    move(40, 200);
    up(40, 200);
    expect(onDrop).toHaveBeenCalledWith(shop, null);
  });

  it("does nothing on its own group, and a short wiggle stays a click", () => {
    const { onDrop, onClick, card } = setup();
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    pointAt(card);
    move(12, 12);
    expect(useProjectDrag.getState().project).toBeNull();
    up(12, 12);
    fireEvent.click(card);
    expect(onClick).toHaveBeenCalledOnce();

    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    move(60, 10);
    expect(useProjectDrag.getState().over).toBeNull();
    up(60, 10);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("cancels with Escape", () => {
    const { onDrop, card } = setup();
    fireEvent.pointerDown(card, { button: 0, clientX: 10, clientY: 10 });
    pointAt(screen.getByText("Vanturis"));
    move(40, 80);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useProjectDrag.getState().project).toBeNull();
    up(40, 80);
    expect(onDrop).not.toHaveBeenCalled();
  });
});

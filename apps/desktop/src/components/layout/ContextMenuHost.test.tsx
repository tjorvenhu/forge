import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { contextItems } from "@/lib/context-menu";
import { useUi } from "@/stores/ui";
import { ContextMenuHost } from "./ContextMenuHost";

afterEach(cleanup);

describe("FORGE right-click menu", () => {
  it("shows the entries of the clicked element first, then the search, and runs the chosen one", async () => {
    const onCopy = vi.fn();
    render(
      <>
        <div onContextMenu={contextItems(() => [{ label: "Nachricht kopieren", onSelect: onCopy }])}>Hallo</div>
        <ContextMenuHost />
      </>,
    );
    const event = fireEvent.contextMenu(screen.getByText("Hallo"), { clientX: 40, clientY: 50 });
    // The browser's own menu stays closed.
    expect(event).toBe(false);
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Nachricht kopieren", "Suchen und BefehleStrg+K"]);
    fireEvent.click(items[0]!);
    expect(onCopy).toHaveBeenCalledOnce();

    fireEvent.contextMenu(screen.getByText("Hallo"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Suchen und Befehle/ }));
    expect(useUi.getState().paletteOpen).toBe(true);
  });

  it("offers cut, copy and paste in a text field", async () => {
    render(
      <>
        <input aria-label="Feld" defaultValue="abc" />
        <ContextMenuHost search={false} />
      </>,
    );
    const field = screen.getByLabelText<HTMLInputElement>("Feld");
    field.setSelectionRange(0, 2);
    fireEvent.contextMenu(field);
    const labels = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    expect(labels).toEqual(["RückgängigStrg+Z", "WiederholenStrg+Y", "AusschneidenStrg+X", "KopierenStrg+C", "EinfügenStrg+V", "Alles auswählenStrg+A"]);
  });

  it("leaves a right click alone that a component handles itself", () => {
    render(
      <>
        <div onContextMenu={(e) => e.preventDefault()}>Eigenes Menü</div>
        <ContextMenuHost />
      </>,
    );
    fireEvent.contextMenu(screen.getByText("Eigenes Menü"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

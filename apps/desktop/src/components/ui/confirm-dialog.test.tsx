import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "./confirm-dialog";

afterEach(cleanup);

const noop = () => {};

describe("ConfirmDialog layout", () => {
  it("has only header and buttons when there is no content", () => {
    render(<ConfirmDialog open onOpenChange={noop} title="Branch löschen?" description="Text" confirmLabel="Löschen" onConfirm={noop} />);
    const sections = Array.from(screen.getByRole("dialog").children);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.className).not.toContain("border-b");
  });

  it("shows the content between header and buttons", () => {
    render(
      <ConfirmDialog open onOpenChange={noop} title="Agent entfernen?" confirmLabel="Entfernen" onConfirm={noop}>
        <p>Inhalt</p>
      </ConfirmDialog>,
    );
    const sections = Array.from(screen.getByRole("dialog").children);
    expect(sections).toHaveLength(3);
    expect(screen.getByText("Inhalt")).toBeTruthy();
  });

  it("keeps the typed confirmation as content", () => {
    render(<ConfirmDialog open onOpenChange={noop} title="Löschen?" confirmLabel="Löschen" requireText="LÖSCHEN" onConfirm={noop} />);
    expect(Array.from(screen.getByRole("dialog").children)).toHaveLength(3);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });
});

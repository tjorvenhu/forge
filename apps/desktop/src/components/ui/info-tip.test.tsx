import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { InfoTip, LabelWithDescription, ToggleRow } from "./misc";

afterEach(cleanup);

const LONG =
  "Ohne PIN kann jeder, der die Nummer kennt, FORGE bedienen. Mit PIN fragt FORGE sie zu Beginn jedes Anrufs ab und legt nach drei falschen Versuchen auf.";

describe("InfoTip", () => {
  it("shows the explanation as a tooltip on focus, not inline", async () => {
    render(
      <TooltipProvider>
        <InfoTip>Gilt ab dem nächsten Start.</InfoTip>
      </TooltipProvider>,
    );
    expect(screen.queryByText("Gilt ab dem nächsten Start.")).toBeNull();
    fireEvent.focus(screen.getByRole("button", { name: "Info" }));
    expect((await screen.findByRole("tooltip")).textContent).toContain("Gilt ab dem nächsten Start.");
  });

  it("does not toggle the checkbox of a ToggleRow when clicked", () => {
    const onChange = vi.fn();
    render(
      <TooltipProvider>
        <ToggleRow checked={false} onChange={onChange} label="PIN verlangen">
          {LONG}
        </ToggleRow>
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Info" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("PIN verlangen"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("LabelWithDescription", () => {
  it("shows a short explanation as text, a long one behind an InfoTip", () => {
    render(
      <TooltipProvider>
        <LabelWithDescription description="Leer gilt die globale Einstellung.">Modell</LabelWithDescription>
        <LabelWithDescription description={LONG}>Git</LabelWithDescription>
      </TooltipProvider>,
    );
    expect(screen.getByText("Leer gilt die globale Einstellung.")).toBeTruthy();
    expect(screen.queryByText(LONG)).toBeNull();
    expect(screen.getAllByRole("button", { name: "Info" })).toHaveLength(1);
  });
});

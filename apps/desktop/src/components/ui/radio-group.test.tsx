import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RadioGroup } from "./radio-group";

afterEach(cleanup);

const options = [
  { value: "private", label: "Privat" },
  { value: "public", label: "Öffentlich" },
] as const;

describe("RadioGroup", () => {
  it("exposes radios with the checked state and a single tab stop", () => {
    render(<RadioGroup aria-label="Sichtbarkeit" value="private" onChange={() => {}} options={[...options]} />);
    expect(screen.getByRole("radiogroup", { name: "Sichtbarkeit" })).toBeTruthy();
    const priv = screen.getByRole("radio", { name: "Privat" });
    const pub = screen.getByRole("radio", { name: "Öffentlich" });
    expect(priv.getAttribute("aria-checked")).toBe("true");
    expect(pub.getAttribute("aria-checked")).toBe("false");
    expect(priv.tabIndex).toBe(0);
    expect(pub.tabIndex).toBe(-1);
  });

  it("selects on click and with the arrow keys", () => {
    const onChange = vi.fn();
    render(<RadioGroup aria-label="Sichtbarkeit" value="private" onChange={onChange} options={[...options]} />);
    fireEvent.click(screen.getByRole("radio", { name: "Öffentlich" }));
    expect(onChange).toHaveBeenLastCalledWith("public");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Privat" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("public");
  });
});

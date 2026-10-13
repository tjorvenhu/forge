import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { hasUltrathink, withUltrathink } from "./ultrathink";

describe("ultrathink", () => {
  it("finds the keyword as a word, in any case", () => {
    expect(hasUltrathink("geht ultrathink?")).toBe(true);
    expect(hasUltrathink("UltraThink bitte")).toBe(true);
    expect(hasUltrathink("ultrathinking")).toBe(false);
    expect(hasUltrathink("think hard")).toBe(false);
  });

  it("colors only the keyword and keeps the text around it", () => {
    const { container } = render(<div>{withUltrathink("Erst ultrathink, dann ULTRATHINK.")}</div>);
    expect(container.textContent).toBe("Erst ultrathink, dann ULTRATHINK.");
    expect([...container.querySelectorAll(".ultrathink-text")].map((e) => e.textContent)).toEqual(["ultrathink", "ULTRATHINK"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TabBar } from "./tabs";

/** Width jsdom reports for the bar; every tab is 100 px wide with its label and 40 px without. */
let barWidth = 1000;
let resize: (() => void) | null = null;
/** Width of the Chat tab with its label, before and after the web font has loaded. */
let chatWidth = 100;
let observed: Element[] = [];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        resize = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {
        observed = [];
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "tablist" ? barWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute("role") !== "tab") return 0;
    if (!this.textContent) return 40;
    return this.textContent === "ChatChat" ? chatWidth : 100;
  });
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
    const tabs = Array.from(this.parentElement?.querySelectorAll('[role="tab"]') ?? []);
    const i = tabs.indexOf(this);
    return i < 0 ? 0 : tabs.slice(0, i).reduce((x, t) => x + (t as HTMLElement).offsetWidth, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  barWidth = 1000;
  chatWidth = 100;
  observed = [];
});

const tabs = [
  { value: "chat", label: "Chat", icon: <svg /> },
  { value: "git", label: "Git", icon: <svg /> },
  { value: "files", label: "Dateien", icon: <svg /> },
] as const;

function Bar() {
  return <TabBar<string> fit size="lg" value="chat" onChange={() => {}} tabs={[...tabs]} />;
}

describe("TabBar fit", () => {
  it("shows labels while they fit", () => {
    render(<Bar />);
    expect(screen.getByRole("tab", { name: "Dateien" }).textContent).toContain("Dateien");
    expect(screen.getByRole("tab", { name: "Dateien" }).getAttribute("title")).toBeNull();
  });

  it("drops the labels to icons with tooltips when the bar is too narrow, and brings them back", () => {
    barWidth = 250;
    render(<Bar />);
    const files = screen.getByRole("tab", { name: "Dateien" });
    expect(files.textContent).toBe("");
    expect(files.getAttribute("title")).toBe("Dateien");

    barWidth = 299;
    act(() => resize?.());
    expect(screen.getByRole("tab", { name: "Dateien" }).textContent).toBe("");

    barWidth = 300;
    act(() => resize?.());
    expect(screen.getByRole("tab", { name: "Dateien" }).textContent).toContain("Dateien");
    expect(screen.getByRole("tab", { name: "Dateien" }).getAttribute("title")).toBeNull();
  });
});

describe("TabBar indicator", () => {
  it("follows a tab that grows while the bar keeps its width", () => {
    const { container } = render(<Bar />);
    const indicator = () => (container.querySelector("[data-tab-indicator]") as HTMLElement).style.transform;
    expect(indicator()).toBe("translateX(4px) scaleX(0.92)");
    expect(observed).toContain(screen.getByRole("tab", { name: "Chat" }));

    chatWidth = 120;
    act(() => resize?.());
    expect(indicator()).toBe("translateX(4px) scaleX(1.12)");
  });
});

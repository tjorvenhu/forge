import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { useUi } from "@/stores/ui";
import { useGlobalShortcuts } from "./shortcuts";

function openDialog() {
  const el = document.createElement("div");
  el.setAttribute("role", "dialog");
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  useUi.setState({ bottomPanelOpen: false, paletteOpen: false });
  renderHook(() => useGlobalShortcuts());
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("global shortcuts", () => {
  it("toggles the bottom panel with Ctrl+J", () => {
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(useUi.getState().bottomPanelOpen).toBe(true);
  });

  it("switches workspace tabs in the order of the tab bar", () => {
    useUi.setState({ view: "workspace", workspaceTab: "chat" });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(useUi.getState().workspaceTab).toBe("agents");
    fireEvent.keyDown(window, { key: "5", ctrlKey: true });
    expect(useUi.getState().workspaceTab).toBe("settings");
  });

  it("ignores shortcuts while a dialog is open", () => {
    openDialog();
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useUi.getState().bottomPanelOpen).toBe(false);
    expect(useUi.getState().paletteOpen).toBe(false);
  });

  it("ignores keys another handler already took", () => {
    const e = new KeyboardEvent("keydown", { key: "j", ctrlKey: true, cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(useUi.getState().bottomPanelOpen).toBe(false);
  });

  it("still closes the open command palette with Ctrl+K", () => {
    useUi.setState({ paletteOpen: true });
    openDialog();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useUi.getState().paletteOpen).toBe(false);
  });
});

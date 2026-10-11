import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import type { ResultOf } from "@forge/protocol";
import { useUi } from "@/stores/ui";
import { keys, queryClient } from "@/lib/queries";
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

  it("cycles session tabs with Ctrl+Tab in the grouped order of the tab strip", () => {
    const tab = (id: string, projectId: string, createdAt: string) => ({ id, projectId, projectName: projectId, createdAt }) as ResultOf<"sessions.listLive">[number];
    // oldest per project first: app (a1, a2), then web (w1)
    queryClient.setQueryData(keys.liveSessions, [tab("a2", "app", "2026-10-11T10:03:00Z"), tab("w1", "web", "2026-10-11T10:02:00Z"), tab("a1", "app", "2026-10-11T10:01:00Z")]);
    useUi.setState({ view: "workspace", activeProjectId: "app", activeSession: { app: "a1" } });
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(useUi.getState().activeSession.app).toBe("a2");
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    expect(useUi.getState().activeProjectId).toBe("web");
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    expect(useUi.getState()).toMatchObject({ activeProjectId: "app", activeSession: { app: "a2" } });
    queryClient.removeQueries({ queryKey: keys.liveSessions });
  });

  it("still closes the open command palette with Ctrl+K", () => {
    useUi.setState({ paletteOpen: true });
    openDialog();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(useUi.getState().paletteOpen).toBe(false);
  });
});

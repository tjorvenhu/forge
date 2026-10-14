import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ServerEvent, SessionEvent } from "@forge/protocol";
import { useDrafts, type PendingFile } from "@/stores/drafts";
import { useSessionEvents } from "@/stores/session-events";
import { useUi } from "@/stores/ui";
import type * as NotificationsNs from "./notifications";
import { applyReattach, closeChatWindows, openChatWindow, parseChatWindowTarget, prepareChatWindowUi, recallChatWindow, useChatWindows } from "./chat-windows";
import { startChatWindowEvents } from "./chat-window-events";
import { keys } from "./queries";

type NotificationsModule = typeof NotificationsNs;

const playSound = vi.fn();
const notifySession = vi.fn(async () => {});
const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("./sounds", () => ({ playSound: () => playSound() }));
vi.mock("./notifications", async (orig) => ({ ...(await orig<NotificationsModule>()), notifySession: () => notifySession() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {}, emitTo: async () => {}, listen: async () => () => {} }));

beforeEach(() => {
  useUi.setState({ view: "home", activeProjectId: null, activeSession: {} });
  useDrafts.setState({ drafts: {} });
  useSessionEvents.setState({ buffers: {} });
  useChatWindows.setState({ sessions: [] });
  playSound.mockClear();
  notifySession.mockClear();
  invoke.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

const pathFile: PendingFile = { id: "f1", name: "plan.md", attachment: { kind: "path", path: "C:/plan.md" }, preview: null, isImage: false };
const imageWire = { name: "bild.png", isImage: true, attachment: { kind: "data" as const, name: "bild.png", mediaType: "image/png", base64: "QUJD" } };

describe("chat window target", () => {
  it("accepts what the shell hands over and rejects anything else", () => {
    expect(parseChatWindowTarget({ projectId: "p", sessionId: "s", draft: "hi" })).toEqual({ projectId: "p", sessionId: "s", draft: "hi", files: [] });
    expect(parseChatWindowTarget({ projectId: "p", sessionId: null })).toEqual({ projectId: "p", sessionId: null, draft: null, files: [] });
    expect(parseChatWindowTarget({ projectId: "p", sessionId: "s", files: [imageWire, { name: "x", attachment: { kind: "path" } }, "y"] })?.files).toEqual([imageWire]);
    expect(parseChatWindowTarget({ projectId: "", sessionId: "s" })).toBeNull();
    expect(parseChatWindowTarget({ sessionId: "s" })).toBeNull();
    expect(parseChatWindowTarget(undefined)).toBeNull();
    expect(parseChatWindowTarget("p")).toBeNull();
  });

  it("puts the chat window's UI on its session and takes the draft along", () => {
    prepareChatWindowUi({ projectId: "p", sessionId: "s", draft: "halb fertig" });
    const ui = useUi.getState();
    expect(ui.view).toBe("workspace");
    expect(ui.activeProjectId).toBe("p");
    expect(ui.activeSession.p).toBe("s");
    expect(useDrafts.getState().drafts.s?.text).toBe("halb fertig");
  });

  it("shows a chat that came back in the main window, with the text from the chat window", () => {
    useDrafts.getState().setText("s", "alter Text");
    applyReattach({ projectId: "p", sessionId: "s", draft: null });
    expect(useUi.getState().view).toBe("workspace");
    expect(useUi.getState().activeSession.p).toBe("s");
    // Sent from the chat window meanwhile: the old text must not come back.
    expect(useDrafts.getState().drafts.s?.text).toBe("");
  });

  it("brings the attachments along both ways, and old ones do not come back", () => {
    prepareChatWindowUi({ projectId: "p", sessionId: "s", files: [imageWire] });
    expect(useDrafts.getState().drafts.s?.files).toMatchObject([{ name: "bild.png", isImage: true, preview: "data:image/png;base64,QUJD" }]);

    useDrafts.getState().updateFiles("s", () => [pathFile]);
    applyReattach({ projectId: "p", sessionId: "s", draft: null, files: [] });
    expect(useDrafts.getState().drafts.s?.files).toEqual([]);
  });

  it("does not open a project that is gone, e.g. a finished agent", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.projects, [{ id: "app" }]);
    applyReattach({ projectId: "wt", sessionId: "s", draft: "Rest" }, qc);
    expect(useUi.getState()).toMatchObject({ view: "home", activeProjectId: null });
    applyReattach({ projectId: "app", sessionId: "s", draft: null }, qc);
    expect(useUi.getState()).toMatchObject({ view: "workspace", activeProjectId: "app" });
  });
});

describe("detaching a chat", () => {
  it("hands text and attachments to the new window and keeps no copy", async () => {
    useDrafts.getState().setText("s", "halb fertig");
    useDrafts.getState().updateFiles("s", () => [pathFile]);
    invoke.mockImplementation(async () => {
      // Taken before the window opens, not after.
      expect(useDrafts.getState().drafts.s).toMatchObject({ text: "", files: [] });
      return true;
    });
    await openChatWindow("p", "s", "Titel");
    expect(invoke).toHaveBeenCalledWith("open_chat_window", expect.objectContaining({
      target: { projectId: "p", sessionId: "s", draft: "halb fertig", files: [{ name: "plan.md", isImage: false, attachment: pathFile.attachment }] },
    }));
    expect(useDrafts.getState().drafts.s).toMatchObject({ text: "", files: [] });
  });

  it("keeps the draft when the window does not open or already existed", async () => {
    useDrafts.getState().setText("s", "halb fertig");
    useDrafts.getState().updateFiles("s", () => [pathFile]);
    invoke.mockRejectedValueOnce(new Error("kaputt"));
    await openChatWindow("p", "s", "Titel");
    expect(useDrafts.getState().drafts.s).toMatchObject({ text: "halb fertig", files: [pathFile] });

    invoke.mockResolvedValueOnce(false);
    await openChatWindow("p", "s", "Titel");
    expect(useDrafts.getState().drafts.s).toMatchObject({ text: "halb fertig", files: [pathFile] });
  });

  it("does not close a window opened again after a recall", () => {
    vi.useFakeTimers();
    useChatWindows.setState({ sessions: ["s"] });
    recallChatWindow("s");
    // The window answered; the user detached the chat again right away.
    useChatWindows.setState({ sessions: [] });
    useChatWindows.setState({ sessions: ["s"] });
    vi.advanceTimersByTime(5_000);
    expect(invoke).not.toHaveBeenCalledWith("close_chat_window", expect.anything());
  });

  it("closes a window that does not answer a recall", () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(undefined);
    useChatWindows.setState({ sessions: ["s"] });
    recallChatWindow("s");
    vi.advanceTimersByTime(5_000);
    expect(invoke).toHaveBeenCalledWith("close_chat_window", { sessionId: "s" });
  });

  it("closes the windows of deleted sessions only", () => {
    invoke.mockResolvedValue(undefined);
    useChatWindows.setState({ sessions: ["a", "b"] });
    closeChatWindows(new Set(["b", "c"]));
    expect(invoke.mock.calls).toEqual([["close_chat_window", { sessionId: "b" }]]);
  });
});

function fakeSource() {
  const listeners = new Set<(e: ServerEvent) => void>();
  return {
    source: {
      subscribe: (l: (e: ServerEvent) => void) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      onStatus: () => () => undefined,
    },
    emit: (e: ServerEvent) => listeners.forEach((l) => l(e)),
  };
}

const sessionEvent = (sessionId: string, seq: number, body: SessionEvent["body"]): ServerEvent =>
  ({ event: "session.event", payload: { sessionId, seq, ts: "2026-10-13T10:00:00.000Z", body } }) as ServerEvent;

describe("chat window events", () => {
  it("feeds only the shown chat and never sounds or notifies", () => {
    prepareChatWindowUi({ projectId: "p", sessionId: "s1" });
    const f = fakeSource();
    const stop = startChatWindowEvents(new QueryClient(), f.source);
    f.emit(sessionEvent("s1", 1, { type: "approval.request", toolName: "Bash" } as SessionEvent["body"]));
    f.emit(sessionEvent("other", 1, { type: "user.message", text: "x" }));
    expect(useSessionEvents.getState().buffers.s1?.events.map((e) => e.seq)).toEqual([1]);
    expect(useSessionEvents.getState().buffers.other).toBeUndefined();
    expect(playSound).not.toHaveBeenCalled();
    expect(notifySession).not.toHaveBeenCalled();
    stop();
  });
});

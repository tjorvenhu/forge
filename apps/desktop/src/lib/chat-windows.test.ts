import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { ServerEvent, SessionEvent } from "@forge/protocol";
import { useDrafts } from "@/stores/drafts";
import { useSessionEvents } from "@/stores/session-events";
import { useUi } from "@/stores/ui";
import type * as NotificationsNs from "./notifications";
import { applyReattach, parseChatWindowTarget, prepareChatWindowUi } from "./chat-windows";
import { startChatWindowEvents } from "./chat-window-events";

type NotificationsModule = typeof NotificationsNs;

const playSound = vi.fn();
const notifySession = vi.fn(async () => {});
vi.mock("./sounds", () => ({ playSound: () => playSound() }));
vi.mock("./notifications", async (orig) => ({ ...(await orig<NotificationsModule>()), notifySession: () => notifySession() }));

beforeEach(() => {
  useUi.setState({ view: "home", activeProjectId: null, activeSession: {} });
  useDrafts.setState({ drafts: {} });
  useSessionEvents.setState({ buffers: {} });
  playSound.mockClear();
  notifySession.mockClear();
});

describe("chat window target", () => {
  it("accepts what the shell hands over and rejects anything else", () => {
    expect(parseChatWindowTarget({ projectId: "p", sessionId: "s", draft: "hi" })).toEqual({ projectId: "p", sessionId: "s", draft: "hi" });
    expect(parseChatWindowTarget({ projectId: "p", sessionId: null })).toEqual({ projectId: "p", sessionId: null, draft: null });
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { AppUpdateState } from "@forge/protocol";
import { useChatWindows } from "./chat-windows";
import { keys } from "./queries";
import { installUpdate, reopenChatWindows, sessionsNote, useInstall } from "./app-install";
import type * as QueriesNs from "./queries";

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
const call = vi.fn<(method: string, params: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {}, emitTo: async () => {}, listen: async () => () => {} }));
vi.mock("./queries", async (orig) => ({ ...(await orig<typeof QueriesNs>()), call: (m: string, p: unknown) => call(m, p) }));

const ready: AppUpdateState = {
  currentVersion: "0.1.40",
  phase: "ready",
  latest: { version: "0.1.41", tag: "v0.1.41", notes: "", since: "0.1.40", publishedAt: null, size: null, kind: "patch", via: null },
  autoInstall: false,
  installerPath: "C:/tmp/forge-update/v0.1.41/u.zip",
  installable: true,
  checkedAt: null,
  message: null,
};

beforeEach(() => {
  invoke.mockReset();
  call.mockReset();
  localStorage.clear();
  useInstall.setState({ installing: false });
  useChatWindows.setState({ sessions: [], pinned: [] });
});

describe("installing an update", () => {
  it("notes the sessions in the sidecar before the shell ends FORGE, and remembers the chat windows", async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.appUpdate, ready);
    useChatWindows.setState({ sessions: ["s1"] });
    call.mockResolvedValue({ sessions: 2, working: 1 });
    invoke.mockResolvedValue(undefined);
    await installUpdate(qc);
    expect(call).toHaveBeenCalledWith("app.prepareInstall", { cancel: false });
    expect(invoke).toHaveBeenCalledWith("install_update", { path: ready.installerPath });
    expect(call.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[0]!);
    expect(JSON.parse(localStorage.getItem("forge.reopenChatWindows")!)).toMatchObject({ sessions: ["s1"] });
    expect(useInstall.getState().installing).toBe(true);
  });

  it("calls the restart off when the shell cannot install", async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.appUpdate, ready);
    useChatWindows.setState({ sessions: ["s1"] });
    call.mockResolvedValue({ sessions: 1, working: 0 });
    invoke.mockRejectedValue(new Error("Ungültiger Pfad"));
    await installUpdate(qc);
    expect(call).toHaveBeenLastCalledWith("app.prepareInstall", { cancel: true });
    expect(localStorage.getItem("forge.reopenChatWindows")).toBeNull();
    expect(useInstall.getState().installing).toBe(false);
  });

  it("opens the remembered chat windows once after the restart", async () => {
    localStorage.setItem("forge.reopenChatWindows", JSON.stringify({ at: Date.now(), sessions: ["s1", "gone"] }));
    call.mockImplementation(async (_m, p) => {
      if ((p as { sessionId: string }).sessionId === "gone") throw new Error("Session nicht gefunden.");
      return { id: "s1", projectId: "p1", title: "Export" };
    });
    invoke.mockResolvedValue(true);
    await reopenChatWindows();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("open_chat_window", expect.objectContaining({ target: expect.objectContaining({ projectId: "p1", sessionId: "s1" }), title: "Export" }));
    await reopenChatWindows();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps a pinned chat window pinned through the restart", async () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.appUpdate, ready);
    useChatWindows.setState({ sessions: ["s1", "s2"], pinned: ["s2"] });
    call.mockResolvedValue({ sessions: 2, working: 0 });
    invoke.mockResolvedValue(undefined);
    await installUpdate(qc);
    call.mockReset();
    invoke.mockReset();
    call.mockImplementation(async (_m, p) => ({ id: (p as { sessionId: string }).sessionId, projectId: "p1", title: "T" }));
    invoke.mockResolvedValue(true);
    await reopenChatWindows();
    expect(invoke).toHaveBeenCalledWith("open_chat_window", expect.objectContaining({ target: expect.objectContaining({ sessionId: "s1" }), pinned: false }));
    expect(invoke).toHaveBeenCalledWith("open_chat_window", expect.objectContaining({ target: expect.objectContaining({ sessionId: "s2" }), pinned: true }));
  });

  it("ignores chat windows of a restart long ago", async () => {
    localStorage.setItem("forge.reopenChatWindows", JSON.stringify({ at: Date.now() - 60 * 60_000, sessions: ["s1"] }));
    await reopenChatWindows();
    expect(call).not.toHaveBeenCalled();
  });

  it("says what happens to the sessions", () => {
    expect(sessionsNote(0, 0)).toBeNull();
    expect(sessionsNote(2, 0)).toBe("Offene Sessions bleiben nach dem Neustart offen.");
    expect(sessionsNote(3, 1)).toBe("Eine Session arbeitet gerade. Sie hält für den Neustart kurz an und macht danach von selbst weiter.");
    expect(sessionsNote(3, 2)).toBe("2 Sessions arbeiten gerade. Sie halten für den Neustart kurz an und machen danach von selbst weiter.");
  });
});

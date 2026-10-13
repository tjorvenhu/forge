import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { Project, ServerEvent, Session } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { draftKey, useDrafts } from "@/stores/drafts";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
const listeners = new Set<(e: ServerEvent) => void>();
vi.mock("@/lib/rpc", async (orig) => ({
  ...(await orig<RpcModule>()),
  rpc: {
    call: (...a: unknown[]) => callMock(...a),
    subscribe: (l: (e: ServerEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const { Composer } = await import("./Composer");

const project = (id: string, tags: string[] = []): Project => ({
  id,
  name: id,
  path: `C:\\${id}`,
  favorite: false,
  tags,
  technologies: [],
  profile: "balanced",
  defaultModel: null,
  defaultEffort: null,
  createdAt: "2026-10-10T00:00:00Z",
  lastOpenedAt: null,
  testCommand: null,
  devCommand: null,
  parentId: null,
  gitEnabled: true,
  exists: true,
});

const session: Session = {
  id: "s1",
  projectId: "p1",
  claudeSessionId: null,
  cwd: "C:\\p1",
  title: "Test",
  model: null,
  effort: null,
  profile: "balanced",
  permissionMode: "acceptEdits",
  status: "idle",
  apiKeySource: null,
  createdAt: "2026-10-10T00:00:00Z",
  updatedAt: "2026-10-10T00:00:00Z",
  lastError: null,
  live: true,
  background: [],
  subagents: [],
  context: null,
  autoContinueAt: null,
};

function setup(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (node: React.ReactNode) => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  );
  const r = render(wrap(ui));
  return { ...r, rerender: (node: React.ReactNode) => r.rerender(wrap(node)) };
}

beforeEach(() => {
  useDrafts.setState({ drafts: {} });
  callMock.mockReset();
  callMock.mockImplementation(async (method: string) => {
    if (method === "settings.get") return { enterToSend: true, defaultModel: null, defaultEffort: null, sounds: false };
    if (method === "system.runtimeInfo") return { models: [] };
    if (method === "sessions.send") return session;
    throw new Error("unexpected " + method);
  });
});
afterEach(cleanup);

describe("Composer", () => {
  it("sends the draft and clears it", async () => {
    useDrafts.getState().setText("s1", "Bitte testen");
    setup(<Composer project={project("p1")} session={session} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Senden" })));
    expect(callMock).toHaveBeenCalledWith("sessions.send", { sessionId: "s1", text: "Bitte testen", attachments: [] });
    await waitFor(() => expect(useDrafts.getState().drafts.s1?.text).toBe(""));
  });

  it("keeps what was typed while the message was on its way", async () => {
    let finish: (s: Session) => void = () => {};
    callMock.mockImplementation((method: string) => {
      if (method === "sessions.send") return new Promise<Session>((r) => (finish = r));
      if (method === "settings.get") return Promise.resolve({ enterToSend: true });
      return Promise.resolve({ models: [] });
    });
    useDrafts.getState().setText("s1", "Erste Nachricht");
    setup(<Composer project={project("p1")} session={session} />);
    fireEvent.keyDown(screen.getByLabelText("Nachricht an Claude"), { key: "Enter" });
    act(() => useDrafts.getState().setText("s1", "Zweite Nachricht"));
    await act(async () => finish(session));
    expect(useDrafts.getState().drafts.s1?.text).toBe("Zweite Nachricht");
  });

  it("keeps plan mode per project for a new session", () => {
    const planFirst = project("pA", ["plan-first"]);
    const plain = project("pB");
    const view = setup(<Composer key={draftKey("pA", null)} project={planFirst} session={null} />);
    const planButton = () => screen.getByRole("button", { name: /Planen/ });
    expect(planButton().getAttribute("aria-pressed")).toBe("true");

    view.rerender(<Composer key={draftKey("pB", null)} project={plain} session={null} />);
    expect(planButton().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(planButton());
    expect(planButton().getAttribute("aria-pressed")).toBe("true");

    view.rerender(<Composer key={draftKey("pA", null)} project={planFirst} session={null} />);
    fireEvent.click(planButton());
    expect(planButton().getAttribute("aria-pressed")).toBe("false");
    view.rerender(<Composer key={draftKey("pB", null)} project={plain} session={null} />);
    expect(planButton().getAttribute("aria-pressed")).toBe("true");
  });
});

describe("/clear", () => {
  it("starts over with an empty chat and ends the idle Claude process instead of sending", async () => {
    const { useUi } = await import("@/stores/ui");
    useUi.getState().setActiveSession("p1", "s1");
    callMock.mockImplementation(async (method: string) => {
      if (method === "settings.get") return { enterToSend: true };
      if (method === "sessions.close") return { ...session, live: false, status: "stopped" };
      return { models: [] };
    });
    useDrafts.getState().setText("s1", "/clear");
    setup(<Composer project={project("p1")} session={session} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Senden" })));
    expect(callMock).not.toHaveBeenCalledWith("sessions.send", expect.anything());
    expect(callMock).toHaveBeenCalledWith("sessions.close", { sessionId: "s1" });
    expect(useUi.getState().activeSession.p1).toBeNull();
    expect(useDrafts.getState().drafts.s1?.text).toBe("");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Nachricht an Claude" })));
  });

  it("leaves a working session running", async () => {
    const { useUi } = await import("@/stores/ui");
    useUi.getState().setActiveSession("p1", "s1");
    useDrafts.getState().setText("s1", "/reset");
    setup(<Composer project={project("p1")} session={{ ...session, status: "running" }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dazwischen senden" })));
    expect(callMock).not.toHaveBeenCalledWith("sessions.close", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("sessions.send", expect.anything());
    expect(useUi.getState().activeSession.p1).toBeNull();
  });
});

describe("isClearCommand", () => {
  it("accepts /clear and its aliases only as the whole input", async () => {
    const { isClearCommand } = await import("./SlashCommandMenu");
    expect(["/clear", " /CLEAR ", "/reset", "/new"].map(isClearCommand)).toEqual([true, true, true, true]);
    expect(["/clear bitte", "/compact", "clear", "/clearer"].map(isClearCommand)).toEqual([false, false, false, false]);
  });
});

describe("dictation", () => {
  it("puts the spoken text at the cursor with spaces to its neighbours", async () => {
    const { insertSpoken } = await import("./Composer");
    expect(insertSpoken("", 0, 0, "Hallo.")).toEqual({ text: "Hallo.", caret: 6 });
    expect(insertSpoken("Bitte", 5, 5, "die Tests")).toEqual({ text: "Bitte die Tests", caret: 15 });
    expect(insertSpoken("Bitte  ausführen", 6, 6, "testen")).toEqual({ text: "Bitte testen ausführen", caret: 12 });
    expect(insertSpoken("Mach ALT fertig", 5, 8, "das")).toEqual({ text: "Mach das fertig", caret: 8 });
  });

  it("dictates while space is held and tells Claude the project's words", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "settings.get") return { enterToSend: true };
      if (method === "voice.start") return { id: "v1" };
      return { models: [] };
    });
    useDrafts.getState().setText(draftKey("p1", null), "Bitte");
    setup(<Composer project={{ ...project("p1"), name: "Kundenportal", technologies: ["Next.js"] }} session={null} />);
    const box = screen.getByRole("textbox", { name: "Nachricht an Claude" });
    // The first press types its space like any key and opens the connection ahead; held on, it records.
    fireEvent.keyDown(box, { key: " " });
    fireEvent.change(box, { target: { value: "Bitte " } });
    expect(callMock).toHaveBeenCalledWith("voice.prewarm", { language: "de", keyterms: expect.arrayContaining(["FORGE", "Kundenportal", "Next.js"]) });
    expect(callMock).not.toHaveBeenCalledWith("voice.start", expect.anything());
    await act(() => wait(450));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("voice.start", { language: "de", keyterms: expect.arrayContaining(["FORGE", "Kundenportal", "Next.js"]) }));
    expect(useDrafts.getState().drafts[draftKey("p1", null)]?.text).toBe("Bitte");
  });

  it("starts at once on the key repeat, before the hold time", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "settings.get") return { enterToSend: true };
      if (method === "voice.start") return { id: "v1" };
      return { models: [] };
    });
    setup(<Composer project={project("p1")} session={null} />);
    const box = screen.getByRole("textbox", { name: "Nachricht an Claude" });
    fireEvent.keyDown(box, { key: " " });
    fireEvent.keyDown(box, { key: " ", repeat: true });
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("voice.start", expect.anything()));
  });

  describe("live text", () => {
    const key = draftKey("p1", null);
    const draft = () => useDrafts.getState().drafts[key]?.text;
    const heard = (text: string) => act(() => listeners.forEach((l) => l({ event: "voice.transcript", payload: { id: "v1", text } })));

    beforeEach(() => {
      callMock.mockImplementation(async (method: string) => {
        if (method === "settings.get") return { enterToSend: true };
        if (method === "voice.start") return { id: "v1" };
        if (method === "voice.stop") return { text: "die Tests ausführen." };
        return { models: [] };
      });
      stubMicrophone();
    });
    afterEach(() => vi.unstubAllGlobals());

    async function record(start: string, caret = start.length) {
      useDrafts.getState().setText(key, start);
      setup(<Composer project={project("p1")} session={null} />);
      const box = screen.getByRole("textbox", { name: "Nachricht an Claude" }) as HTMLTextAreaElement;
      box.setSelectionRange(caret, caret);
      fireEvent.click(screen.getByRole("button", { name: "Diktieren" }));
      await screen.findByRole("button", { name: "Aufnahme beenden" });
      // The connection id arrives after the microphone runs.
      await act(async () => {});
      return box;
    }

    it("writes the words into the field while speaking and lets the service correct them", async () => {
      await record("Bitte Danke", 5);
      heard("die");
      expect(draft()).toBe("Bitte die Danke");
      heard("die Test");
      expect(draft()).toBe("Bitte die Test Danke");
      heard("die Tests aus");
      expect(draft()).toBe("Bitte die Tests aus Danke");
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Aufnahme beenden" })));
      await waitFor(() => expect(draft()).toBe("Bitte die Tests ausführen. Danke"));
    });

    it("takes the live words back when the recording is discarded", async () => {
      const box = await record("Bitte");
      heard("die Tests");
      expect(draft()).toBe("Bitte die Tests");
      fireEvent.keyDown(box, { key: "Escape" });
      expect(draft()).toBe("Bitte");
    });

    it("stops writing once the user types and puts the result in place of its live words", async () => {
      const box = await record("");
      heard("die");
      fireEvent.change(box, { target: { value: "Hallo die" } });
      heard("die Tests");
      expect(draft()).toBe("Hallo die");
      // The cursor elsewhere does not matter: the words were spoken where they stand.
      box.setSelectionRange(0, 0);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Aufnahme beenden" })));
      await waitFor(() => expect(draft()).toBe("Hallo die Tests ausführen."));
    });

    it("leaves the cursor alone and stops writing once the user moves it", async () => {
      const box = await record("Bitte");
      box.focus();
      heard("die");
      await act(() => wait(40));
      expect(box.selectionStart).toBe(9);
      box.setSelectionRange(0, 0);
      heard("die Tests");
      expect(draft()).toBe("Bitte die");
      expect(box.selectionStart).toBe(0);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Aufnahme beenden" })));
      await waitFor(() => expect(draft()).toBe("Bitte die Tests ausführen."));
    });

    it("sends nothing while the dictation runs", async () => {
      const box = await record("Bitte");
      heard("die");
      fireEvent.keyDown(box, { key: "Enter" });
      expect((screen.getByRole("button", { name: "Senden" }) as HTMLButtonElement).disabled).toBe(true);
      expect(callMock.mock.calls.some(([m]) => String(m).startsWith("sessions."))).toBe(false);
      expect(draft()).toBe("Bitte die");
    });
  });

  describe("hold", () => {
    const key = draftKey("p1", null);
    const draft = () => useDrafts.getState().drafts[key]?.text;

    function answers(text: string) {
      callMock.mockImplementation(async (method: string) => {
        if (method === "settings.get") return { enterToSend: true };
        if (method === "voice.start") return { id: "v1" };
        if (method === "voice.stop") return { text };
        return { models: [] };
      });
    }
    beforeEach(() => stubMicrophone());
    afterEach(() => vi.unstubAllGlobals());

    async function hold(start: string) {
      useDrafts.getState().setText(key, start);
      setup(<Composer project={project("p1")} session={null} />);
      const box = screen.getByRole("textbox", { name: "Nachricht an Claude" }) as HTMLTextAreaElement;
      box.focus();
      box.setSelectionRange(start.length, start.length);
      fireEvent.keyDown(box, { key: " " });
      fireEvent.change(box, { target: { value: start + " " } });
      fireEvent.keyDown(box, { key: " ", repeat: true });
      await screen.findByRole("button", { name: "Aufnahme beenden" });
      expect(draft()).toBe(start);
      return box;
    }

    it("gives the space back when nothing was recognized", async () => {
      answers("");
      const box = await hold("Bitte");
      await act(async () => fireEvent.keyUp(box, { key: " " }));
      await waitFor(() => expect(draft()).toBe("Bitte "));
    });

    it("gives the space back when the hold is discarded", async () => {
      answers("egal");
      const box = await hold("Bitte");
      fireEvent.keyDown(box, { key: " ", repeat: true });
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(draft()).toBe("Bitte "));
      expect(callMock).not.toHaveBeenCalledWith("voice.stop", expect.anything());
    });

    it("puts the text in without the space when something was said", async () => {
      answers("die Tests.");
      const box = await hold("Bitte");
      await act(async () => fireEvent.keyUp(box, { key: " " }));
      await waitFor(() => expect(draft()).toBe("Bitte die Tests."));
    });
  });

  it("types a plain space on a short press", async () => {
    setup(<Composer project={project("p1")} session={null} />);
    const box = screen.getByRole("textbox", { name: "Nachricht an Claude" });
    fireEvent.keyDown(box, { key: " " });
    fireEvent.keyUp(box, { key: " " });
    await act(() => wait(450));
    expect(callMock).not.toHaveBeenCalledWith("voice.start", expect.anything());
  });

  it("takes a slow typed space for a space, not for a hold", async () => {
    setup(<Composer project={project("p1")} session={null} />);
    const box = screen.getByRole("textbox", { name: "Nachricht an Claude" });
    fireEvent.keyDown(box, { key: " " });
    await act(() => wait(250));
    fireEvent.keyUp(box, { key: " " });
    await act(() => wait(250));
    expect(callMock).not.toHaveBeenCalledWith("voice.start", expect.anything());
  });

  it("does not record when another key follows while space is still down (fast typing)", async () => {
    setup(<Composer project={project("p1")} session={null} />);
    const box = screen.getByRole("textbox", { name: "Nachricht an Claude" });
    fireEvent.keyDown(box, { key: " " });
    fireEvent.keyDown(box, { key: "d" });
    await act(() => wait(450));
    expect(callMock).not.toHaveBeenCalledWith("voice.start", expect.anything());
  });
});

function stubMicrophone() {
  const proc = { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
  vi.stubGlobal(
    "AudioContext",
    class {
      destination = {};
      createMediaStreamSource = () => ({ connect: vi.fn() });
      createScriptProcessor = () => proc;
      close = async () => {};
    },
  );
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("info commands", () => {
  it("opens /usage as a dialog over the chat instead of sending it", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "settings.get") return { enterToSend: true };
      if (method === "system.diagnostics") return { claude: { found: true, version: "2.1.300" }, auth: { loggedIn: true, subscriptionType: "max", rateLimitTier: "default_claude_max_20x", authMethod: null } };
      if (method === "system.usage") return { available: true, subscriptionType: "max", windows: [{ key: "five_hour", label: "Aktuelle Session", utilization: 12, resetsAt: null }], fetchedAt: new Date().toISOString(), error: null };
      return { models: [] };
    });
    useDrafts.getState().setText("s1", "/usage");
    setup(<Composer project={project("p1")} session={session} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Senden" })));
    expect(callMock).not.toHaveBeenCalledWith("sessions.send", expect.anything());
    expect(await screen.findByRole("dialog", { name: "Nutzung" })).toBeTruthy();
    expect(await screen.findByText("12 % genutzt")).toBeTruthy();
    expect(useDrafts.getState().drafts.s1?.text).toBe("");
  });

  it("knows its commands only as the whole input", async () => {
    const { infoCommand } = await import("./InfoCommandDialog");
    expect(["/usage", " /CONTEXT ", "/status", "/mcp"].map((t) => infoCommand(t)?.name)).toEqual(["usage", "context", "status", "mcp"]);
    expect(["/usage bitte", "usage", "/usages"].map((t) => infoCommand(t))).toEqual([null, null, null]);
    // A user's own /status picked from the menu goes to Claude.
    expect(infoCommand("/status", "status")).toBeNull();
    expect(infoCommand("/usage", "status")?.name).toBe("usage");
  });

  it("replaces only Claude Code's own commands, a user's command of the same name stays", async () => {
    const { cliCommands } = await import("./SlashCommandMenu");
    const cmd = (name: string, builtin?: boolean) => ({ name, description: name, argumentHint: "", ...(builtin ? { builtin } : {}) });
    expect(cliCommands([cmd("status", true), cmd("context", true), cmd("compact", true), cmd("mcp"), cmd("clear"), cmd("review")])).toEqual([
      cmd("compact", true),
      { ...cmd("mcp"), custom: true },
      cmd("review"),
    ]);
    // A list without the mark cannot tell them apart: FORGE's dialogs win as before.
    expect(cliCommands([cmd("status"), cmd("review")]).map((c) => c.name)).toEqual(["review"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { Project, Session } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { draftKey, useDrafts } from "@/stores/drafts";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
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

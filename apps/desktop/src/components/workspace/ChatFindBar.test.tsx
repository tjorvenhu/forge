import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SearchHit } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { useUi } from "@/stores/ui";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { ChatFindBar } = await import("./ChatFindBar");

const hit = (sessionId: string, seq: number, extra: Partial<SearchHit> = {}): SearchHit => ({
  sessionId,
  projectId: "p1",
  projectName: "shop",
  sessionTitle: sessionId === "s1" ? "Warenkorb" : "Bezahlung",
  seq,
  ts: "2026-10-18T10:00:00.000Z",
  role: "assistant",
  snippet: `Der \u0001Stripe\u0002-Webhook in ${sessionId}`,
  ...extra,
});

function renderBar(props: { sessionId?: string | null; onClose?: () => void } = {}) {
  const onClose = props.onClose ?? vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatFindBar request={{ seed: "", n: 1 }} projectId="p1" sessionId={props.sessionId === undefined ? "s1" : props.sessionId} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, input: screen.getByLabelText("Suchbegriff") };
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
  useUi.setState({ focusEvent: null });
});

describe("ChatFindBar", () => {
  it("searches the whole stored session and steps from the newest hit to older ones", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "search.sessions") return [hit("s1", 30), hit("s1", 12), hit("s1", 3)];
      throw new Error(method);
    });
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "webhook stripe" } });

    await screen.findByText("1 von 3");
    expect(callMock).toHaveBeenCalledWith("search.sessions", { query: "webhook stripe", limit: 1000, sessionId: "s1", order: "time", phrase: false });
    expect(useUi.getState().focusEvent).toEqual({ sessionId: "s1", seq: 30 });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 von 3")).toBeTruthy();
    expect(useUi.getState().focusEvent).toEqual({ sessionId: "s1", seq: 12 });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    // Wraps around to the oldest.
    expect(screen.getByText("3 von 3")).toBeTruthy();
    expect(useUi.getState().focusEvent).toEqual({ sessionId: "s1", seq: 3 });
    fireEvent.click(screen.getByRole("button", { name: "Neuerer Treffer" }));
    expect(useUi.getState().focusEvent).toEqual({ sessionId: "s1", seq: 12 });
  });

  it("shows a skeleton while searching and says when nothing matches", async () => {
    let resolve: (v: SearchHit[]) => void = () => {};
    callMock.mockImplementation(() => new Promise<SearchHit[]>((r) => (resolve = r)));
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "zitronenfalter" } });
    await screen.findByRole("status", { name: "Lädt Treffer" });
    await act(async () => resolve([]));
    await screen.findByText("Keine Treffer");
    expect(useUi.getState().focusEvent).toBeNull();
  });

  it("lists the hits of the project and opens a hit in its session", async () => {
    callMock.mockImplementation(async (method: string, p: { sessionId?: string; projectId?: string; phrase?: boolean }) => {
      if (method !== "search.sessions") throw new Error(method);
      return p.sessionId ? [hit("s1", 4)] : [hit("s1", 4), hit("s2", 9, { role: "user" })];
    });
    const setActiveSession = vi.spyOn(useUi.getState(), "setActiveSession");
    const { input } = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Projekt" }));
    fireEvent.change(input, { target: { value: "stripe" } });

    await screen.findByText("2 Treffer");
    expect(callMock).toHaveBeenLastCalledWith("search.sessions", { query: "stripe", limit: 50, projectId: "p1", phrase: false });
    expect(screen.getByText("Bezahlung · shop", { exact: false })).toBeTruthy();

    // Arrow keys pick the hit, Enter opens it in this chat.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useUi.getState().focusEvent).toEqual({ sessionId: "s2", seq: 9 });
    expect(setActiveSession).toHaveBeenCalledWith("p1", "s2");
    setActiveSession.mockRestore();
  });

  it("searches the exact phrase on request, falls back to the project without a session and closes with Esc", async () => {
    callMock.mockResolvedValue([]);
    const { input, onClose } = renderBar({ sessionId: null });
    expect((screen.getByRole("button", { name: "Session" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Projekt" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Exakte Wortfolge/ }));
    fireEvent.change(input, { target: { value: "stripe webhook" } });
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("search.sessions", { query: "stripe webhook", limit: 50, projectId: "p1", phrase: true }));
    await screen.findByText("In keiner Session dieses Projekts steht das.");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

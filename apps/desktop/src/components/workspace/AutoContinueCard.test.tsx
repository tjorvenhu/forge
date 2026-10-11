import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { Session, SessionEventBody } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { keys } from "@/lib/queries";
import { limitTime } from "@/lib/rate-limit";
import type { AutoContinueItem } from "./chat-items";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { AutoContinueCard } = await import("./AutoContinueCard");

const DUE = "2026-10-11T12:05:00.000Z";

const session = (autoContinueAt: string | null): Session => ({
  id: "s1",
  projectId: "p1",
  claudeSessionId: "c1",
  cwd: "C:\\p1",
  title: "Test",
  model: null,
  effort: null,
  profile: "balanced",
  permissionMode: "acceptEdits",
  status: "idle",
  apiKeySource: null,
  createdAt: "2026-10-11T10:00:00Z",
  updatedAt: "2026-10-11T10:00:00Z",
  lastError: null,
  live: true,
  background: [],
  context: null,
  autoContinueAt,
});

const item = (body: Extract<SessionEventBody, { type: "auto_continue" }>, open = body.state === "scheduled"): AutoContinueItem => ({ kind: "autoContinue", key: "l1", ts: "2026-10-11T11:00:00.000Z", body, open });

function setup(node: React.ReactNode, s: Session) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(keys.session(s.id), s);
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
  return qc;
}

beforeEach(() => {
  callMock.mockReset();
});
afterEach(cleanup);

describe("AutoContinueCard", () => {
  it("announces the planned time and cancels it on request", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "sessions.cancelAutoContinue") return session(null);
      throw new Error("unexpected " + method);
    });
    const qc = setup(<AutoContinueCard item={item({ type: "auto_continue", state: "scheduled", scheduledFor: DUE, resetKnown: true, attempt: 1, message: null })} sessionId="s1" />, session(DUE));
    expect(screen.getByText("Nutzungslimit erreicht")).toBeTruthy();
    expect(screen.getByText(`FORGE macht um ${limitTime(DUE)} automatisch weiter.`)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Nicht automatisch weitermachen/ })));
    expect(callMock).toHaveBeenCalledWith("sessions.cancelAutoContinue", { sessionId: "s1" });
    expect(qc.getQueryData<Session>(keys.session("s1"))?.autoContinueAt).toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Nicht automatisch weitermachen/ })).toBeNull());
    expect(screen.getByText(`Automatisches Weitermachen war für ${limitTime(DUE)} geplant.`)).toBeTruthy();
  });

  it("offers no cancel button on a plan that was replaced", () => {
    setup(<AutoContinueCard item={item({ type: "auto_continue", state: "scheduled", scheduledFor: DUE, resetKnown: true, attempt: 1, message: null }, false)} sessionId="s1" />, session(DUE));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains a plan without a known reset time", () => {
    setup(<AutoContinueCard item={item({ type: "auto_continue", state: "scheduled", scheduledFor: DUE, resetKnown: false, attempt: 1, message: null })} sessionId="s1" />, session(DUE));
    expect(screen.getByText(/prüft alle 15 Minuten/)).toBeTruthy();
  });

  it("shows when FORGE continued and when it gave up", () => {
    setup(
      <>
        <AutoContinueCard item={item({ type: "auto_continue", state: "resumed", scheduledFor: DUE, attempt: 2, message: null })} sessionId="s1" />
        <AutoContinueCard item={item({ type: "auto_continue", state: "exhausted", scheduledFor: null, attempt: 3, message: "Das Limit war auch nach 3 automatischen Fortsetzungen erreicht." })} sessionId="s1" />
      </>,
      session(null),
    );
    expect(screen.getByText(`Automatisch fortgesetzt um ${limitTime("2026-10-11T11:00:00.000Z")}`)).toBeTruthy();
    expect(screen.getByText(/2\. automatischer Versuch/)).toBeTruthy();
    expect(screen.getByText("Automatisches Weitermachen beendet")).toBeTruthy();
  });
});

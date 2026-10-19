import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { Session } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { LongSessionHint, longSessionLabel, longSessionOptions, longSessionTokens } = await import("./handoff");
const { keys, queryClient } = await import("@/lib/queries");
const { draftKey, useDrafts } = await import("@/stores/drafts");
const { useUi } = await import("@/stores/ui");
const { useCardStore } = await import("@/stores/card-state");

function session(tokens: number | null, extra: Partial<Session> = {}): Session {
  return {
    id: "s1",
    projectId: "p1",
    claudeSessionId: "c1",
    cwd: "C:/p1",
    title: "Warenkorb",
    model: null,
    effort: null,
    profile: "autonomous",
    permissionMode: "bypassPermissions",
    status: "idle",
    apiKeySource: null,
    createdAt: "2026-10-18T10:00:00Z",
    updatedAt: "2026-10-18T10:00:00Z",
    lastError: null,
    live: true,
    background: [],
    subagents: [],
    context: tokens === null ? null : { totalTokens: tokens, maxTokens: 1_000_000, percentage: tokens / 10_000, categories: [], updatedAt: "2026-10-18T10:00:00Z" },
    autoContinueAt: null,
    ...extra,
  } as Session;
}

function show(s: Session) {
  return render(
    <QueryClientProvider client={queryClient}>
      <LongSessionHint session={s} draftKey={draftKey("p1", s.id)} disabled={false} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  queryClient.setQueryData(keys.settings, { longSessionTokens: 200_000 });
});
afterEach(cleanup);

describe("long sessions", () => {
  it("counts a session as long from the threshold on, never when the hint is off", () => {
    expect(longSessionTokens(session(199_999), 200_000)).toBeNull();
    expect(longSessionTokens(session(250_000), 200_000)).toBe(250_000);
    expect(longSessionTokens(session(900_000), 0)).toBeNull();
    expect(longSessionTokens(session(null), 200_000)).toBeNull();
    expect(longSessionLabel(0)).toBe("Aus");
    expect(longSessionLabel(200_000)).toBe("ab 200 Tsd. Tokens");
    expect(longSessionOptions(150_000).map((o) => o.value)).toEqual(["0", "100000", "150000", "200000", "400000", "600000", "800000"]);
  });

  it("shows no hint below the threshold", () => {
    show(session(120_000));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("hides on request, also after a restart, and comes back once the context grew by the threshold", () => {
    const { rerender } = show(session(250_000, { id: "s-hide" }));
    expect(screen.getByRole("status").textContent).toContain("Lange Session");
    fireEvent.click(screen.getByRole("button", { name: "Hinweis ausblenden" }));
    expect(screen.queryByRole("status")).toBeNull();
    const again = (tokens: number) => (
      <QueryClientProvider client={queryClient}>
        <LongSessionHint session={session(tokens, { id: "s-hide" })} draftKey={draftKey("p1", "s-hide")} disabled={false} />
      </QueryClientProvider>
    );
    rerender(again(420_000));
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    useCardStore.setState({ values: new Map() });
    const restarted = render(again(440_000));
    expect(screen.queryByRole("status")).toBeNull();
    restarted.rerender(again(450_000));
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("goes on in a new session, takes the draft along and opens it", async () => {
    const next = session(null, { id: "s2", title: "Warenkorb (Fortsetzung)", status: "running" });
    callMock.mockImplementation((method: string) => Promise.resolve(method === "sessions.handoff" ? next : null));
    useDrafts.getState().setText(draftKey("p1", "s1"), "Jetzt die Tests");
    show(session(300_000));
    fireEvent.click(screen.getByRole("button", { name: "In neuer Session weiter" }));
    await waitFor(() => expect(useUi.getState().activeSession.p1).toBe("s2"));
    expect(callMock).toHaveBeenCalledWith("sessions.handoff", { sessionId: "s1" });
    expect(useDrafts.getState().drafts[draftKey("p1", "s2")]?.text).toBe("Jetzt die Tests");
    expect(useDrafts.getState().drafts[draftKey("p1", "s1")]?.text ?? "").toBe("");
  });
});

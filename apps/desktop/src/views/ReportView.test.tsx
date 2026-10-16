import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type * as RpcModuleNs from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { useAgentReview } from "@/stores/agent-review";
import { localDay, shiftDay } from "@/components/report/report-days";

type RpcModule = typeof RpcModuleNs;

const at = new Date().toISOString();
const today = localDay(new Date());
const report = (date: string) => ({
  date,
  from: at,
  to: at,
  projectId: null,
  projectName: null,
  sessions:
    date === today
      ? [{ id: "s1", projectId: "app", projectName: "App", rootId: "app", title: "Login bauen", status: "idle", turns: 3, errors: 1, firstAt: at, lastAt: at, agent: false, lastError: null }]
      : [],
  agents:
    date === today
      ? [
          { worktreeId: "wt1", rootId: "app", rootName: "App", branch: "agent/csv", title: "CSV-Export", sessionId: "s9", parentSessionId: "s1", startedAt: at, at, state: "waiting", message: "Wartet aufs Zusammenführen", exists: true },
          { worktreeId: "wt2", rootId: "app", rootName: "App", branch: "agent/alt", title: null, sessionId: null, parentSessionId: null, startedAt: at, at, state: "merged", message: "1 Commit übernommen", exists: false },
        ]
      : [],
  commits: date === today ? [{ projectId: "app", projectName: "App", hash: "abc1234def", shortHash: "abc1234", subject: "Login-Formular", author: "T", date: at, auto: true, agentBranch: null, sessionId: "s1" }] : [],
  open: date === today ? [{ kind: "question", sessionId: "s1", projectId: "app", projectName: "App", sessionTitle: "Login bauen", text: "Welches Format?", at, requestId: "r1" }] : [],
  calls: [],
  usage: {
    turns: date === today ? 3 : 0,
    workMs: date === today ? 320 * 60_000 : 0,
    agentWorkMs: date === today ? 60 * 60_000 : 0,
    activeMs: date === today ? 200 * 60_000 : 0,
    peakParallel: 3,
    inputTokens: 1000,
    outputTokens: 245_000,
    cacheReadTokens: 3_000_000,
    cacheWriteTokens: 0,
    other: null,
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, workMs: hour === 10 ? 42 * 60_000 : 0, tokens: 0, turns: hour === 10 ? 2 : 0 })),
    projects: [],
    days: [shiftDay(today, -1), today].map((d) => ({ date: d, workMs: 60 * 60_000, tokens: 1000 })),
  },
  gitErrors: [],
  truncated: false,
});

const callMock = vi.fn(async (method: string, params: { date?: string }) => {
  switch (method) {
    case "projects.list":
      return [{ id: "app", name: "App", parentId: null }];
    case "reports.daily":
      return report(params.date!);
    case "reports.dailySummary":
      return { summary: "- Login fertig", model: "haiku" };
    default:
      return null;
  }
});
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: [string, { date?: string }]) => callMock(...a), subscribe: () => () => {} } }));

const { ReportView } = await import("./ReportView");
const { ContextMenuHost } = await import("@/components/layout/ContextMenuHost");

function show() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <ReportView />
        <ContextMenuHost search={false} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockClear();
  useUi.setState({ view: "report", reportProjectId: null, activeProjectId: null, commitRequest: null });
});
afterEach(cleanup);

describe("daily report", () => {
  it("shows a skeleton first, then sessions, agents, commits and what is open", async () => {
    show();
    expect(screen.getByRole("status", { name: "Lädt Tagesbericht" })).toBeTruthy();
    expect(await screen.findByText("Login-Formular")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Lädt Tagesbericht" })).toBeNull();
    expect(screen.getByText("Welches Format?")).toBeTruthy();
    expect(screen.getByText("Wartet aufs Zusammenführen", { selector: "span.inline-flex" })).toBeTruthy();
    expect(screen.getByText("Zusammengeführt")).toBeTruthy();
    expect(screen.getByText("Auto-Commit")).toBeTruthy();
    expect(screen.getByText("App · 3 Durchläufe · 1 mit Fehler")).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith("reports.daily", { date: today, projectId: undefined });
  });

  it("opens a commit in the Git tab and a session in its chat", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Commit Login-Formular im Git-Reiter öffnen" }));
    expect(useUi.getState()).toMatchObject({ view: "workspace", activeProjectId: "app", workspaceTab: "git", commitRequest: { projectId: "app", hash: "abc1234def" } });
    fireEvent.click(screen.getByRole("button", { name: "Session Login bauen öffnen" }));
    expect(useUi.getState()).toMatchObject({ activeProjectId: "app", activeSession: { app: "s1" }, workspaceTab: "chat" });
  });

  it("offers the agent's actions on a right click", async () => {
    show();
    fireEvent.contextMenu(await screen.findByRole("button", { name: "Agent agent/csv ansehen" }));
    const labels = (await screen.findAllByRole("menuitem")).map((i) => i.textContent);
    expect(labels).toEqual(["Session des Agenten öffnen", "Im Agenten-Reiter ansehen", "Zusammenführen oder verwerfen", "Startende Session öffnen", "Branch kopieren"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Zusammenführen oder verwerfen" }));
    expect(useAgentReview.getState().queue).toContain("wt1");
  });

  it("goes back a day and says when nothing happened", async () => {
    show();
    await screen.findByText("Login-Formular");
    fireEvent.click(screen.getByRole("button", { name: "Vorheriger Tag" }));
    expect(await screen.findByText("Gestern ist nichts passiert")).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith("reports.daily", { date: shiftDay(today, -1), projectId: undefined });
    expect(screen.getByRole("button", { name: "Zusammenfassen" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows working time and tokens, and opens a day from the trend", async () => {
    show();
    expect(await screen.findByText("5 h 20 min")).toBeTruthy();
    expect(screen.getByText("3 Mio.")).toBeTruthy();
    expect(screen.getByText("92 % davon liest Claude bei jedem Schritt erneut aus dem Cache.")).toBeTruthy();
    // The hour column carries its value for keyboard and screen readers, the tooltip follows focus.
    fireEvent.focus(screen.getByLabelText(/^10:00 bis 11:00 · 2 Durchläufe/));
    expect(screen.getByRole("tooltip").textContent).toContain("42 min");
    fireEvent.click(screen.getByRole("button", { name: "Gestern: 1 h" }));
    expect(await screen.findByText("Gestern ist nichts passiert")).toBeTruthy();
    // Every chart has its table twin.
    fireEvent.click(screen.getByRole("button", { name: "Über den Tag als Tabelle" }));
    expect(screen.getByText("10:00 bis 11:00")).toBeTruthy();
  });

  it("writes a summary with Claude on request", async () => {
    show();
    await screen.findByText("Login-Formular");
    fireEvent.click(screen.getByRole("button", { name: "Zusammenfassen" }));
    expect(await screen.findByText("Login fertig")).toBeTruthy();
    expect(screen.getByText(/aus den Fakten dieses Berichts erstellt/)).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith("reports.dailySummary", { date: today, projectId: undefined });
  });
});

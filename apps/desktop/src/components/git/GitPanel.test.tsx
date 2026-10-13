import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { GitStatus, Project } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const status: GitStatus = {
  summary: { isRepo: true, branch: "feature/x", detached: false, ahead: 0, behind: 0, upstream: null, changedCount: 2, conflicted: false, remoteUrl: null },
  files: [
    { path: "src/a.ts", origPath: null, index: "?", worktree: "?", kind: "untracked", staged: false, unstaged: true },
    { path: "src/b.ts", origPath: null, index: ".", worktree: "M", kind: "modified", staged: false, unstaged: true },
  ],
};

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { GitPanel } = await import("./GitPanel");

const project: Project = {
  id: "p1",
  name: "Demo",
  path: "C:\\demo",
  favorite: false,
  tags: [],
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
};

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <GitPanel project={project} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  callMock.mockReset();
  callMock.mockImplementation(async (method: string) => {
    if (method === "git.status") return status;
    if (method === "git.diff") return { path: "src/a.ts", binary: false, additions: 1, deletions: 0, lines: [], truncated: false };
    if (method === "git.commit") return { hash: "a".repeat(40), summary: "feat: test" };
    throw new Error("unexpected " + method);
  });
});

describe("GitPanel commit flow", () => {
  it("fills the message from the AI suggestion for the selected files", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "git.status") return status;
      if (method === "git.suggestCommitMessage") return { message: "feat: neue Datei a", model: "haiku", skipped: [] };
      throw new Error("unexpected " + method);
    });
    setup();
    await screen.findByRole("checkbox", { name: "src/a.ts auswählen" });
    fireEvent.click(screen.getByRole("checkbox", { name: "src/a.ts auswählen" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Commit-Nachricht mit Claude erzeugen" })));
    expect(callMock).toHaveBeenCalledWith("git.suggestCommitMessage", { projectId: "p1", paths: ["src/a.ts"] });
    expect((screen.getByLabelText("Commit-Nachricht") as HTMLTextAreaElement).value).toBe("feat: neue Datei a");
  });

  it("commits exactly the selected files after the review dialog", async () => {
    setup();
    await screen.findByRole("checkbox", { name: "src/a.ts auswählen" });
    fireEvent.click(screen.getByRole("checkbox", { name: "src/a.ts auswählen" }));
    fireEvent.change(screen.getByLabelText("Commit-Nachricht"), { target: { value: "feat: test" } });
    const commitBtn = screen.getByRole("button", { name: /Commit erstellen \(1\)/ });
    expect((commitBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(commitBtn);
    const confirm = await screen.findByRole("button", { name: "Committen" });
    await act(async () => fireEvent.click(confirm));
    expect(callMock).toHaveBeenCalledWith("git.commit", { projectId: "p1", message: "feat: test", paths: ["src/a.ts"], allowSensitive: false });
  });

  async function openReview() {
    setup();
    await screen.findByRole("checkbox", { name: "src/a.ts auswählen" });
    fireEvent.click(screen.getByRole("checkbox", { name: "src/a.ts auswählen" }));
    fireEvent.change(screen.getByLabelText("Commit-Nachricht"), { target: { value: "feat: test" } });
    fireEvent.click(screen.getByRole("button", { name: /Commit erstellen \(1\)/ }));
    return screen.findByRole("button", { name: "Committen" });
  }

  it("keeps the review dialog open when the commit fails", async () => {
    const { RpcCallError } = await import("@/lib/rpc");
    callMock.mockImplementation(async (method: string) => {
      if (method === "git.status") return status;
      if (method === "git.commit") throw new RpcCallError("GIT_FAILED", "kaputt");
      throw new Error("unexpected " + method);
    });
    const confirm = await openReview();
    await act(async () => fireEvent.click(confirm));
    expect(screen.getByRole("button", { name: "Committen" })).toBeTruthy();
  });

  it("replaces the review dialog with the flagged-files dialog on a policy stop", async () => {
    const { RpcCallError } = await import("@/lib/rpc");
    callMock.mockImplementation(async (method: string) => {
      if (method === "git.status") return status;
      if (method === "git.commit") throw new RpcCallError("POLICY_DENIED", "gestoppt", { flagged: [{ path: "src/a.ts", reason: "Secret" }] });
      throw new Error("unexpected " + method);
    });
    const confirm = await openReview();
    await act(async () => fireEvent.click(confirm));
    expect(screen.queryByRole("button", { name: "Committen" })).toBeNull();
    expect(await screen.findByRole("button", { name: "Trotzdem committen" })).toBeTruthy();
  });

  it("keeps the commit button disabled without selection or message", async () => {
    setup();
    await screen.findByRole("checkbox", { name: "src/a.ts auswählen" });
    expect((screen.getByRole("button", { name: /Commit erstellen \(0\)/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

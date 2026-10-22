import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { CommitInfo, GitStatus, Project } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { GitCenter } = await import("./GitCenter");
const { useUi } = await import("@/stores/ui");

const status: GitStatus = {
  summary: { isRepo: true, branch: "main", detached: false, ahead: 0, behind: 0, upstream: null, changedCount: 0, conflicted: false, remoteUrl: null },
  files: [],
};

const commit = (hash: string, subject: string, parents: string[], refs: string[] = []): CommitInfo => ({
  hash: hash.padEnd(40, "0"),
  shortHash: hash.slice(0, 7),
  author: "Tjorven",
  authorEmail: "t@example.org",
  avatarUrl: null,
  date: new Date().toISOString(),
  subject,
  parents: parents.map((p) => p.padEnd(40, "0")),
  refs,
});
const log = [commit("bbbbbbb", "Screenshots: Druck-Taste", ["aaaaaaa"], ["HEAD -> main", "tag: v0.1.68"]), commit("aaaaaaa", "Erster Stand", [])];

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
  agentsEnabled: true,
  teamsEnabled: true,
  group: null,
  exists: true,
};

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <GitCenter project={project} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = () => {};
  callMock.mockReset();
  callMock.mockImplementation(async (method: string, params: { commit?: string; path?: string }) => {
    if (method === "git.status") return status;
    if (method === "git.log") return log;
    if (method === "git.authorAvatars") return {};
    if (method === "git.branches") return [{ name: "main", current: true, upstream: null }];
    if (method === "git.commitFiles")
      return {
        hash: params.commit,
        body: params.commit?.startsWith("b") ? "Mit Beschreibung." : "",
        truncated: false,
        files: [{ path: params.commit?.startsWith("b") ? "src/shot.rs" : "README.md", origPath: null, kind: "modified", additions: 3, deletions: 1, binary: false }],
      };
    if (method === "git.commitDiff") return { path: params.path, binary: false, additions: 3, deletions: 1, lines: [], truncated: false };
    throw new Error("unexpected " + method);
  });
});

describe("GitCenter", () => {
  it("shows the checked-out commit with its files and diff before anything is chosen", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Screenshots: Druck-Taste" })).toBeTruthy();
    expect(await screen.findByText("Mit Beschreibung.")).toBeTruthy();
    expect(await screen.findByText("1 Datei geändert")).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith("git.commitDiff", expect.objectContaining({ commit: "b".repeat(7).padEnd(40, "0"), path: "src/shot.rs" }));
  });

  it("switches the right side to a commit clicked in the history", async () => {
    setup();
    fireEvent.click(await screen.findByText("Erster Stand"));
    expect(await screen.findByRole("heading", { name: "Erster Stand" })).toBeTruthy();
    expect((await screen.findAllByText("README.md")).length).toBeGreaterThan(0);
  });

  it("selects a commit asked for by the search", async () => {
    setup();
    await screen.findByRole("heading", { name: "Screenshots: Druck-Taste" });
    act(() => useUi.getState().openCommit("p1", "a".repeat(7).padEnd(40, "0")));
    expect(await screen.findByRole("heading", { name: "Erster Stand" })).toBeTruthy();
    expect(useUi.getState().commitRequest).toBeNull();
  });

  it("lists tags of the loaded history", async () => {
    setup();
    await screen.findByRole("heading", { name: "Screenshots: Druck-Taste" });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Tags/ }), { button: 0 });
    expect(await screen.findByText("v0.1.68", { selector: "span.font-medium" })).toBeTruthy();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type * as RpcModuleNs from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const project = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id === "app" ? "App" : "Shop",
  path: `C:\\code\\${id}`,
  favorite: false,
  tags: ["auto-commit", "auto-push"],
  technologies: ["Next.js", "React", "Drizzle"],
  profile: "autonomous",
  defaultModel: null,
  defaultEffort: null,
  createdAt: "2026-10-10T00:00:00Z",
  lastOpenedAt: null,
  testCommand: null,
  devCommand: null,
  parentId: null,
  exists: true,
  git: { isRepo: true, branch: "main", detached: false, ahead: 0, behind: 0, upstream: null, changedCount: 4, conflicted: false, remoteUrl: "https://github.com/x/app" },
  lastSession: null,
  ...over,
});

let busy = true;
const callMock = vi.fn(async (method: string, params: { projectId?: string }) => {
  switch (method) {
    case "projects.list":
      return [project("app"), project("shop")];
    case "sessions.listLive":
      return busy
        ? [
            { id: "s1", projectId: "app", projectName: "App", title: "Login bauen", status: "running", live: true, model: null, autoContinueAt: null, updatedAt: "2026-10-13T10:00:00Z" },
            { id: "s2", projectId: "shop", projectName: "Shop", title: "Warenkorb", status: "waiting_approval", live: true, model: null, autoContinueAt: null, updatedAt: "2026-10-13T10:00:00Z" },
          ]
        : [];
    case "sessions.listAll":
      return [];
    case "phone.state":
      return { enabled: true, registration: "registered", message: null, desk: null, call: busy ? { id: "c1", direction: "in", number: "017612345", state: "active", startedAt: "2026-10-13T10:00:00Z", unlocked: false, reason: null } : null };
    case "devserver.state":
      return { projectId: params.projectId, status: busy && params.projectId === "app" ? "running" : "stopped", command: "pnpm dev", url: "http://localhost:3000", startedAt: "2026-10-13T10:00:00Z", exitCode: null, error: null, effectiveCommand: "pnpm dev" };
    case "testdb.state":
      return { projectId: params.projectId, status: "stopped", progress: null, version: "17", installed: true, initialized: true, url: "", startedAt: null, error: null };
    case "app.updateState":
      return { currentVersion: "1.0.0", phase: "uptodate", latest: null };
    case "claude.setupState":
      return { task: null, phase: "idle", url: null, log: [], message: null };
    default:
      return null;
  }
});
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: [string, { projectId?: string }]) => callMock(...a), subscribe: () => () => {} } }));

const { HomeView } = await import("./HomeView");
const { ProjectCard } = await import("@/components/projects/ProjectCard");

function show(ui: React.ReactNode) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("start page", () => {
  it("lists what runs right now instead of the projects", async () => {
    busy = true;
    show(<HomeView />);
    expect(await screen.findByText("Telefonat mit 017612345")).toBeTruthy();
    expect(await screen.findByText("Login bauen")).toBeTruthy();
    expect(screen.getByText("Wartet auf dich")).toBeTruthy();
    expect(screen.getByText("Warenkorb")).toBeTruthy();
    expect(await screen.findByText("Dev-Server: App")).toBeTruthy();
    expect(screen.queryByText("Favoriten")).toBeNull();
    expect(screen.queryByRole("button", { name: "App öffnen" })).toBeNull();
  });

  it("says so when nothing runs", async () => {
    busy = false;
    show(<HomeView />);
    expect(await screen.findByText("Gerade läuft nichts")).toBeTruthy();
  });
});

describe("project card", () => {
  it("bundles technologies, tags and git details into short chips with tooltips", () => {
    show(<ProjectCard p={project("app") as never} onRemove={() => {}} />);
    expect(screen.getByText("Next.js +2").closest("[title]")!.getAttribute("title")).toBe("Technologien\n- Next.js\n- React\n- Drizzle");
    expect(screen.getByText("2 Tags").closest("[title]")!.getAttribute("title")).toContain("- Automatisch committen");
    expect(screen.getByText("main").closest("[title]")!.getAttribute("title")).toContain("- Remote: GitHub");
    expect(screen.getByText("· 4 geändert")).toBeTruthy();
    expect(screen.queryByText("React")).toBeNull();
    expect(screen.queryByText("GitHub")).toBeNull();
  });
});

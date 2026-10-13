import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { Project } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn(async (method: string) => {
  switch (method) {
    case "devtools.get":
      return { env: "API_URL=http://localhost:4000\n", useEnv: true, database: { port: 54329, name: "app_test", envVar: "DATABASE_URL", withDevServer: false } };
    case "testdb.state":
      return { projectId: "app", status: "stopped", progress: null, version: "17", installed: true, initialized: true, url: "postgres://localhost:54329/app_test", startedAt: null, error: null };
    case "devtools.envFiles":
      return [];
    case "devserver.state":
      return { effectiveCommand: "pnpm dev" };
    default:
      return null;
  }
});
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: [string]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@/components/workspace/DevServer", () => ({ DevServerPanel: () => <div>Ausgabe des Dev-Servers</div>, DevServerControls: () => null }));

const { DevToolsTab } = await import("./DevToolsTab");
const { useUi } = await import("@/stores/ui");

const project = { id: "app", name: "App", path: "C:\\code\\app", parentId: null, devCommand: null } as Project;

function show() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TooltipProvider>
        <DevToolsTab project={project} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("DevToolsTab", () => {
  it("shows one section at a time, chosen in the menu like the settings", async () => {
    act(() => useUi.getState().setDevToolsSection("server"));
    show();
    const nav = screen.getByRole("navigation", { name: "Bereiche der Dev-Tools" });
    // Dev-Server first, its .env and database as branches below it, the .env above the database.
    const labels = [...nav.querySelectorAll("button")].map((b) => b.querySelector("span span")?.textContent);
    expect(labels).toEqual(["Dev-Server", "Test-.env", "Test-Datenbank"]);
    expect(screen.getByText("Ausgabe des Dev-Servers")).toBeTruthy();
    expect(screen.queryByLabelText("Port der Test-Datenbank")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Test-Datenbank/ }));
    expect(await screen.findByLabelText("Port der Test-Datenbank")).toBeTruthy();
    expect(screen.queryByText("Ausgabe des Dev-Servers")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Test-\.env/ }));
    expect(await screen.findByText(/1 Variable: API_URL/)).toBeTruthy();
    expect(screen.queryByLabelText("Port der Test-Datenbank")).toBeNull();
  });

  it("opens at the section a chat card asks for", async () => {
    act(() => useUi.getState().openDevTools("database"));
    show();
    expect(useUi.getState().workspaceTab).toBe("devtools");
    expect(await screen.findByLabelText("Port der Test-Datenbank")).toBeTruthy();
  });
});

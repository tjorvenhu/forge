import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { NewProjectDialog } = await import("./NewProjectDialog");
const { useUi } = await import("@/stores/ui");

const calls = (method: string) => callMock.mock.calls.filter(([m]) => m === method).map(([, p]) => p as Record<string, unknown>);

/** Enabled once the GitHub account has loaded. */
async function gitHubCheckbox() {
  const box = await screen.findByRole("checkbox", { name: "Repository auf GitHub anlegen" });
  await waitFor(() => expect(box.hasAttribute("disabled")).toBe(false));
  return box;
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <NewProjectDialog />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);
beforeEach(() => {
  // The tab row measures itself.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  callMock.mockReset();
  callMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "settings.get") return { defaultProjectDir: "C:\\code" };
    if (method === "github.account") return { login: "me", id: 1, name: null, avatarUrl: null, profileUrl: "https://github.com/me" };
    if (method === "github.orgs") return [{ login: "vanturis", avatarUrl: null }];
    if (method === "projects.import") return { id: "p1", name: "landing", path: params.path, gitEnabled: true };
    if (method === "projects.create") return { project: { id: "p2", name: params.name, path: "C:\\code\\crm", gitEnabled: true }, github: { url: "https://github.com/me/crm", error: null } };
    if (method === "github.publish") return { url: "https://github.com/me/landing" };
    if (method === "projects.list") return [];
    throw new Error("unexpected " + method);
  });
});

describe("NewProjectDialog", () => {
  it("imports a folder and creates its GitHub repository right after", async () => {
    useUi.setState({ newProject: "import" });
    setup();
    fireEvent.change(screen.getByPlaceholderText("C:\\Users\\…\\Projekte"), { target: { value: "C:\\code\\Landing Page" } });
    fireEvent.click(await gitHubCheckbox());
    // The owner picker lists the personal account first; the name follows the folder.
    expect(await screen.findByRole("combobox", { name: "Konto oder Organisation" })).toBeTruthy();
    expect(screen.getByText("als me/Landing-Page")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Importieren" }));
    await waitFor(() => expect(calls("github.publish")).toEqual([{ projectId: "p1", private: true, owner: undefined }]));
    expect(calls("projects.import")).toEqual([{ path: "C:\\code\\Landing Page", gitEnabled: true }]);
  });

  it("creates a project with its repository in the personal account by default", async () => {
    useUi.setState({ newProject: "create" });
    setup();
    fireEvent.change(screen.getByPlaceholderText("mein-projekt"), { target: { value: "crm" } });
    fireEvent.click(await gitHubCheckbox());
    await screen.findByRole("combobox", { name: "Konto oder Organisation" });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(calls("projects.create")).toHaveLength(1));
    expect(calls("projects.create")[0]).toMatchObject({ name: "crm", github: { private: true, owner: null } });
  });
});

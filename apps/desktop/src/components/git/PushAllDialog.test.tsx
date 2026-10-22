import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UnpushedProject } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import type * as CloseModuleNs from "@/lib/push-on-close";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({
  ...(await orig<typeof RpcModuleNs>()),
  rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} },
}));
const closeMock = vi.fn();
vi.mock("@/lib/push-on-close", async (orig) => ({ ...(await orig<typeof CloseModuleNs>()), closeMainWindow: () => closeMock() }));

const { PushAllDialog } = await import("./PushAllDialog");
const { usePushAll, openPushAll } = await import("@/lib/push-on-close");

const shop: UnpushedProject = { projectId: "p1", name: "Shop", branch: "main", changed: 2, ahead: 1 };
const api: UnpushedProject = { projectId: "p2", name: "API", branch: "dev", changed: 0, ahead: 3 };

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PushAllDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
  closeMock.mockReset();
  usePushAll.setState({ open: false });
});
afterEach(cleanup);

describe("push everything when FORGE closes", () => {
  it("lists the projects, pushes them with main allowed and then closes", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "git.pushAll") return [shop, api].map((p) => ({ projectId: p.projectId, name: p.name, committed: null, pushed: true, error: null }));
      throw new Error("unexpected " + method);
    });
    usePushAll.setState({ open: true, mode: "close", projects: [shop, api] });
    setup();
    expect(screen.getByText("Shop")).toBeTruthy();
    expect(screen.getByText("2 geänderte Dateien · 1 Commit nicht gepusht")).toBeTruthy();
    expect(screen.getByText("3 Commits nicht gepusht")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pushen und schließen" }));
    await waitFor(() => expect(closeMock).toHaveBeenCalled());
    expect(callMock).toHaveBeenCalledWith("git.pushAll", { projectIds: ["p1", "p2"], allowProtected: true });
    expect(callMock).not.toHaveBeenCalledWith("settings.update", expect.anything());
  });

  it("keeps the dialog open with the error, then closes anyway and stops asking", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "git.pushAll") return [{ projectId: "p1", name: "Shop", committed: "Fix", pushed: false, error: "Push abgelehnt" }];
      if (method === "settings.update") return { askPushOnClose: false };
      throw new Error("unexpected " + method);
    });
    usePushAll.setState({ open: true, mode: "close", projects: [shop] });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Pushen und schließen" }));
    expect(await screen.findByText("Push abgelehnt")).toBeTruthy();
    expect(closeMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Nicht mehr fragen" }));
    fireEvent.click(screen.getByRole("button", { name: "Trotzdem schließen" }));
    await waitFor(() => expect(closeMock).toHaveBeenCalled());
    expect(callMock).toHaveBeenCalledWith("settings.update", { askPushOnClose: false });
  });

  it("from the palette: skeleton while loading, nothing to push says so", async () => {
    let release: (v: UnpushedProject[]) => void = () => {};
    callMock.mockImplementation((method: string) => (method === "git.unpushed" ? new Promise((r) => (release = r)) : Promise.reject(new Error(method))));
    setup();
    openPushAll();
    expect(await screen.findByRole("status", { name: "Lädt Projekte mit ungepushter Arbeit" })).toBeTruthy();
    release([]);
    expect(await screen.findByText("Es gibt nichts zu pushen. Alles ist schon auf GitHub.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

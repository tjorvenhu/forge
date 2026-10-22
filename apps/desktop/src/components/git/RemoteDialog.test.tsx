import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({
  ...(await orig<typeof RpcModuleNs>()),
  rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} },
}));

const { RemoteDialog } = await import("./RemoteDialog");
const { useGitRemoteDialog } = await import("@/stores/git-remote");

const status = (remoteUrl: string | null) => ({
  summary: { isRepo: true, branch: "main", detached: false, ahead: 0, behind: 0, upstream: null, changedCount: 0, conflicted: false, remoteUrl },
  files: [],
});

function setup(remoteUrl: string | null) {
  callMock.mockImplementation(async (method: string, params: { url?: string | null }) => {
    if (method === "git.status") return status(remoteUrl);
    if (method === "git.setRemote") return status(params.url ?? null);
    throw new Error("unexpected " + method);
  });
  useGitRemoteDialog.getState().open({ id: "p1", name: "Shop" });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RemoteDialog />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  callMock.mockReset();
});
afterEach(() => {
  cleanup();
  useGitRemoteDialog.getState().close();
});

describe("remote address", () => {
  it("shows origin and switches it from HTTPS to SSH", async () => {
    setup("https://github.com/vanturis/forge.git");
    const input = await screen.findByDisplayValue("https://github.com/vanturis/forge.git");
    expect(screen.getByText("HTTPS")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Auf SSH umstellen" }));
    expect((input as HTMLInputElement).value).toBe("git@github.com:vanturis/forge.git");
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("git.setRemote", { projectId: "p1", url: "git@github.com:vanturis/forge.git" }));
    await waitFor(() => expect(useGitRemoteDialog.getState().project).toBeNull());
  });

  it("adds origin where there is none and refuses an option as address", async () => {
    setup(null);
    expect(await screen.findByText("Kein Remote eingerichtet")).toBeTruthy();
    const input = screen.getByPlaceholderText("git@github.com:name/repo.git");
    fireEvent.change(input, { target: { value: "--upload-pack=x" } });
    expect(screen.getByRole("button", { name: "Speichern" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "git@gitlab.com:team/app.git" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("git.setRemote", { projectId: "p1", url: "git@gitlab.com:team/app.git" }));
  });

  it("removes origin when the field is emptied", async () => {
    setup("git@github.com:vanturis/forge.git");
    const input = await screen.findByDisplayValue("git@github.com:vanturis/forge.git");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "origin entfernen" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("git.setRemote", { projectId: "p1", url: null }));
  });
});

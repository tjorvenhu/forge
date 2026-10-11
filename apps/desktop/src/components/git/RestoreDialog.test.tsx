import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CommitInfo } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { RestoreDialog } = await import("./RestoreDialog");

const commit: CommitInfo = {
  hash: "b".repeat(40),
  shortHash: "bbbbbbb",
  subject: "feat: Login",
  author: "Tjorven",
  date: "2026-10-10T12:00:00Z",
};

function setup(props: { current?: boolean; openChanges?: number } = {}) {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <RestoreDialog projectId="p1" commit={commit} current={props.current ?? false} openChanges={props.openChanges ?? 0} onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
  callMock.mockResolvedValue({ commit: commit.hash, subject: commit.subject, stashed: false, changed: 3 });
});

describe("RestoreDialog", () => {
  it("restores the chosen commit by its full hash and closes", async () => {
    const { onOpenChange } = setup();
    expect(screen.getByText("feat: Login")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    });
    expect(callMock).toHaveBeenCalledWith("git.restoreTo", { projectId: "p1", commit: commit.hash });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("says that open changes go to the stash", () => {
    setup({ openChanges: 2 });
    expect(screen.getByText(/2 nicht committete Datei\(en\) sichert FORGE vorher im Git-Stash/)).toBeTruthy();
  });

  it("stays open when the restore fails", async () => {
    callMock.mockRejectedValue(new Error("kaputt"));
    const { onOpenChange } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Wiederherstellen" }));
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("offers to put changes aside for the current commit", () => {
    setup({ current: true, openChanges: 1 });
    expect(screen.getByRole("button", { name: "Beiseitelegen" })).toBeTruthy();
  });
});

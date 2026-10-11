import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as RpcModuleNs from "@/lib/rpc";
import { RpcCallError } from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { DeleteBranchDialog } = await import("./DeleteBranchDialog");

function setup() {
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DeleteBranchDialog projectId="p1" branch="agent/x" onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

afterEach(cleanup);
beforeEach(() => callMock.mockReset());

describe("DeleteBranchDialog", () => {
  it("deletes a merged branch in one step", async () => {
    callMock.mockResolvedValue([{ name: "main", current: true, upstream: null }]);
    const { onOpenChange } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    });
    expect(callMock).toHaveBeenCalledWith("git.deleteBranch", { projectId: "p1", branch: "agent/x", force: false });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("asks again before dropping unmerged commits, then forces", async () => {
    callMock.mockRejectedValueOnce(new RpcCallError("CONFLICT", "nicht gemergt", { unmerged: true }));
    callMock.mockResolvedValueOnce([]);
    const { onOpenChange } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Löschen" }));
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText(/Beim Löschen gehen sie verloren/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trotzdem löschen" }));
    });
    expect(callMock).toHaveBeenLastCalledWith("git.deleteBranch", { projectId: "p1", branch: "agent/x", force: true });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

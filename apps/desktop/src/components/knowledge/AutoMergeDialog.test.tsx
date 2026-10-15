import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KnowledgeSummary } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { AutoMergeDialog } = await import("./AutoMergeDialog");

const entry = (id: string, title: string): KnowledgeSummary => ({ id, title, summary: `Über ${title}`, tags: [], updatedAt: "2026-10-14T00:00:00.000Z" });
const entries = [entry("deploy", "Deploy auf Coolify"), entry("traefik", "Traefik komprimiert"), entry("sync", "Synchronisierung"), entry("backup", "Backups")];

function setup() {
  const onClose = vi.fn();
  const onManual = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AutoMergeDialog owner="p1" entries={entries} open onClose={onClose} onManual={onManual} />
    </QueryClientProvider>,
  );
  return { onClose, onManual };
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
});

describe("AutoMergeDialog", () => {
  it("lets Claude pick the groups and merges each one without asking", async () => {
    callMock.mockImplementation(async (method: string, params: { ids?: string[] }) => {
      if (method === "knowledge.mergePlan")
        return {
          groups: [
            { ids: ["deploy", "traefik"], reason: "Beide beschreiben die Auslieferung." },
            { ids: ["sync", "backup"], reason: "Beide sichern Daten." },
          ],
          model: "sonnet",
        };
      if (method === "knowledge.mergeDraft") {
        if (params.ids?.[0] === "sync") throw new Error("Claude nicht erreichbar");
        return { title: "Deploy und Proxy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy", model: "sonnet" };
      }
      if (method === "knowledge.merge") return { entry: { ...entry("deploy", "Deploy und Proxy"), content: "# Deploy" }, removed: ["traefik"] };
      throw new Error(method);
    });
    await act(async () => {
      setup();
    });

    expect(callMock).toHaveBeenCalledWith("knowledge.mergePlan", { projectId: "p1" });
    expect(callMock).toHaveBeenCalledWith("knowledge.merge", { projectId: "p1", ids: ["deploy", "traefik"], title: "Deploy und Proxy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy" });
    expect(callMock).not.toHaveBeenCalledWith("knowledge.merge", expect.objectContaining({ ids: ["sync", "backup"] }));
    expect(screen.getByText("Deploy und Proxy")).toBeTruthy();
    expect(screen.getByText("Zusammengeführt")).toBeTruthy();
    expect(screen.getByText("Claude nicht erreichbar")).toBeTruthy();
    expect(screen.getByText(/Aus: „Synchronisierung“, „Backups“/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Anhalten/ })).toBeNull();
  });

  it("says when nothing belongs together and offers to pick entries by hand", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "knowledge.mergePlan") return { groups: [], model: "sonnet" };
      throw new Error(method);
    });
    let handlers!: ReturnType<typeof setup>;
    await act(async () => {
      handlers = setup();
    });
    expect(screen.getByText(/keine Einträge gefunden, die dasselbe Thema behandeln/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Selbst auswählen/ }));
    expect(handlers.onManual).toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalled();
  });
});

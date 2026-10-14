import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KnowledgeCleanup, KnowledgeSummary } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { suggestedMerge } from "./knowledge-text";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@/components/ui/code-editor", () => ({
  CodeEditor: ({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel: string }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

const { MergeDialog } = await import("./MergeDialog");

const entry = (id: string, title: string): KnowledgeSummary => ({ id, title, summary: `Über ${title}`, tags: [], updatedAt: "2026-10-14T00:00:00.000Z" });
const entries = [entry("deploy", "Deploy auf Coolify"), entry("traefik", "Traefik komprimiert"), entry("sync", "Synchronisierung")];
const overlaps: KnowledgeCleanup = { overlaps: [{ a: "traefik", b: "deploy", score: 0.71 }], long: [] };

function setup(initial: string[]) {
  const onClose = vi.fn();
  const onMerged = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MergeDialog owner="p1" entries={entries} cleanup={overlaps} initial={initial} onClose={onClose} onMerged={onMerged} />
    </QueryClientProvider>,
  );
  return { onClose, onMerged };
}

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
});

describe("MergeDialog", () => {
  it("suggests the strongest overlap, lets Claude draft the text and merges the corrected draft", async () => {
    expect(suggestedMerge(overlaps, null)).toEqual(["deploy", "traefik"]);
    expect(suggestedMerge(overlaps, "traefik")).toEqual(["traefik", "deploy"]);
    expect(suggestedMerge(overlaps, "sync")).toEqual(["sync"]);

    callMock.mockImplementation(async (method: string) => {
      if (method === "knowledge.mergeDraft") return { title: "Deploy (Coolify, Traefik)", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy", model: "sonnet" };
      if (method === "knowledge.merge") return { entry: { ...entry("deploy", "Deploy und Proxy"), content: "# Deploy" }, removed: ["traefik"] };
      throw new Error(method);
    });
    const { onClose, onMerged } = setup(suggestedMerge(overlaps, null));
    const row = screen.getByRole("button", { name: /Traefik komprimiert/ });
    expect(row.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("überschneidet sich zu 71 %")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Entwurf erstellen" }));
    });
    expect(callMock).toHaveBeenCalledWith("knowledge.mergeDraft", { projectId: "p1", ids: ["deploy", "traefik"] });
    expect(screen.getByText(/Danach gelöscht: „Traefik komprimiert“/)).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("Deploy (Coolify, Traefik)"), { target: { value: "Deploy und Proxy" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Zusammenführen" }));
    });
    expect(callMock).toHaveBeenLastCalledWith("knowledge.merge", { projectId: "p1", ids: ["deploy", "traefik"], title: "Deploy und Proxy", summary: "Wie wir ausliefern", tags: ["deploy"], content: "# Deploy" });
    expect(onMerged).toHaveBeenCalledWith("deploy");
    expect(onClose).toHaveBeenCalled();
  });

  it("needs a second entry before Claude drafts anything and offers a retry when the draft fails", async () => {
    callMock.mockRejectedValueOnce(new Error("Claude nicht erreichbar"));
    setup(["sync"]);
    const draft = screen.getByRole("button", { name: "Entwurf erstellen" }) as HTMLButtonElement;
    expect(draft.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Deploy auf Coolify/ }));
    expect(draft.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(draft);
    });
    expect(screen.getByText(/Claude nicht erreichbar/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith("knowledge.merge", expect.anything());
  });
});

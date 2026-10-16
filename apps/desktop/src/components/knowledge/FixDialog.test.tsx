import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KnowledgeEntry, KnowledgeStaleReport, KnowledgeSummary } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { useUi } from "@/stores/ui";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
vi.mock("@/components/ui/code-editor", () => ({
  CodeEditor: ({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel: string }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

// jsdom has no ResizeObserver; the tab bar measures itself with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const { FixDialog } = await import("./FixDialog");
const { KnowledgeTab } = await import("./KnowledgeTab");

const deploy: KnowledgeEntry = {
  id: "deploy",
  title: "Deploy",
  summary: "Wie wir ausliefern",
  tags: ["deploy"],
  updatedAt: "2026-10-14T00:00:00.000Z",
  content: "# Deploy\n\nStart mit `runDeploy` in `src/deploy.ts`.",
};
const summary = ({ content: _c, ...rest }: KnowledgeEntry): KnowledgeSummary => rest;
const staleReport: KnowledgeStaleReport = {
  git: true,
  entries: [{ id: "deploy", missing: [{ ref: "runDeploy", kind: "name", hint: "zuletzt geändert in abc1234: Deploy umgebaut" }], checked: 2 }],
};

const wrap = (ui: React.ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(cleanup);
beforeEach(() => {
  callMock.mockReset();
});

describe("FixDialog", () => {
  it("shows Claude's draft as a diff and saves it into the entry", async () => {
    callMock.mockImplementation(async (method: string, params: { id?: string }) => {
      if (method === "knowledge.read") return deploy;
      if (method === "knowledge.fixDraft") return { ...summary(deploy), content: "# Deploy\n\nStart mit `deployApp` in `src/deploy.ts`.", model: "sonnet" };
      if (method === "knowledge.save") return { ...deploy, id: params.id, content: "neu" };
      throw new Error(method);
    });
    const onClose = vi.fn();
    await act(async () => {
      wrap(<FixDialog owner="p1" id="deploy" missing={staleReport.entries[0]!.missing} onClose={onClose} />);
    });
    expect(callMock).toHaveBeenCalledWith("knowledge.fixDraft", { projectId: "p1", id: "deploy" });
    expect(screen.getByText("runDeploy")).toBeTruthy();
    const diff = screen.getByLabelText("Änderungen am Eintrag");
    expect(diff.textContent).toContain("Start mit `runDeploy`");
    expect(diff.textContent).toContain("Start mit `deployApp`");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Übernehmen" }));
    });
    expect(callMock).toHaveBeenCalledWith("knowledge.save", {
      projectId: "p1",
      id: "deploy",
      title: "Deploy",
      summary: "Wie wir ausliefern",
      tags: ["deploy"],
      content: "# Deploy\n\nStart mit `deployApp` in `src/deploy.ts`.",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a skeleton while Claude writes and offers a retry after an error", async () => {
    let fail = true;
    let release: (v: unknown) => void = () => {};
    callMock.mockImplementation(async (method: string) => {
      if (method === "knowledge.read") return deploy;
      if (method === "knowledge.fixDraft") {
        if (fail) throw new Error("Claude nicht erreichbar");
        return new Promise((r) => (release = r));
      }
      throw new Error(method);
    });
    await act(async () => {
      wrap(<FixDialog owner="p1" id="deploy" missing={[]} onClose={() => {}} />);
    });
    expect(screen.getByText("Claude nicht erreichbar")).toBeTruthy();
    fail = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    });
    expect(screen.getByRole("status", { name: "Claude schreibt den Entwurf" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Übernehmen" }) as HTMLButtonElement).disabled).toBe(true);
    release({ ...summary(deploy), content: deploy.content, model: "sonnet" });
  });
});

describe("KnowledgeTab with stale entries", () => {
  it("marks the entry, lists the missing refs and marks a false alarm", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "knowledge.list") return [summary(deploy), { ...summary(deploy), id: "sync", title: "Sync" }];
      if (method === "knowledge.checkRefs") return staleReport;
      if (method === "knowledge.cleanup") return { overlaps: [], long: [] };
      if (method === "knowledge.read") return deploy;
      if (method === "knowledge.markChecked") return { verified: ["runDeploy"] };
      throw new Error(method);
    });
    await act(async () => {
      wrap(<KnowledgeTab project={{ id: "p1", parentId: null } as never} />);
    });
    expect(await screen.findAllByTitle("1 Verweis fehlt")).toHaveLength(2);
    const banner = await screen.findByRole("status", { name: "Fehlende Verweise" });
    expect(banner.textContent).toContain("runDeploy");
    expect(banner.textContent).toContain("Bezeichner, zuletzt geändert in abc1234: Deploy umgebaut");

    // Only stale entries: Sync disappears from the list.
    expect(screen.getByRole("button", { name: /^Sync/ })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Nur veraltete Einträge zeigen" }));
    });
    expect(screen.queryByRole("button", { name: /^Sync/ })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Als geprüft markieren" }));
    });
    expect(callMock).toHaveBeenCalledWith("knowledge.markChecked", { projectId: "p1", id: "deploy" });
  });

  it("opens the fix dialog for a palette request", async () => {
    callMock.mockImplementation(async (method: string) => {
      if (method === "knowledge.list") return [summary(deploy)];
      if (method === "knowledge.checkRefs") return staleReport;
      if (method === "knowledge.cleanup") return { overlaps: [], long: [] };
      if (method === "knowledge.read") return deploy;
      if (method === "knowledge.fixDraft") return new Promise(() => {});
      throw new Error(method);
    });
    useUi.setState({ knowledgeRequest: ":fix:deploy" });
    await act(async () => {
      wrap(<KnowledgeTab project={{ id: "p1", parentId: null } as never} />);
    });
    expect(callMock).toHaveBeenCalledWith("knowledge.fixDraft", { projectId: "p1", id: "deploy" });
    expect(screen.getByRole("dialog", { name: "Mit Claude prüfen" })).toBeTruthy();
  });
});

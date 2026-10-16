import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import type { PromptTemplate } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import { useTemplateDialogs } from "@/stores/templates";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({
  ...(await orig<typeof RpcModuleNs>()),
  rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} },
}));

const { TemplatesSettings } = await import("./TemplatesSettings");
const { TemplateEditorDialog, nameFromText } = await import("./TemplateEditorDialog");

const tpl = (id: string, name: string, projectId: string | null, sortOrder = 0): PromptTemplate => ({ id, projectId, name, description: null, text: `${name} für {datei}`, sortOrder, createdAt: "", updatedAt: "" });
const projects = [{ id: "p1", name: "Shop", parentId: null, exists: true }];

function setup(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

let list: PromptTemplate[];
let release: () => void;
beforeEach(() => {
  list = [tpl("a", "Review", null), tpl("b", "Changelog", null, 1), tpl("c", "Shop-Tests", "p1")];
  callMock.mockReset();
  callMock.mockImplementation(async (method: string) => {
    if (method === "templates.list") return list;
    if (method === "projects.list") return projects;
    if (method === "templates.reorder" || method === "templates.delete") return method === "templates.delete" ? { ok: true } : [];
    if (method === "templates.save") return tpl("n", "Neu", null);
    throw new Error("unexpected " + method);
  });
  useTemplateDialogs.setState({ apply: null, edit: null });
});
afterEach(cleanup);

describe("templates settings", () => {
  it("shows a skeleton while loading, then the global ones and each project's in their own card", async () => {
    const base = callMock.getMockImplementation()!;
    callMock.mockImplementation((method: string, p: unknown) => (method === "templates.list" ? new Promise((r) => (release = () => r(list))) : base(method, p)));
    setup(<TemplatesSettings />);
    expect(screen.getByRole("status", { name: "Lädt Vorlagen" })).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByText("Global")).toBeTruthy();
    expect(screen.getByText("Shop")).toBeTruthy();
    expect(screen.getByText("Shop-Tests")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Lädt Vorlagen" })).toBeNull();
  });

  it("moves a template within its list and deletes only after confirming", async () => {
    setup(<TemplatesSettings />);
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Changelog nach oben" })));
    expect(callMock).toHaveBeenCalledWith("templates.reorder", { ids: ["b", "a"] });
    expect((screen.getByRole("button", { name: "Review nach oben" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Review löschen" }));
    expect(callMock).not.toHaveBeenCalledWith("templates.delete", expect.anything());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Löschen" })));
    expect(callMock).toHaveBeenCalledWith("templates.delete", { id: "a" });
  });

  it("opens the editor for a new template of a project", async () => {
    setup(<TemplatesSettings />);
    const buttons = await screen.findAllByRole("button", { name: /Neue Vorlage/ });
    fireEvent.click(buttons[1]!);
    expect(useTemplateDialogs.getState().edit).toEqual({ id: null, projectId: "p1" });
  });
});

describe("template editor", () => {
  it("takes the first line of a message as name and saves a global template", async () => {
    expect(nameFromText("Bitte prüfe alle Änderungen vor dem Release gründlich auf Fehler und Lücken\nmehr")).toBe("Bitte prüfe alle Änderungen vor dem Release grü…");
    const saved = vi.fn();
    setup(<TemplateEditorDialog open onOpenChange={() => {}} template={null} initialText={"Tests für {datei}\nmit vitest"} onSaved={saved} />);
    expect((screen.getByLabelText("Text der Vorlage") as HTMLTextAreaElement).value).toBe("Tests für {datei}\nmit vitest");
    expect(screen.getByText("{datei}")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Anlegen" })));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("templates.save", { id: null, projectId: null, name: "Tests für {datei}", description: null, text: "Tests für {datei}\nmit vitest" }));
    expect(saved).toHaveBeenCalled();
  });
});

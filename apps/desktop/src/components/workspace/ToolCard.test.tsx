import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionEventBody } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import type { ChatItem } from "./chat-items";

type RpcModule = typeof RpcModuleNs;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { ToolCard } = await import("./ToolCard");
const { useUi } = await import("@/stores/ui");
const { ItemView } = await import("./ChatItemView");

let n = 0;
function tool(name: string, input: Record<string, unknown>, result: { text: string; isError?: boolean } | null, extra: Partial<ToolItem> = {}): ToolItem {
  const id = `t${++n}`;
  const res: Extract<SessionEventBody, { type: "tool.result" }> | null = result
    ? { type: "tool.result", toolUseId: id, isError: result.isError ?? false, content: { text: result.text, truncated: false } }
    : null;
  return { kind: "tool", key: id, ts: "2026-10-11T10:00:00.000Z", use: { type: "tool.use", toolUseId: id, name, input, parentToolUseId: null }, result: res, approval: null, blocked: null, todos: null, superseded: false, ...extra };
}

function show(item: ToolItem, live = false) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ToolCard item={item} sessionId="s1" sessionLive={live} projectDir="C:\p1" />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("ToolCard", () => {
  it("shows the call as one line with status and the first lines of the output", () => {
    show(tool("Bash", { command: "pnpm test" }, { text: "1\n2\n3\n4\n5\n6" }));
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByRole("img", { name: "erfolgreich" })).toBeTruthy();
    expect(screen.getByText("1 2 3 4", { normalizer: (s) => s.replace(/\s+/g, " ").trim() })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+2 Zeilen" }));
    expect(screen.getByText(/^1\s+2\s+3\s+4\s+5\s+6$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Weniger anzeigen" })).toBeTruthy();
  });

  it("counts the lines of a Read instead of showing the file", () => {
    show(tool("Read", { file_path: "C:\\p1\\README.md" }, { text: "     1\t# Titel\n     2\tText\n     3\tMehr" }));
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText("(3 Zeilen)")).toBeTruthy();
    expect(screen.queryByText(/Titel/)).toBeNull();
  });

  it("shows an edit as a compact diff with its counts", () => {
    show(tool("Edit", { file_path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, { text: "ok" }));
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
    expect(screen.getByText("const a = 1;")).toBeTruthy();
    expect(screen.getByText("const a = 2;")).toBeTruthy();
  });

  it("marks errors, running calls and opens the details on click", () => {
    show(tool("Bash", { command: "exit 1" }, { text: "kaputt", isError: true }));
    expect(screen.getByRole("img", { name: "Fehler" })).toBeTruthy();
    expect(screen.getByText("kaputt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: false, name: /Bash/ }));
    expect(screen.getByText("Eingabe")).toBeTruthy();
    cleanup();
    show(tool("Grep", { pattern: "foo" }, null), true);
    expect(screen.getByRole("img", { name: "läuft" })).toBeTruthy();
  });

  it("renders an active todo list as a checklist", () => {
    show(
      tool("TodoWrite", {}, null, {
        todos: [
          { content: "A", status: "completed" },
          { content: "B", status: "in_progress", activeForm: "Mache B" },
          { content: "C", status: "pending" },
        ],
      }),
    );
    expect(screen.getByText("1/3 erledigt")).toBeTruthy();
    expect(screen.getByText("Mache B")).toBeTruthy();
    expect(screen.getByRole("img", { name: "erledigt" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "offen" })).toBeTruthy();
  });
});

describe("FORGE notices in the chat", () => {
  it("highlights an auto-commit like the FORGE tool cards, other notices stay plain", () => {
    const notice = (icon: "commit" | "compact", title: string): ChatItem => ({
      kind: "notice",
      key: `n-${icon}`,
      ts: "2026-10-11T10:00:00.000Z",
      text: title,
      tone: "success",
      card: { title, ref: icon === "commit" ? "6398370" : null, detail: "2 Datei(en)", icon },
    });
    const { container } = render(<ItemView item={notice("commit", "Auto-Commit")} sessionId="s1" live={false} projectDir="C:\p1" />);
    expect(screen.getByText("FORGE")).toBeTruthy();
    expect(container.querySelector(".bg-accent-soft")).toBeTruthy();
    cleanup();
    const plain = render(<ItemView item={notice("compact", "Kontext komprimiert")} sessionId="s1" live={false} projectDir="C:\p1" />);
    expect(screen.queryByText("FORGE")).toBeNull();
    expect(plain.container.querySelector(".bg-accent-soft")).toBeNull();
  });
});

describe("FORGE tools in the chat", () => {
  it("shows a saved knowledge entry as a highlighted card that opens the entry", () => {
    show(
      tool("mcp__forge__knowledge_save", { title: "Deploy mit Coolify", summary: "s", content: "c" }, { text: "Gespeichert: deploy-mit-coolify (.forge/knowledge/deploy-mit-coolify.md)." }),
    );
    expect(screen.getByText("Im Projektwissen gespeichert")).toBeTruthy();
    expect(screen.getByText("Deploy mit Coolify")).toBeTruthy();
    expect(screen.getByText("FORGE")).toBeTruthy();
    expect(screen.queryByText(/mcp__forge|forge: knowledge_save/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Eintrag öffnen" }));
    expect(useUi.getState().workspaceTab).toBe("knowledge");
    expect(useUi.getState().knowledgeRequest).toBe("deploy-mit-coolify");
  });

  it("names refusals and failures instead of reporting success", () => {
    show(tool("mcp__forge__knowledge_save", { title: "Deploy" }, { text: "Nicht gespeichert: Es gibt schon ähnliche Einträge: deploy (Deploy)." }));
    expect(screen.getByText("Nicht gespeichert: ähnlicher Eintrag vorhanden")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Projektwissen öffnen" })).toBeTruthy();
    cleanup();
    show(tool("mcp__forge__start_agent", { task: "Baue den CSV-Export" }, { text: "Fehler: Es laufen schon 5 Agenten dieser Session (höchstens 5)." }));
    expect(screen.getByText("Agent nicht gestartet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Agenten ansehen" })).toBeNull();
  });

  it("shows running calls, leaves notifications to their own card and highlights lookups like every FORGE call", () => {
    show(tool("mcp__forge__start_agent", { task: "Baue den CSV-Export", name: "csv-export" }, null), true);
    expect(screen.getByText("Startet parallelen Agenten")).toBeTruthy();
    expect(screen.getByRole("img", { name: "läuft" })).toBeTruthy();
    cleanup();
    show(tool("mcp__forge__notify", { message: "Fertig" }, { text: "Der Nutzer wurde benachrichtigt." }));
    expect(screen.queryByText("Fertig")).toBeNull();
    cleanup();
    show(tool("mcp__forge__knowledge_search", { query: "deploy" }, { text: "Keine Treffer im Projektwissen." }));
    expect(screen.getByText("Projektwissen durchsucht, keine Treffer")).toBeTruthy();
    expect(screen.getByText("FORGE")).toBeTruthy();
    cleanup();
    show(tool("mcp__forge__usage_status", {}, { text: "Limit erreicht, wieder frei heute 19:10. Neue Durchläufe scheitern bis dahin.\n5 Stunden: 100 % genutzt, Reset heute 19:10" }));
    expect(screen.getByText("Abo-Nutzung abgefragt, Limit erreicht")).toBeTruthy();
    expect(screen.getByText("100 %")).toBeTruthy();
  });
});

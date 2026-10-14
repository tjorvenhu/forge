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

  it("warns about an overlapping entry and opens the result of a merge", () => {
    show(
      tool(
        "mcp__forge__knowledge_save",
        { title: "Deploy mit Docker" },
        { text: "Gespeichert: deploy-mit-docker (.forge/knowledge/deploy-mit-docker.md). Überschneidet sich stark mit: deploy (Deploy). Ist es dasselbe Thema, führe die Einträge mit knowledge_merge zusammen." },
      ),
    );
    expect(screen.getByText("Im Projektwissen gespeichert, überschneidet sich mit anderem Eintrag")).toBeTruthy();
    cleanup();
    show(tool("mcp__forge__knowledge_merge", { ids: ["deploy", "deploy-mit-docker"], title: "Deploy" }, { text: "Zusammengeführt: deploy (.forge/knowledge/deploy.md). Gelöscht: deploy-mit-docker." }));
    expect(screen.getByText("Einträge im Projektwissen zusammengeführt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Eintrag öffnen" }));
    expect(useUi.getState().knowledgeRequest).toBe("deploy");
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

  it("shows the screenshot of the preview from the transcript, with a placeholder of its size while it loads", async () => {
    let resolve: (v: unknown) => void = () => {};
    callMock.mockImplementation(() => new Promise((r) => (resolve = r)));
    const text = "Titel: Start\nAdresse: http://localhost:5173/\nHTTP-Status: 200\nKonsole: keine Meldungen\nScreenshot: 1280x800 JPEG\n[Bild]";
    show(tool("mcp__forge__preview_screenshot", {}, { text }, { seqs: [7, 8] }));
    expect(screen.getByText("Screenshot der Vorschau")).toBeTruthy();
    expect(screen.getByText("http://localhost:5173/")).toBeTruthy();
    expect(callMock).toHaveBeenCalledWith("sessions.images", { sessionId: "s1", seq: 8 });
    expect((screen.getByRole("status", { name: "Lädt Screenshot" }) as HTMLElement).style.aspectRatio).toBe("1280 / 800");
    resolve([{ mediaType: "image/jpeg", base64: "QUJD" }]);
    expect(((await screen.findByAltText("Screenshot der Vorschau")) as HTMLImageElement).src).toBe("data:image/jpeg;base64,QUJD");
    callMock.mockReset();
  });

  it("names console problems and a step that failed", () => {
    show(tool("mcp__forge__preview_console", {}, { text: "Titel: Start\nAdresse: http://localhost:5173/\nZusammenfassung: 2 Fehler; 1 fehlgeschlagene Anfrage" }));
    expect(screen.getByText("Konsole der Vorschau meldet Fehler")).toBeTruthy();
    expect(screen.getByText("2 Fehler; 1 fehlgeschlagene Anfrage")).toBeTruthy();
    cleanup();
    const steps = [{ action: "click", selector: "#a" }, { action: "click", selector: "#b" }];
    show(tool("mcp__forge__preview_interact", { steps }, { text: "Adresse: http://localhost:5173/\nSchritte:\n1. click #a: ok\n2. click #b: Fehler: weg\nAbgebrochen nach Schritt 2 von 2." }));
    expect(screen.getByText("Schritt 2 von 2 in der Vorschau fehlgeschlagen")).toBeTruthy();
    cleanup();
    show(tool("mcp__forge__preview_interact", { steps }, null), true);
    expect(screen.getByText("Führt 2 Schritte in der Vorschau aus")).toBeTruthy();
    cleanup();
    show(tool("mcp__forge__preview_screenshot", {}, { text: "Fehler: Für dieses Projekt läuft kein Dev-Server.", isError: true }));
    expect(screen.getByText("Screenshot der Vorschau fehlgeschlagen")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Lädt Screenshot" })).toBeNull();
  });
});

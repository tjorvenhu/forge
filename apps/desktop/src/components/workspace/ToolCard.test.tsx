import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionEventBody } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";
import type { ChatItem } from "./chat-items";
import { useUi } from "@/stores/ui";

type RpcModule = typeof RpcModuleNs;
type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { ToolCard } = await import("./ToolCard");

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
  it("shows a command as a card with title, duration, the command and the first lines of the output", () => {
    show(tool("Bash", { command: "pnpm test" }, { text: "1\n2\n3\n4\n5\n6" }, { doneTs: "2026-10-11T10:00:12.000Z" }));
    expect(screen.getByText("Bash-Befehl ausgeführt")).toBeTruthy();
    expect(screen.getByText("12 s")).toBeTruthy();
    expect(screen.getByText("pnpm test")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Befehl kopieren/ })).toBeTruthy();
    expect(screen.getByText("(gekürzt)")).toBeTruthy();
    expect(screen.getByRole("img", { name: "erfolgreich" })).toBeTruthy();
    expect(screen.getByText("1 2 3 4", { normalizer: (s) => s.replace(/\s+/g, " ").trim() })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+2 Zeilen" }));
    expect(screen.getByText(/^1\s+2\s+3\s+4\s+5\s+6$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Weniger anzeigen" })).toBeTruthy();
  });

  it("counts the lines of a Read instead of showing the file", () => {
    show(tool("Read", { file_path: "C:\\p1\\README.md" }, { text: "     1\t# Titel\n     2\tText\n     3\tMehr" }));
    expect(screen.getByText("Datei gelesen")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText("(3 Zeilen)")).toBeTruthy();
    expect(screen.queryByText(/Titel/)).toBeNull();
    useUi.setState({ activeProjectId: "p1", workspaceTab: "chat" });
    fireEvent.click(screen.getByRole("button", { name: /In Datei anzeigen/ }));
    expect(useUi.getState().workspaceTab).toBe("files");
    expect(useUi.getState().selectedFile.p1).toBe("README.md");
  });

  it("shows an edit as a compact diff with its counts", () => {
    show(tool("Edit", { file_path: "src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;" }, { text: "ok" }));
    expect(screen.getByText("Code geändert")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Diff anzeigen/ })).toBeTruthy();
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
    expect(screen.getByText("const a = 1;")).toBeTruthy();
    expect(screen.getByText("const a = 2;")).toBeTruthy();
  });

  it("marks errors, running calls and opens the details on click", () => {
    show(tool("Bash", { command: "exit 1" }, { text: "kaputt", isError: true }));
    expect(screen.getByRole("img", { name: "Fehler" })).toBeTruthy();
    expect(screen.getByText("Bash-Befehl fehlgeschlagen")).toBeTruthy();
    expect(screen.getByText("kaputt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details anzeigen" }));
    expect(screen.getByText("Eingabe")).toBeTruthy();
    cleanup();
    show(tool("Grep", { pattern: "foo" }, null), true);
    expect(screen.getByRole("img", { name: "läuft" })).toBeTruthy();
    expect(screen.getByText("Durchsucht Code")).toBeTruthy();
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

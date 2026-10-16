import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as RpcModuleNs from "@/lib/rpc";
import type * as NativeModuleNs from "@/lib/native";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<typeof RpcModuleNs>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));
const explorerMock = vi.fn(async (_path: string) => {});
vi.mock("@/lib/native", async (orig) => ({ ...(await orig<typeof NativeModuleNs>()), showInExplorer: (p: string) => explorerMock(p) }));

const { findFileRefs, parseFileRef, projectPath, FileLinkContext } = await import("./file-links");
const { Markdown } = await import("./Markdown");
const { useUi } = await import("@/stores/ui");
const { queryClient } = await import("@/lib/queries");

const ROOT = "C:\\code\\shop";
const FILES: Record<string, string> = { "src/cart.ts": "a\nb\nc", "src/ui/Button.tsx": "x", "package.json": "{}" };

describe("file paths in text", () => {
  it("finds paths with a folder and an optional line, but no web hosts, numbers or prose", () => {
    const refs = (t: string) => findFileRefs(t).map((r) => [t.slice(r.start, r.end), r.ref.path, r.ref.line]);
    expect(refs("Siehe src/cart.ts:12 und apps/desktop/src/ui/misc.tsx.")).toEqual([
      ["src/cart.ts:12", "src/cart.ts", 12],
      ["apps/desktop/src/ui/misc.tsx", "apps/desktop/src/ui/misc.tsx", null],
    ]);
    expect(refs("In C:\\code\\shop\\src\\cart.ts#L4 steht es.")).toEqual([["C:\\code\\shop\\src\\cart.ts#L4", "C:/code/shop/src/cart.ts", 4]]);
    expect(refs("github.com/org/repo.git, 1.5/2.0, und/oder, Node.js, https://x.de/a/b.html")).toEqual([]);
  });

  it("finds absolute folders, also in Git Bash notation, without the sentence's full stop", () => {
    const text = "Liegt in C:\\Users\\tjorven\\Coding\\forge\\apps\\desktop. Dann cd /c/Users/tjorven/forge && ls";
    const found = findFileRefs(text).map((r) => [text.slice(r.start, r.end), r.ref.path, r.ref.isFile]);
    expect(found).toEqual([
      ["C:\\Users\\tjorven\\Coding\\forge\\apps\\desktop", "C:/Users/tjorven/Coding/forge/apps/desktop", false],
      ["/c/Users/tjorven/forge", "C:/Users/tjorven/forge", false],
    ]);
    expect(parseFileRef("C:\\Program Files\\Git")).toEqual({ path: "C:/Program Files/Git", line: null, bare: false, isFile: false });
  });

  it("takes a whole path or a bare file name with a known extension, not code", () => {
    expect(parseFileRef("src/cart.ts:3:7")).toEqual({ path: "src/cart.ts", line: 3, bare: false, isFile: true });
    expect(parseFileRef("package.json")).toEqual({ path: "package.json", line: null, bare: true, isFile: true });
    expect(parseFileRef("useUi.getState")).toBeNull();
    expect(parseFileRef("pnpm test")).toBeNull();
  });

  it("maps absolute paths into the project and leaves others out", () => {
    expect(projectPath({ path: "C:/Code/Shop/src/cart.ts", line: null, bare: false, isFile: true }, ROOT)).toBe("src/cart.ts");
    expect(projectPath({ path: "./src/cart.ts", line: null, bare: false, isFile: true }, ROOT)).toBe("src/cart.ts");
    expect(projectPath({ path: "D:/other/x.ts", line: null, bare: false, isFile: true }, ROOT)).toBeNull();
  });
});

describe("file links in the chat", () => {
  afterEach(cleanup);
  beforeEach(() => {
    queryClient.clear();
    callMock.mockReset();
    callMock.mockImplementation(async (method: string, p: { path?: string }) => {
      if (method === "projects.readFile") {
        if (!(p.path! in FILES)) throw new Error("not found");
        return { content: FILES[p.path!], binary: false, truncated: false };
      }
      if (method === "projects.allFiles") return { files: Object.keys(FILES).map((path) => ({ name: path.split("/").at(-1)!, path })), truncated: false };
      throw new Error("unexpected " + method);
    });
    useUi.setState({ view: "workspace", activeProjectId: "shop", workspaceTab: "chat", selectedFile: {}, fileJump: null, splitPanes: [] });
  });

  const show = (text: string, pane: string | null = null) =>
    render(
      <FileLinkContext.Provider value={{ projectId: "shop", root: ROOT, pane }}>
        <Markdown text={text} />
      </FileLinkContext.Provider>,
    );

  it("opens a path from running text in the Files tab at its line", async () => {
    show("Der Fehler steckt in src/cart.ts:2, siehe auch [den Button](src/ui/Button.tsx).");
    fireEvent.click(screen.getByText("src/cart.ts:2"));
    await waitFor(() => expect(useUi.getState().workspaceTab).toBe("files"));
    expect(useUi.getState()).toMatchObject({ selectedFile: { shop: "src/cart.ts" }, fileJump: { projectId: "shop", path: "src/cart.ts", line: 2 } });
    fireEvent.click(screen.getByText("den Button"));
    await waitFor(() => expect(useUi.getState().selectedFile.shop).toBe("src/ui/Button.tsx"));
  });

  it("finds a bare file name in inline code among the project's files", async () => {
    show("Die Version steht in `package.json`, der Code in `Button.tsx`.");
    fireEvent.click(screen.getByText("Button.tsx"));
    await waitFor(() => expect(useUi.getState().selectedFile.shop).toBe("src/ui/Button.tsx"));
  });

  it("finds a bare file name written in other case", async () => {
    show("Siehe `button.tsx`.");
    fireEvent.click(screen.getByText("button.tsx"));
    await waitFor(() => expect(useUi.getState().selectedFile.shop).toBe("src/ui/Button.tsx"));
  });

  it("finds a path written from a subfolder by its ending", async () => {
    show("Geändert: ui/Button.tsx");
    fireEvent.click(screen.getByText("ui/Button.tsx"));
    await waitFor(() => expect(useUi.getState().selectedFile.shop).toBe("src/ui/Button.tsx"));
  });

  it("does not open a file that is not there, and leaves code blocks alone", async () => {
    const { container } = show("Gibt es nicht: src/missing.ts\n\n```\nsrc/cart.ts\n```");
    fireEvent.click(screen.getByText("src/missing.ts"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("projects.readFile", { projectId: "shop", path: "src/missing.ts" }));
    expect(useUi.getState().workspaceTab).toBe("chat");
    expect(container.querySelector("pre [data-file-link]")).toBeNull();
  });

  it("stays plain text outside a chat", () => {
    const { container } = render(<Markdown text="Siehe src/cart.ts" />);
    expect(container.querySelector("[data-file-link]")).toBeNull();
    expect(container.textContent).toBe("Siehe src/cart.ts");
  });

  it("opens folders and files outside the project in Explorer, never in the Files tab", async () => {
    show("Ordner C:\\code\\shop\\src und die Datei `D:\\tools\\setup.exe`");
    fireEvent.click(screen.getByText("C:\\code\\shop\\src"));
    await waitFor(() => expect(explorerMock).toHaveBeenCalledWith("C:\\code\\shop\\src"));
    fireEvent.click(screen.getByText("D:\\tools\\setup.exe"));
    await waitFor(() => expect(explorerMock).toHaveBeenLastCalledWith("D:\\tools\\setup.exe"));
    expect(useUi.getState().workspaceTab).toBe("chat");
  });
});

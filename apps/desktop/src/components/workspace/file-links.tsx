import { createContext, useContext, type ReactNode } from "react";
import { call, keys, queryClient } from "@/lib/queries";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { crawlFiles } from "@/components/layout/palette-sources";
import { isChatWindow, openFileInMain } from "@/lib/chat-windows";

/**
 * The project file paths in a chat refer to. Given by the chat; without it (knowledge, dialogs) paths
 * stay plain text.
 */
export interface FileLinkTarget {
  projectId: string;
  /** project folder, to turn absolute paths into project paths */
  root: string;
  /** split pane the chat sits in; the file opens in the main area, so the pane becomes the main one first */
  pane: string | null;
}

export const FileLinkContext = createContext<FileLinkTarget | null>(null);

export interface FileRef {
  /** as written, with forward slashes; relative to the project unless absolute */
  path: string;
  line: number | null;
  /** only a file name: looked up among the project's files on click */
  bare: boolean;
}

/** Extensions a bare file name in inline code needs, so `useUi.getState` or `Next.js` stay code. */
const FILE_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonc md mdx css scss sass less html htm vue svelte astro yml yaml toml ini cfg conf env " +
    "rs go py rb php java kt kts swift c h cc cpp hpp cs fs sh bash zsh ps1 psm1 bat cmd sql prisma graphql gql proto xml svg " +
    "txt csv lock gradle dart lua r scala ex exs erl hs ml zig nix tf hcl dockerfile gitignore"
  ).split(" "),
);

const LINE = String.raw`(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?`;
/** A path with at least one folder and a file extension, e.g. src/app.ts, ./a/b.tsx:12, C:\x\y.md */
const PATH = String.raw`(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w@.()\[\]+-]+[\\/])+[\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,9}`;
const PATH_IN_TEXT = new RegExp(String.raw`(?<![\w/\\.:@-])(${PATH})${LINE}(?![\w/\\])`, "g");
const WHOLE_PATH = new RegExp(String.raw`^(${PATH})${LINE}$`);
const BARE_NAME = new RegExp(String.raw`^([\w@.+-]+\.([A-Za-z][A-Za-z0-9]{0,9}))${LINE}$`);
/** github.com/org/repo.git and the like: hosts, not folders */
const HOST = /^[\w-]+(?:\.[\w-]+)*\.(?:com|de|org|net|io|dev|app|co|ai|eu)\//i;

const lineOf = (a?: string, b?: string) => (a ? Number(a) : b ? Number(b) : null);

/** A path written alone, as in inline code or a markdown link target; null if it is no file path. */
export function parseFileRef(raw: string): FileRef | null {
  const text = raw.trim();
  const m = WHOLE_PATH.exec(text);
  if (m && !HOST.test(m[1]!)) return { path: m[1]!.replace(/\\/g, "/"), line: lineOf(m[2], m[3]), bare: false };
  const b = BARE_NAME.exec(text);
  if (b && FILE_EXTENSIONS.has(b[2]!.toLowerCase())) return { path: b[1]!, line: lineOf(b[3], b[4]), bare: true };
  return null;
}

/** Paths in running text, with their position; only paths with a folder, a bare name in prose is too often something else. */
export function findFileRefs(text: string): Array<{ start: number; end: number; ref: FileRef }> {
  const out: Array<{ start: number; end: number; ref: FileRef }> = [];
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    if (HOST.test(m[1]!)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, ref: { path: m[1]!.replace(/\\/g, "/"), line: lineOf(m[2], m[3]), bare: false } });
  }
  return out;
}

/** The path inside the project, or null when an absolute path lies outside of it. */
export function projectPath(ref: FileRef, root: string): string | null {
  const p = ref.path.replace(/^\.\//, "");
  if (!/^(?:[A-Za-z]:\/|\/)/.test(p)) return p;
  const dir = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return p.toLowerCase().startsWith(dir.toLowerCase() + "/") ? p.slice(dir.length + 1) : null;
}

/** Scheme of the links remarkFileLinks puts in for paths in running text. */
export const FILE_LINK_SCHEME = "forge-file:";

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

/** Remark plugin: paths in running text become links with FILE_LINK_SCHEME; code and links stay as they are. */
export function remarkFileLinks() {
  const walk = (node: MdNode) => {
    const kids = node.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i]!;
      if (c.type === "text" && c.value) {
        const refs = findFileRefs(c.value);
        if (!refs.length) continue;
        const parts: MdNode[] = [];
        let at = 0;
        for (const r of refs) {
          if (r.start > at) parts.push({ type: "text", value: c.value.slice(at, r.start) });
          const raw = c.value.slice(r.start, r.end);
          parts.push({ type: "link", url: FILE_LINK_SCHEME + encodeURIComponent(raw), children: [{ type: "text", value: raw }] });
          at = r.end;
        }
        if (at < c.value.length) parts.push({ type: "text", value: c.value.slice(at) });
        kids.splice(i, 1, ...parts);
        i += parts.length - 1;
      } else if (c.type !== "link" && c.type !== "linkReference") walk(c);
    }
  };
  return (tree: MdNode) => walk(tree);
}

/** Opens a path in the Files tab of the project, at its line; tells when the file is not there. */
export async function openFileRef(target: FileLinkTarget, ref: FileRef) {
  let path = projectPath(ref, target.root);
  if (path === null) return;
  try {
    if (ref.bare) {
      const files = await queryClient.fetchQuery({
        queryKey: ["paletteFiles", target.projectId],
        queryFn: () => crawlFiles((dir) => call("projects.listFiles", { projectId: target.projectId, dir })),
        staleTime: 60_000,
      });
      const hits = files.filter((f) => f.name === path);
      if (hits.length !== 1) {
        toast.error(hits.length ? `${hits.length} Dateien heißen ${path}` : "Datei nicht gefunden", hits.length ? hits.slice(0, 4).map((f) => f.path).join(", ") : path);
        return;
      }
      path = hits[0]!.path;
    } else {
      const p = path;
      await queryClient.fetchQuery({ queryKey: keys.file(target.projectId, p), queryFn: () => call("projects.readFile", { projectId: target.projectId, path: p }) });
    }
  } catch {
    toast.error("Datei nicht gefunden", path);
    return;
  }
  if (isChatWindow()) return openFileInMain(target.projectId, path, ref.line);
  const ui = useUi.getState();
  if (target.pane) ui.promoteSplitPane(target.pane);
  ui.openFile(target.projectId, path, ref.line);
}

/** A file path in the chat: opens the file in the Files tab, at the line if one is given. */
export function FileLink({ fileRef, children }: { fileRef: FileRef; children: ReactNode }) {
  const target = useContext(FileLinkContext);
  if (!target || projectPath(fileRef, target.root) === null) return <>{children}</>;
  return (
    <a
      href="#"
      data-file-link
      title={`${fileRef.path}${fileRef.line ? `, Zeile ${fileRef.line}` : ""} öffnen`}
      onClick={(e) => {
        e.preventDefault();
        void openFileRef(target, fileRef);
      }}
    >
      {children}
    </a>
  );
}

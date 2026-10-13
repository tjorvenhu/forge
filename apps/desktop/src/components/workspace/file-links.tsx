import { createContext, useContext, type ReactNode } from "react";
import { call, keys, queryClient } from "@/lib/queries";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { crawlFiles } from "@/components/layout/palette-sources";
import { isChatWindow, openFileInMain } from "@/lib/chat-windows";
import { showInExplorer } from "@/lib/native";
import { errorMessage } from "@/lib/rpc";

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
  /** with forward slashes (Git Bash's /c/... as C:/...); relative to the project unless absolute */
  path: string;
  line: number | null;
  /** only a file name: looked up among the project's files on click */
  bare: boolean;
  /** has a file extension: a file of the project opens in the Files tab; without one it is a folder for Explorer */
  isFile: boolean;
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
/** An absolute Windows path without an extension, i.e. a folder: C:\x\y or Git Bash's /c/x/y */
const ABS_DIR = String.raw`(?:[A-Za-z]:[\\/]|\/[A-Za-z]\/)[\w@.+-]+(?:[\\/][\w@.+-]+)*[\\/]?`;
const PATH_IN_TEXT = new RegExp(String.raw`(?<![\w/\\.:@-])(?:(${PATH})|(${ABS_DIR}))${LINE}(?![\w/\\])`, "g");
const WHOLE_PATH = new RegExp(String.raw`^(${PATH})${LINE}$`);
/** In inline code or a link the whole text is the path, so spaces are fine (C:\Program Files\Git). */
const WHOLE_ABS = /^((?:[A-Za-z]:[\\/]|\/[A-Za-z]\/)[\w@.()+ -]*(?:[\\/][\w@.()+ -]+)*[\\/]?)$/;
const BARE_NAME = new RegExp(String.raw`^([\w@.+-]+\.([A-Za-z][A-Za-z0-9]{0,9}))${LINE}$`);
/** github.com/org/repo.git and the like: hosts, not folders */
const HOST = /^[\w-]+(?:\.[\w-]+)*\.(?:com|de|org|net|io|dev|app|co|ai|eu)\//i;
const HAS_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

const lineOf = (a?: string, b?: string) => (a ? Number(a) : b ? Number(b) : null);

/** Forward slashes, Git Bash's /c/... as C:/..., no trailing dot or slash from the sentence around it. */
function normalize(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^\/([A-Za-z])\//, (_, d: string) => `${d.toUpperCase()}:/`)
    .replace(/(?<=.)[./]+$/, "");
}

const isAbsolute = (path: string) => /^[A-Za-z]:\//.test(path);

/** A path written alone, as in inline code or a markdown link target; null if it is no path. */
export function parseFileRef(raw: string): FileRef | null {
  const text = raw.trim();
  const m = WHOLE_PATH.exec(text);
  if (m && !HOST.test(m[1]!)) return { path: normalize(m[1]!), line: lineOf(m[2], m[3]), bare: false, isFile: true };
  const a = WHOLE_ABS.exec(text);
  if (a) {
    const path = normalize(a[1]!);
    return { path, line: null, bare: false, isFile: HAS_EXTENSION.test(path) };
  }
  const b = BARE_NAME.exec(text);
  if (b && FILE_EXTENSIONS.has(b[2]!.toLowerCase())) return { path: b[1]!, line: lineOf(b[3], b[4]), bare: true, isFile: true };
  return null;
}

/**
 * Paths in running text, with their position: paths with a folder and a file extension, and absolute
 * folder paths. A bare name in prose is too often something else.
 */
export function findFileRefs(text: string): Array<{ start: number; end: number; ref: FileRef }> {
  const out: Array<{ start: number; end: number; ref: FileRef }> = [];
  for (const m of text.matchAll(PATH_IN_TEXT)) {
    const file = m[1];
    if (file && HOST.test(file)) continue;
    let end = m.index + m[0].length;
    // "Liegt in C:\x\y." The sentence's full stop is not part of the folder.
    if (!file) while (end > m.index && ".,".includes(text[end - 1]!)) end--;
    out.push({ start: m.index, end, ref: { path: normalize(file ?? m[2]!), line: lineOf(m[3], m[4]), bare: false, isFile: !!file } });
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

/** Where a click on the path goes: a project file into the Files tab, an absolute path into Explorer, otherwise nowhere. */
function destination(ref: FileRef, target: FileLinkTarget | null): "files" | "explorer" | null {
  if (ref.isFile && target && projectPath(ref, target.root) !== null) return "files";
  return isAbsolute(ref.path) ? "explorer" : null;
}

/** Shows an absolute path in Explorer; a failure ends up as a toast. */
export async function revealPath(path: string) {
  try {
    await showInExplorer(path.replace(/\//g, "\\"));
  } catch (e) {
    toast.error("Nicht geöffnet", `${path}: ${errorMessage(e)}`);
  }
}

/** Shows a file or folder of the project (path relative to its root, "" for the root itself) in Explorer. */
export function revealInProject(root: string, path: string) {
  return revealPath(path ? `${root.replace(/[\\/]+$/, "")}/${path}` : root);
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
  const projectFiles = () =>
    queryClient.fetchQuery({
      queryKey: ["paletteFiles", target.projectId],
      queryFn: () => crawlFiles((dir) => call("projects.listFiles", { projectId: target.projectId, dir })),
      staleTime: 60_000,
      retry: false,
    });
  /** The one project file the name or path ending fits; otherwise says what went wrong. */
  const unique = (hits: Array<{ path: string }>, wanted: string) => {
    if (hits.length === 1) return hits[0]!.path;
    toast.error(hits.length ? `${hits.length} Dateien passen zu ${wanted}` : "Datei nicht gefunden", hits.length ? hits.slice(0, 4).map((f) => f.path).join(", ") : wanted);
    return null;
  };
  try {
    if (ref.bare) {
      const name = path;
      path = unique((await projectFiles()).filter((f) => f.name === name), name);
    } else {
      const p = path;
      try {
        await queryClient.fetchQuery({ queryKey: keys.file(target.projectId, p), queryFn: () => call("projects.readFile", { projectId: target.projectId, path: p }), retry: false });
      } catch {
        // Claude often writes paths from the folder it worked in (src-tauri/Cargo.toml for apps/desktop/src-tauri/...).
        path = unique((await projectFiles()).filter((f) => f.path.endsWith(`/${p}`)), p);
      }
    }
  } catch {
    toast.error("Datei nicht gefunden", path ?? ref.path);
    return;
  }
  if (path === null) return;
  if (isChatWindow()) return openFileInMain(target.projectId, path, ref.line);
  const ui = useUi.getState();
  if (target.pane) ui.promoteSplitPane(target.pane);
  ui.openFile(target.projectId, path, ref.line);
}

/**
 * Plain text (tool output, a command) with its file paths as links. Only paths with a folder, as in
 * running text; Grep's "src/a.ts:12:..." opens at the line.
 */
export function LinkedText({ text, linkClassName }: { text: string; linkClassName?: string }) {
  const refs = findFileRefs(text);
  if (!refs.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let at = 0;
  for (const r of refs) {
    if (r.start > at) out.push(text.slice(at, r.start));
    out.push(
      <FileLink key={r.start} fileRef={r.ref} className={linkClassName}>
        {text.slice(r.start, r.end)}
      </FileLink>,
    );
    at = r.end;
  }
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}

/**
 * A path in the chat: a project file opens in the Files tab (at the line if one is given), a folder or a
 * file outside the project in Explorer.
 */
export function FileLink({ fileRef, children, className }: { fileRef: FileRef; children: ReactNode; className?: string }) {
  const target = useContext(FileLinkContext);
  const to = destination(fileRef, target);
  if (!to) return <>{children}</>;
  return (
    <a
      href="#"
      data-file-link={to}
      className={cn("file-link", className)}
      title={
        to === "files"
          ? `${fileRef.path}${fileRef.line ? `, Zeile ${fileRef.line}` : ""} öffnen`
          : `${fileRef.path} im Explorer ${fileRef.isFile ? "zeigen" : "öffnen"}`
      }
      onClick={(e) => {
        e.preventDefault();
        if (to === "files" && target) void openFileRef(target, fileRef);
        else void revealPath(fileRef.path);
      }}
    >
      {children}
    </a>
  );
}

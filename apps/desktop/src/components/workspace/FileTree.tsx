import { useMemo, useState, type ComponentType } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Copy,
  Database,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileKey2,
  FileStack,
  FileLock2,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  FolderSearch,
  FolderTree,
} from "lucide-react";
import type { FileStatus, Project } from "@forge/protocol";
import { call, keys, useGitStatus } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { useTemplateDialogs } from "@/stores/templates";
import { contextItems, copyText } from "@/lib/context-menu";
import { fileValues } from "@/components/templates/template-values";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapse } from "@/components/ui/collapse";
import { revealInProject } from "./file-links";

type Icon = ComponentType<{ className?: string }>;

const BY_EXT: Array<[RegExp, Icon, string]> = [
  [/\.(tsx?|jsx?|mjs|cjs|vue|svelte|rs|go|py|rb|java|kt|cs|php|swift|c|cpp|h)$/i, FileCode2, "text-accent"],
  [/\.(json|jsonc)$/i, FileJson, "text-warning"],
  [/\.(md|mdx|txt|rst)$/i, FileText, "text-muted"],
  [/\.(png|jpe?g|gif|webp|svg|ico|avif)$/i, FileImage, "text-success"],
  [/\.(css|scss|sass|less|html?)$/i, FileType2, "text-claude"],
  [/\.(ya?ml|toml|ini|conf|config|xml)$/i, FileCog, "text-muted"],
  [/\.(sh|ps1|bat|cmd)$/i, FileTerminal, "text-success"],
  [/\.(sql|sqlite|db)$/i, Database, "text-accent"],
  [/\.(csv|xlsx?)$/i, FileSpreadsheet, "text-success"],
  [/\.(zip|tar|gz|7z)$/i, FileArchive, "text-muted"],
];

/** Icon and tone for a file name; colors come from the design tokens. */
export function fileIcon(name: string): [Icon, string] {
  if (/^\.env/i.test(name) || /\.(pem|key)$/i.test(name)) return [FileKey2, "text-warning"];
  if (/(^|[.-])lock(\.|$)|lock\.ya?ml$|\.lockb$/i.test(name)) return [FileLock2, "text-subtle"];
  if (/^\.(git|npm|prettier|eslint|editor)|^dockerfile$/i.test(name)) return [FileCog, "text-claude"];
  for (const [re, icon, tone] of BY_EXT) if (re.test(name)) return [icon, tone];
  return [File, "text-subtle"];
}

const MARK: Record<FileStatus["kind"], { letter: string; tone: string; label: string }> = {
  modified: { letter: "M", tone: "text-warning", label: "geändert" },
  added: { letter: "A", tone: "text-success", label: "neu (vorgemerkt)" },
  untracked: { letter: "U", tone: "text-success", label: "neu" },
  deleted: { letter: "D", tone: "text-danger", label: "gelöscht" },
  renamed: { letter: "R", tone: "text-accent", label: "umbenannt" },
  conflicted: { letter: "!", tone: "text-danger", label: "Konflikt" },
  typechange: { letter: "T", tone: "text-accent", label: "Typ geändert" },
};

/** Project files as a tree with git markers; a click opens the file in the Dateien tab. */
export function FileTree({ project }: { project: Project }) {
  const git = useGitStatus(project.id);
  const status = useMemo(() => {
    const files = new Map<string, FileStatus["kind"]>();
    const dirs = new Set<string>();
    for (const f of git.data?.files ?? []) {
      files.set(f.path, f.kind);
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
    }
    return { files, dirs };
  }, [git.data]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <FolderTree className="h-4 w-4 text-muted" />
        <span className="min-w-0 flex-1 truncate text-ui font-medium">{project.name}</span>
        {!!git.data?.files.length && <span className="text-caption text-subtle">{git.data.files.length} geändert</span>}
        <Button size="icon-sm" variant="ghost" className="-mr-2" onClick={() => void revealInProject(project.path, "")} aria-label="Projektordner im Explorer öffnen" title="Projektordner im Explorer öffnen">
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Level project={project} dir="" depth={0} status={status} />
      </div>
    </div>
  );
}

function Level({ project, dir, depth, status }: { project: Project; dir: string; depth: number; status: { files: Map<string, FileStatus["kind"]>; dirs: Set<string> } }) {
  const q = useQuery({ queryKey: keys.files(project.id, dir), queryFn: () => call("projects.listFiles", { projectId: project.id, dir }) });
  const qc = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const selected = useUi((s) => s.selectedFile[project.id] ?? null);
  const pad = (d: number) => ({ paddingLeft: 8 + d * 16 });
  if (q.isLoading)
    return (
      <div className="flex flex-col gap-2 py-2" role="status" aria-label="Lädt">
        {[60, 45].map((w) => (
          <div key={w} style={pad(depth)} className="flex items-center gap-2">
            <Skeleton className="h-3.5 w-3.5 rounded-sm" />
            <Skeleton className="h-3 rounded-sm" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    );
  if (q.isError) return <div className="px-3 py-1 text-xs text-danger">{errorMessage(q.error)}</div>;
  return (
    <ul>
      {q.data?.map((e) => {
        const isOpen = open.has(e.path);
        const kind = status.files.get(e.path);
        const mark = kind ? MARK[kind] : null;
        const [FileIcon, tone] = fileIcon(e.name);
        return (
          <li key={e.path}>
            <button
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-body-lg transition-colors",
                selected === e.path ? "bg-surface-3 text-fg" : "text-fg/90 hover:bg-surface-2",
              )}
              style={pad(depth)}
              // Folders load their entries while the pointer is on them, so opening shows them at once.
              onPointerEnter={() => {
                if (e.isDir && !isOpen) void qc.prefetchQuery({ queryKey: keys.files(project.id, e.path), queryFn: () => call("projects.listFiles", { projectId: project.id, dir: e.path }), staleTime: 30_000 });
              }}
              onClick={() => {
                if (!e.isDir) return useUi.getState().openFile(project.id, e.path);
                setOpen((s) => {
                  const n = new Set(s);
                  if (n.has(e.path)) n.delete(e.path);
                  else n.add(e.path);
                  return n;
                });
              }}
              onContextMenu={contextItems(() => [
                ...(!e.isDir ? [{ label: "Öffnen", icon: <FileText className="h-3.5 w-3.5" />, onSelect: () => useUi.getState().openFile(project.id, e.path) }] : []),
                { label: "Vorlage anwenden", icon: <FileStack className="h-3.5 w-3.5" />, hint: e.name, onSelect: () => useTemplateDialogs.getState().openApply({ projectId: project.id, values: fileValues(e.path) }) },
                { label: "Im Explorer zeigen", icon: <FolderSearch className="h-3.5 w-3.5" />, onSelect: () => void revealInProject(project.path, e.path) },
                { label: "Pfad kopieren", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(e.path) },
              ])}
              aria-expanded={e.isDir ? isOpen : undefined}
              title={mark ? `${e.path} (${mark.label})` : e.path}
            >
              {e.isDir ? (
                <>
                  <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", isOpen && "rotate-90")} />
                  {isOpen ? <FolderOpen className="h-4 w-4 shrink-0 fill-accent/25 text-accent" /> : <Folder className="h-4 w-4 shrink-0 fill-accent/25 text-accent" />}
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0" />
                  <FileIcon className={cn("h-4 w-4 shrink-0", tone)} />
                </>
              )}
              <span className={cn("min-w-0 flex-1 truncate", e.isDir && status.dirs.has(e.path) && "text-warning/90")}>{e.name}</span>
              {mark && <span className={cn("shrink-0 font-mono text-caption font-semibold", mark.tone)}>{mark.letter}</span>}
            </button>
            {e.isDir && (
              <Collapse open={isOpen}>
                <Level project={project} dir={e.path} depth={depth + 1} status={status} />
              </Collapse>
            )}
          </li>
        );
      })}
    </ul>
  );
}

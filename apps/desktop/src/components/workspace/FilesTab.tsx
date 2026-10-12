import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder } from "lucide-react";
import type { Project } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { CodeView } from "@/components/ui/code-view";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { useUi } from "@/stores/ui";
import { fileIcon } from "./FileTree";
import { ListSkeleton } from "@/components/ui/skeleton";

/** Read-only project browser. Editing happens through Claude or your editor. */
export function FilesTab({ project }: { project: Project }) {
  const file = useUi((s) => s.selectedFile[project.id] ?? null);
  const setFile = (p: string) => useUi.getState().selectFile(project.id, p);
  if (!project.exists) return <EmptyState title="Projektordner fehlt" />;
  return (
    <div className="grid h-full min-h-0 grid-cols-[300px_minmax(0,1fr)]">
      <div className="min-h-0 overflow-y-auto border-r border-border py-2">
        <Dir projectId={project.id} dir="" depth={0} selected={file} onSelect={setFile} />
      </div>
      <div className="min-h-0">{file ? <FileViewer projectId={project.id} path={file} /> : <EmptyState title="Datei auswählen">Links eine Datei anklicken.</EmptyState>}</div>
    </div>
  );
}

function Dir({ projectId, dir, depth, selected, onSelect }: { projectId: string; dir: string; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const q = useQuery({ queryKey: keys.files(projectId, dir), queryFn: () => call("projects.listFiles", { projectId, dir }) });
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (q.isLoading) return <ListSkeleton rows={2} className="py-1" />;
  if (q.isError) return <div className="px-3 text-xs text-danger">{errorMessage(q.error)}</div>;
  return (
    <ul>
      {q.data?.map((e) => (
        <li key={e.path}>
          <button
            className={cn("flex w-full items-center gap-1.5 py-0.5 pr-2 text-left text-small-lg hover:bg-surface-2", selected === e.path && "bg-surface-3")}
            style={{ paddingLeft: 10 + depth * 14 }}
            onClick={() => {
              if (!e.isDir) return onSelect(e.path);
              setOpen((s) => {
                const n = new Set(s);
                if (n.has(e.path)) n.delete(e.path);
                else n.add(e.path);
                return n;
              });
            }}
            aria-expanded={e.isDir ? open.has(e.path) : undefined}
          >
            {e.isDir ? (
              <>
                <ChevronRight className={cn("h-3 w-3 shrink-0 text-subtle transition-transform", open.has(e.path) && "rotate-90")} />
                <Folder className="h-3.5 w-3.5 shrink-0 fill-accent/25 text-accent" />
              </>
            ) : (
              <>
                <span className="w-3 shrink-0" />
                <FileIconFor name={e.name} />
              </>
            )}
            <span className="truncate">{e.name}</span>
          </button>
          {e.isDir && open.has(e.path) && <Dir projectId={projectId} dir={e.path} depth={depth + 1} selected={selected} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}

function FileIconFor({ name }: { name: string }) {
  const [Icon, tone] = fileIcon(name);
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", tone)} />;
}

function FileViewer({ projectId, path }: { projectId: string; path: string }) {
  const q = useQuery({ queryKey: keys.file(projectId, path), queryFn: () => call("projects.readFile", { projectId, path }) });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center border-b border-border px-3 font-mono text-xs text-muted">{path}</div>
      {q.isLoading && <ListSkeleton rows={6} />}
      {q.isError && <div className="p-3"><ErrorBanner>{errorMessage(q.error)}</ErrorBanner></div>}
      {q.data?.binary && <div className="p-4 text-xs text-muted">Binärdatei, keine Vorschau.</div>}
      {q.data && !q.data.binary && (
        <div className="min-h-0 flex-1">
          <CodeView path={path} content={q.data.content} truncated={q.data.truncated} />
        </div>
      )}
    </div>
  );
}

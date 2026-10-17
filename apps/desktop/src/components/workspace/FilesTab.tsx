import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import type { Project } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CodeView, CodeViewSkeleton } from "@/components/ui/code-view";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { useUi } from "@/stores/ui";
import { fileIcon } from "./FileTree";
import { revealInProject } from "./file-links";
import { MediaPreview, NoPreview, mediaType } from "./FilePreview";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

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
      <div className="min-h-0">{file ? <FileViewer project={project} path={file} /> : <EmptyState title="Datei auswählen">Links eine Datei anklicken.</EmptyState>}</div>
    </div>
  );
}

function Dir({ projectId, dir, depth, selected, onSelect }: { projectId: string; dir: string; depth: number; selected: string | null; onSelect: (p: string) => void }) {
  const q = useQuery({ queryKey: keys.files(projectId, dir), queryFn: () => call("projects.listFiles", { projectId, dir }) });
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (q.isLoading)
    return (
      <SkeletonRegion className="flex flex-col py-0.5">
        {[55, 40, 48].map((w) => (
          <div key={w} className="flex h-5.5 items-center gap-1.5 pr-2" style={{ paddingLeft: 10 + depth * 14 }}>
            <span className="w-3 shrink-0" />
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
            <Skeleton className="h-3 rounded-sm" style={{ width: `${w}%` }} />
          </div>
        ))}
      </SkeletonRegion>
    );
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

function FileViewer({ project, path }: { project: Project; path: string }) {
  const projectId = project.id;
  const media = mediaType(path);
  const isSvg = media?.mime === "image/svg+xml";
  // SVG is text: preview by default, its code on request. Other media never load as text.
  const [svgCodeFor, setSvgCodeFor] = useState<string | null>(null);
  const svgCode = svgCodeFor === path;
  const setSvgCode = (on: boolean) => setSvgCodeFor(on ? path : null);
  const showMedia = media && !(isSvg && svgCode);
  const q = useQuery({ queryKey: keys.file(projectId, path), queryFn: () => call("projects.readFile", { projectId, path }), enabled: !showMedia });
  const jump = useUi((s) => (s.fileJump?.projectId === projectId && s.fileJump.path === path ? s.fileJump : null));
  const reveal = () => void revealInProject(project.path, path);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border pl-3 pr-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{path}</span>
        {isSvg && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setSvgCode(!svgCode)} aria-pressed={svgCode}>
            {svgCode ? "Vorschau" : "Code"}
          </Button>
        )}
        <Button size="icon-sm" variant="ghost" onClick={reveal} aria-label="Im Explorer zeigen" title="Im Explorer zeigen">
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
      </div>
      {showMedia && <MediaPreview key={path} projectId={projectId} path={path} kind={media.kind} mime={media.mime} />}
      {!showMedia && q.isLoading && (
        <div className="min-h-0 flex-1">
          <CodeViewSkeleton />
        </div>
      )}
      {!showMedia && q.isError && <div className="p-3"><ErrorBanner>{errorMessage(q.error)}</ErrorBanner></div>}
      {!showMedia && q.data?.binary && <NoPreview path={path} onReveal={reveal} />}
      {!showMedia && q.data && !q.data.binary && (
        <div className="min-h-0 flex-1">
          <CodeView path={path} content={q.data.content} truncated={q.data.truncated} line={jump?.line} jumpKey={jump?.n} />
        </div>
      )}
    </div>
  );
}

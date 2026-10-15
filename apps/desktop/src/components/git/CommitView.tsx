import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, FileText, GitCommitHorizontal, MoreHorizontal, RotateCcw } from "lucide-react";
import type { CommitFile, CommitInfo } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { cn, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { DropdownMenu, type MenuItem } from "@/components/ui/dropdown";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { CodeSkeleton, Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { AuthorAvatar } from "./AuthorAvatar";
import { RefBadges } from "./CommitGraph";
import { DiffView } from "./DiffView";
import { KIND } from "./GitPanel";

/** The selected commit: message, author, changed files and the diff of one of them. */
export function CommitView({
  projectId,
  commit,
  avatarUrl,
  current,
  openChanges,
  localBranches,
  known,
  onSelect,
  onRestore,
}: {
  projectId: string;
  commit: CommitInfo;
  avatarUrl: string | null | undefined;
  /** the checked-out commit */
  current: boolean;
  openChanges: number;
  localBranches: ReadonlySet<string>;
  known: (hash: string) => boolean;
  onSelect: (hash: string) => void;
  onRestore: () => void;
}) {
  const details = useQuery({
    queryKey: keys.commitFiles(projectId, commit.hash),
    queryFn: () => call("git.commitFiles", { projectId, commit: commit.hash }),
    staleTime: Infinity,
    retry: false,
  });
  const [filePath, setFilePath] = useState<string | null>(null);
  useEffect(() => setFilePath(null), [commit.hash]);
  const files = details.data?.files ?? [];
  const body = details.data ? withoutTrailers(details.data.body) : "";
  const file = files.find((f) => f.path === filePath) ?? files[0];
  const additions = files.reduce((n, f) => n + f.additions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);
  const canRestore = !current || openChanges > 0;
  const restoreLabel = current ? "Beiseitelegen" : "Wiederherstellen";
  const restoreHint = current
    ? "Legt die offenen Änderungen als Git-Stash beiseite. Der Commit selbst bleibt."
    : "Holt alle Dateien auf diesen Stand zurück. Branch und Verlauf bleiben, das Ergebnis sind neue, nicht committete Änderungen.";

  const commitItems = (): MenuItem[] => [
    { label: "Hash kopieren", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(commit.hash) },
    { label: "Nachricht kopieren", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(details.data?.body ? `${commit.subject}\n\n${details.data.body}` : commit.subject) },
    ...commit.parents
      .filter(known)
      .map((p) => ({ label: `Vorgänger ${p.slice(0, 7)} anzeigen`, icon: <ArrowLeft className="h-3.5 w-3.5" />, onSelect: () => onSelect(p) })),
    ...(canRestore ? [{ label: restoreLabel, icon: <RotateCcw className="h-3.5 w-3.5" />, onSelect: onRestore }] : []),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <header className="flex shrink-0 flex-col gap-2.5" onContextMenu={contextItems(commitItems)}>
        <div className="flex items-start gap-3">
          <h2 className="min-w-0 flex-1 text-title font-semibold leading-snug [overflow-wrap:anywhere]">{commit.subject}</h2>
          <HashChip hash={commit.hash} short={commit.shortHash} />
          {canRestore && (
            <Button size="sm" variant="outline" onClick={onRestore} title={restoreHint}>
              <RotateCcw className="h-3.5 w-3.5" /> {restoreLabel}
            </Button>
          )}
          <DropdownMenu
            items={commitItems()}
            trigger={
              <Button size="icon-sm" variant="ghost" aria-label="Weitere Aktionen" title="Weitere Aktionen">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
          />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-small text-muted">
          <AuthorAvatar name={commit.author} url={avatarUrl} className="h-6 w-6" />
          <span className="text-fg" title={commit.authorEmail}>
            {commit.author}
          </span>
          <span aria-hidden>·</span>
          <span title={new Date(commit.date).toLocaleString("de-DE", { dateStyle: "full", timeStyle: "short" })}>{relativeTime(commit.date)}</span>
          {current && <Badge tone="accent">aktuell</Badge>}
          {commit.parents.length > 1 && <Badge>Merge</Badge>}
          <RefBadges refs={commit.refs} localBranches={localBranches} />
        </div>
        {body ? (
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-body text-muted [overflow-wrap:anywhere]">{body}</p>
        ) : (
          details.isLoading && (
            <SkeletonRegion label="Lädt Beschreibung">
              <Skeleton className="h-3 w-2/3 rounded-sm" />
            </SkeletonRegion>
          )
        )}
      </header>

      {details.isError ? (
        <ErrorBanner title="Dateien nicht geladen">{errorMessage(details.error)}</ErrorBanner>
      ) : (
        <section className="flex max-h-[40%] min-h-24 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-surface">
          <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border px-3">
            {details.data ? (
              <>
                <span className="min-w-0 flex-1 truncate text-body font-medium">
                  {files.length === 1 ? "1 Datei geändert" : `${files.length}${details.data.truncated ? "+" : ""} Dateien geändert`}
                </span>
                <span className="font-mono text-small text-success">+{additions}</span>
                <span className="font-mono text-small text-danger">-{deletions}</span>
              </>
            ) : (
              <SkeletonRegion label="Lädt Dateien" className="flex flex-1 items-center gap-3">
                <Skeleton className="h-3 w-32 rounded-sm" />
                <span className="flex-1" />
                <Skeleton className="h-3 w-16 rounded-sm" />
              </SkeletonRegion>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {details.isLoading && <FileRowsSkeleton />}
            {details.data && files.length === 0 && <p className="px-3 py-2 text-small text-subtle">Der Commit ändert in diesem Projektordner keine Dateien.</p>}
            {files.map((f) => (
              <FileRow key={f.path} projectId={projectId} file={f} active={f.path === file?.path} onSelect={() => setFilePath(f.path)} />
            ))}
            {details.data?.truncated && <p className="px-3 py-1.5 text-caption text-subtle">Weitere Dateien werden nicht angezeigt.</p>}
          </div>
        </section>
      )}

      {file ? (
        <DiffView key={`${commit.hash}:${file.path}`} projectId={projectId} commit={commit.hash} path={file.path} origPath={file.origPath} />
      ) : (
        details.isLoading && (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-bg">
            <div className="h-9 shrink-0 border-b border-border bg-surface" />
            <CodeSkeleton lines={14} label="Lädt Diff" />
          </div>
        )
      )}
    </div>
  );
}

/** The message body without trailer lines such as Co-Authored-By, which say nothing about the change. */
export function withoutTrailers(body: string): string {
  return body.replace(/^(Co-Authored-By|Signed-off-by|Reviewed-by|Change-Id):.*$/gim, "").trim();
}

function HashChip({ hash, short }: { hash: string; short: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      onClick={() => {
        copyText(hash);
        setCopied(true);
      }}
      title={`${hash}\nKlicken zum Kopieren`}
      aria-label="Commit-Hash kopieren"
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 font-mono text-caption text-muted transition-colors duration-120 hover:border-border-strong hover:text-fg"
    >
      {copied ? <Check className="h-3 w-3 text-success" /> : <GitCommitHorizontal className="h-3 w-3" />}
      {short}
    </button>
  );
}

function FileRow({ projectId, file, active, onSelect }: { projectId: string; file: CommitFile; active: boolean; onSelect: () => void }) {
  const k = KIND[file.kind];
  const slash = file.path.lastIndexOf("/");
  return (
    <button
      onClick={onSelect}
      onContextMenu={contextItems(() => [
        { label: "Pfad kopieren", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(file.path) },
        ...(file.kind === "deleted" ? [] : [{ label: "In Dateien öffnen", icon: <FileText className="h-3.5 w-3.5" />, onSelect: () => useUi.getState().openFile(projectId, file.path) }]),
      ])}
      aria-current={active ? "true" : undefined}
      title={file.origPath ? `${file.origPath} → ${file.path} (${k.label})` : `${file.path} (${k.label})`}
      className={cn("flex h-8 w-full items-center gap-2.5 px-3 text-left", active ? "bg-surface-3" : "hover:bg-surface-2")}
    >
      <span className={`w-3 shrink-0 text-center font-mono text-caption font-bold ${k.tone}`}>{k.letter}</span>
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-1.5", file.kind === "deleted" && "line-through decoration-subtle")}>
        <span className="shrink-0 truncate text-small-lg">{file.path.slice(slash + 1)}</span>
        {slash > 0 && <span className="min-w-0 truncate text-caption text-subtle">{file.path.slice(0, slash)}</span>}
      </span>
      {file.binary ? (
        <span className="text-caption text-subtle">binär</span>
      ) : (
        <span className="flex shrink-0 gap-2 font-mono text-caption">
          <span className="text-success">+{file.additions}</span>
          <span className="text-danger">-{file.deletions}</span>
        </span>
      )}
    </button>
  );
}

function FileRowsSkeleton() {
  return (
    <SkeletonRegion label="Lädt Dateien">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex h-8 items-center gap-2.5 px-3">
          <Skeleton className="h-3 w-3 shrink-0 rounded-sm" />
          <Skeleton className="h-3 rounded-sm" style={{ width: `${30 + ((i * 23) % 35)}%` }} />
          <span className="flex-1" />
          <Skeleton className="h-3 w-12 shrink-0 rounded-sm" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

/** Title, author line, file list and diff of a commit, while the history loads. */
export function CommitViewSkeleton() {
  return (
    <SkeletonRegion label="Lädt Commit" className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-1/2 rounded-sm" />
          <span className="flex-1" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-6 rounded-full" />
          <Skeleton className="h-3 w-40 rounded-sm" />
        </div>
      </div>
      <div className="shrink-0 overflow-hidden rounded-lg border border-border bg-surface">
        <div className="flex h-10 items-center border-b border-border px-3">
          <Skeleton className="h-3 w-32 rounded-sm" />
        </div>
        <div className="py-1">
          <FileRowsSkeleton />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-bg">
        <div className="h-9 shrink-0 border-b border-border bg-surface" />
        <CodeSkeleton lines={12} />
      </div>
    </SkeletonRegion>
  );
}

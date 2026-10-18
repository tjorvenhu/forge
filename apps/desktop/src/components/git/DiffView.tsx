import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FileCode2, X } from "lucide-react";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { ErrorBanner } from "@/components/ui/misc";
import { CodeSkeleton } from "@/components/ui/skeleton";

/**
 * Diff of one file: the working tree (staged or not) or, with `commit`, what that commit changed in it.
 * A commit never changes, so its diff is kept for good.
 */
export function DiffView({
  projectId,
  path,
  staged = false,
  commit,
  origPath,
  onClose,
}: {
  projectId: string;
  path: string;
  staged?: boolean;
  commit?: string;
  origPath?: string | null;
  onClose?: () => void;
}) {
  const diff = useQuery({
    queryKey: commit ? keys.commitDiff(projectId, commit, path) : keys.diff(projectId, path, staged),
    queryFn: () =>
      commit ? call("git.commitDiff", { projectId, commit, path, origPath: origPath ?? undefined }) : call("git.diff", { projectId, path, staged }),
    staleTime: commit ? Infinity : undefined,
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = diff.data?.lines ?? [];
  const v = useVirtualizer({ count: lines.length, getScrollElement: () => scrollRef.current, estimateSize: () => 18, overscan: 30 });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-xs">
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-mono" title={origPath ? `${origPath} → ${path}` : path}>
          {path}
        </span>
        {diff.data && (
          <>
            <span className="text-success">+{diff.data.additions}</span>
            <span className="text-danger">-{diff.data.deletions}</span>
          </>
        )}
        {staged && <span className="text-subtle">{t.git.common.staged}</span>}
        {onClose && (
          <button onClick={onClose} className="rounded p-0.5 text-subtle hover:text-fg" aria-label={t.git.diff.close}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {diff.isLoading && <CodeSkeleton lines={16} label={t.git.common.loadingDiff} />}
      {diff.isError && (
        <div className="p-3">
          <ErrorBanner>{errorMessage(diff.error)}</ErrorBanner>
        </div>
      )}
      {diff.data?.binary && <div className="p-4 text-xs text-muted">{t.git.diff.binary}</div>}
      {diff.data && !diff.data.binary && lines.length === 0 && <div className="p-4 text-xs text-muted">{t.git.diff.noTextChanges}</div>}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto font-mono text-caption-lg leading-4.5">
        <div className="relative min-w-max" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((row) => {
            const l = lines[row.index]!;
            return (
              <div
                key={row.index}
                className={cn(
                  "absolute left-0 right-0 flex whitespace-pre",
                  l.kind === "add" && "bg-diff-add",
                  l.kind === "del" && "bg-diff-del",
                  l.kind === "hunk" && "bg-accent-soft text-accent",
                  l.kind === "meta" && "text-subtle italic",
                )}
                style={{ transform: `translateY(${row.start}px)`, height: 18 }}
              >
                <span className="w-10 shrink-0 select-none pr-1 text-right text-subtle">{l.oldNo ?? ""}</span>
                <span className="w-10 shrink-0 select-none pr-2 text-right text-subtle">{l.newNo ?? ""}</span>
                <span className={cn("w-4 shrink-0 select-none", l.kind === "add" ? "text-success" : l.kind === "del" ? "text-danger" : "text-subtle")}>
                  {l.kind === "add" ? "+" : l.kind === "del" ? "-" : ""}
                </span>
                <span className="pr-4">{l.text}</span>
              </div>
            );
          })}
        </div>
      </div>
      {diff.data?.truncated && <div className="border-t border-border px-3 py-1 text-caption text-subtle">{t.git.diff.truncated}</div>}
    </div>
  );
}

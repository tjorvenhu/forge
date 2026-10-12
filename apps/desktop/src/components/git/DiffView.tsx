import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { X } from "lucide-react";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { ErrorBanner } from "@/components/ui/misc";
import { ListSkeleton } from "@/components/ui/skeleton";

export function DiffView({ projectId, path, staged, onClose }: { projectId: string; path: string; staged: boolean; onClose?: () => void }) {
  const diff = useQuery({ queryKey: keys.diff(projectId, path, staged), queryFn: () => call("git.diff", { projectId, path, staged }) });
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = diff.data?.lines ?? [];
  const v = useVirtualizer({ count: lines.length, getScrollElement: () => scrollRef.current, estimateSize: () => 18, overscan: 30 });

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
        {diff.data && (
          <>
            <span className="text-success">+{diff.data.additions}</span>
            <span className="text-danger">-{diff.data.deletions}</span>
          </>
        )}
        {staged && <span className="text-subtle">vorgemerkt</span>}
        {onClose && (
          <button onClick={onClose} className="rounded p-0.5 text-subtle hover:text-fg" aria-label="Diff schließen">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {diff.isLoading && <ListSkeleton rows={8} />}
      {diff.isError && (
        <div className="p-3">
          <ErrorBanner>{errorMessage(diff.error)}</ErrorBanner>
        </div>
      )}
      {diff.data?.binary && <div className="p-4 text-xs text-muted">Binärdatei oder zu groß für die Anzeige.</div>}
      {diff.data && !diff.data.binary && lines.length === 0 && <div className="p-4 text-xs text-muted">Keine Textänderungen (z. B. nur Dateirechte).</div>}
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
      {diff.data?.truncated && <div className="border-t border-border px-3 py-1 text-caption text-subtle">Anzeige auf 5.000 Zeilen gekürzt.</div>}
    </div>
  );
}

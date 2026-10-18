import { Fragment } from "react";
import { Wrench } from "lucide-react";
import { SEARCH_MARK_END, SEARCH_MARK_START, type SearchHit } from "@forge/protocol";
import { cn, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { ClaudeMark } from "@/components/workspace/ClaudeMark";
import { t } from "@/i18n";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

export const HIT_ROLE_LABEL: Record<SearchHit["role"], string> = { user: t.search.you, assistant: "Claude", tool: t.search.tool };

/** Opens the session of a hit and scrolls to the message. */
export function openSearchHit(hit: SearchHit) {
  const ui = useUi.getState();
  ui.setFocusEvent({ sessionId: hit.sessionId, seq: hit.seq });
  ui.openProject(hit.projectId, hit.sessionId);
}

/** Renders a snippet from the sidecar with the matched words highlighted. */
export function Snippet({ text, className }: { text: string; className?: string }) {
  const parts = text.split(SEARCH_MARK_START);
  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (i === 0) return <Fragment key={i}>{part}</Fragment>;
        const [hit = "", rest = ""] = part.split(SEARCH_MARK_END);
        return (
          <Fragment key={i}>
            <mark className="rounded-sm bg-accent-soft px-0.5 text-fg">{hit}</mark>
            {rest}
          </Fragment>
        );
      })}
    </span>
  );
}

export function SearchHitRow({ hit, active, onSelect }: { hit: SearchHit; active?: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      className={cn("flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left", active ? "bg-surface-3" : "hover:bg-surface-3")}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-surface-3 text-3xs font-semibold text-muted">
        {hit.role === "user" ? t.search.you : hit.role === "tool" ? <Wrench className="h-3 w-3" aria-label={t.search.tool} /> : <ClaudeMark size={13} />}
      </span>
      <span className="min-w-0 flex-1">
        <Snippet text={hit.snippet} className="line-clamp-2 block break-words text-body" />
        <span className="mt-0.5 block truncate text-caption text-subtle">
          {hit.sessionTitle ?? t.search.untitled} · {hit.projectName} · {relativeTime(hit.ts)}
        </span>
      </span>
    </button>
  );
}

/** Full-text hits while the transcripts are searched, in the box the hits will fill. */
export function SearchHitsSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <SkeletonRegion label="Lädt Treffer" className={className}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-2.5 px-2.5 py-2">
          <Skeleton className="mt-0.5 h-5 w-5 shrink-0 rounded" />
          <div className="min-w-0 flex-1">
            <div className="flex h-5 items-center">
              <Skeleton className="h-3 rounded-sm" style={{ width: `${70 + ((i * 13) % 25)}%` }} />
            </div>
            <div className="mt-0.5 flex h-4 items-center">
              <Skeleton className="h-2.5 w-2/5 rounded-sm" />
            </div>
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

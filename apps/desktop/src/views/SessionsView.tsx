import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { History, Power, Search, Trash2 } from "lucide-react";
import type { Session } from "@forge/protocol";
import { call, keys, useLiveSessions, useSearch } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { useModelLabel } from "@/lib/models";
import { useDebouncedValue } from "@/lib/timing-hooks";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBanner, SectionTitle, Spinner, Tooltip } from "@/components/ui/misc";
import { DeleteSessionDialog } from "@/components/workspace/DeleteSessionDialog";
import { DeleteAllSessionsDialog } from "@/components/workspace/DeleteAllSessionsDialog";
import { Select } from "@/components/ui/select";
import { SessionStatusBadge } from "@/components/workspace/SessionStatusBadge";
import { ProfileBadge } from "@/components/projects/ProfileBadge";
import { openSearchHit, SearchHitRow } from "@/components/search/SearchHits";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const sv = t.views.sessions;

const STATUS = [
  { value: "all", label: sv.status.all },
  { value: "running", label: sv.status.running },
  { value: "waiting_approval", label: sv.status.waitingApproval },
  { value: "idle", label: sv.status.idle },
  { value: "stopped", label: sv.status.stopped },
  { value: "interrupted", label: sv.status.interrupted },
  { value: "error", label: sv.status.error },
];

export function SessionsView() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const openProject = useUi((s) => s.openProject);
  const [deleting, setDeleting] = useState<Session | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const modelLabel = useModelLabel();
  // Both lists hit the sidecar (the full-text search reads every transcript); wait until typing pauses.
  const query = useDebouncedValue(q, 250);
  const sessions = useQuery({
    queryKey: keys.allSessions(query, status),
    queryFn: () => call("sessions.listAll", { query: query || undefined, status: status === "all" ? undefined : status }),
    placeholderData: (prev) => prev,
  });
  const hits = useSearch(query);
  // Counted from the live list, not from `sessions`: that one is narrowed by search and status filter.
  const openCount = useLiveSessions().data?.length ?? 0;
  // Unfiltered, so the button stays usable while a search or status filter shows nothing.
  const anySessions = useQuery({ queryKey: keys.allSessions("", "all"), queryFn: () => call("sessions.listAll", {}) });
  const searching = query.trim().length >= 3;

  return (
    <Page
      title={sv.title}
      subtitle={sv.openSessions(openCount)}
      actions={
        <Button variant="danger-ghost" disabled={!anySessions.data?.length} onClick={() => setDeletingAll(true)}>
          <Trash2 className="h-4 w-4" />
          {sv.deleteAll}
        </Button>
      }
    >
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={sv.searchPlaceholder} className="pl-8" aria-label={sv.searchLabel} />
        </div>
        <Select value={status} onChange={setStatus} options={STATUS} className="w-52" aria-label={sv.statusFilter} />
      </div>
      {searching && (
        <section className="mb-6">
          <SectionTitle action={hits.isFetching && !hits.isLoading ? <Spinner className="h-3.5 w-3.5" /> : undefined}>{sv.hitsInTranscripts}</SectionTitle>
          {hits.isError && <ErrorBanner>{sv.searchFailed}</ErrorBanner>}
          {hits.isLoading && <HitsSkeleton />}
          {hits.data && hits.data.length === 0 && <div className="text-body text-muted">{sv.noHits}</div>}
          {!!hits.data?.length && (
            <div className="rounded-xl border border-border bg-surface p-1">
              {hits.data.map((h) => (
                <SearchHitRow key={`${h.sessionId}:${h.seq}`} hit={h} onSelect={() => openSearchHit(h)} />
              ))}
            </div>
          )}
        </section>
      )}
      {searching && <SectionTitle>{sv.title}</SectionTitle>}
      {sessions.isLoading && <SessionsTableSkeleton />}
      {sessions.isError && <ErrorBanner>{sv.loadFailed}</ErrorBanner>}
      {sessions.isSuccess && sessions.data.length === 0 && query && <div className="text-body text-muted">{sv.noMatch}</div>}
      {sessions.isSuccess && sessions.data.length === 0 && !query && (
        <EmptyState icon={<History className="h-10 w-10" />} title={sv.emptyTitle}>
          {sv.emptyHint}
        </EmptyState>
      )}
      {!!sessions.data?.length && (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-body">
            <SessionsTableHead />
            <tbody className="divide-y divide-border">
              {sessions.data.map((s) => (
                <tr key={s.id} className="cursor-pointer bg-surface hover:bg-surface-2" onClick={() => openProject(s.projectId, s.id)}>
                  <td className="max-w-80 px-4 py-2">
                    <button className="block w-full truncate text-left" onClick={() => openProject(s.projectId, s.id)}>
                      {s.title ?? t.views.common.untitled}
                    </button>
                    <div className="truncate font-mono text-2xs text-subtle">{s.claudeSessionId ?? sv.noClaudeId}</div>
                  </td>
                  <td className="px-4 py-2 text-muted">{s.projectName}</td>
                  <td className="px-4 py-2">
                    <SessionStatusBadge status={s.status} live={s.live} autoContinueAt={s.autoContinueAt} />
                  </td>
                  <td className="px-4 py-2">
                    <ProfileBadge profile={s.profile} />
                  </td>
                  <td className="px-4 py-2 text-muted">{s.model ? modelLabel(s.model) : sv.defaultModel}</td>
                  <td className="px-4 py-2 text-muted">{relativeTime(s.updatedAt)}</td>
                  <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-0.5">
                      {s.live && (
                        <Tooltip content={sv.closeTooltip}>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={sv.closeLabel}
                            onClick={() => call("sessions.close", { sessionId: s.id }).catch((e: unknown) => toast.error(sv.closeFailed, errorMessage(e)))}
                          >
                            <Power className="h-3.5 w-3.5" />
                          </Button>
                        </Tooltip>
                      )}
                      <Tooltip content={sv.deleteSession}>
                        <Button size="icon-sm" variant="ghost" aria-label={sv.deleteSession} className="hover:text-danger" onClick={() => setDeleting(s)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </Tooltip>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DeleteSessionDialog session={deleting} onClose={() => setDeleting(null)} />
      <DeleteAllSessionsDialog open={deletingAll} liveCount={openCount} onClose={() => setDeletingAll(false)} />
    </Page>
  );
}

function SessionsTableHead() {
  return (
    <thead className="bg-surface-2 text-left text-xs text-muted">
      <tr>
        <th className="px-4 py-2 font-medium">{sv.columnSession}</th>
        <th className="px-4 py-2 font-medium">{sv.columnProject}</th>
        <th className="px-4 py-2 font-medium">{sv.columnStatus}</th>
        <th className="px-4 py-2 font-medium">{sv.columnProfile}</th>
        <th className="px-4 py-2 font-medium">{sv.columnModel}</th>
        <th className="px-4 py-2 font-medium">{sv.columnUpdated}</th>
        <th className="w-px px-2 py-2">
          <span className="sr-only">{sv.columnActions}</span>
        </th>
      </tr>
    </thead>
  );
}

/** The sessions table with its real header; fixed widths, since percentages collapse in an auto-sized table. */
function SessionsTableSkeleton({ rows = 8 }: { rows?: number }) {
  const line = (widths: string[], r: number, h = "h-3") => <Skeleton className={`${h} rounded-sm ${widths[r % widths.length]}`} />;
  return (
    <SkeletonRegion label={sv.loadingSessions} className="overflow-hidden rounded-xl border border-border">
      <table className="w-full text-body">
        <SessionsTableHead />
        <tbody className="divide-y divide-border">
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r} className="bg-surface">
              <td className="px-4 py-2">
                <div className="flex h-5 items-center">{line(["w-56", "w-40", "w-48", "w-32"], r)}</div>
                <div className="flex h-4 items-center">{line(["w-36", "w-44"], r, "h-2")}</div>
              </td>
              <td className="px-4 py-2">{line(["w-20", "w-28", "w-24"], r)}</td>
              <td className="px-4 py-2">
                <Skeleton className="h-5 w-16 rounded" />
              </td>
              <td className="px-4 py-2">
                <Skeleton className="h-5 w-20 rounded" />
              </td>
              <td className="px-4 py-2">{line(["w-16", "w-20"], r)}</td>
              <td className="px-4 py-2">{line(["w-24", "w-20", "w-16"], r)}</td>
              <td className="px-2 py-1">
                <div className="flex justify-end">
                  <Skeleton className="h-7 w-7" />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SkeletonRegion>
  );
}

/** Full-text hits while the transcripts are searched, in the box the hits will fill. */
function HitsSkeleton() {
  return (
    <SkeletonRegion label={sv.loadingHits} className="rounded-xl border border-border bg-surface p-1">
      {[0, 1, 2].map((i) => (
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

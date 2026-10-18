import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock, Combine, Pause } from "lucide-react";
import type { KnowledgeSummary } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

/** Groups merged at once; each draft is its own Claude process. */
const PARALLEL = 3;

type Status = "waiting" | "running" | "done" | "failed" | "stopped";

interface Group {
  ids: string[];
  reason: string;
  status: Status;
  /** title of the merged entry once it is done */
  title?: string;
  error?: string;
}

const STATUS: Record<Status, { label: string; tone: "neutral" | "accent" | "success" | "danger" }> = {
  waiting: { label: t.knowledge.autoMerge.waiting, tone: "neutral" },
  running: { label: t.knowledge.autoMerge.running, tone: "accent" },
  done: { label: t.knowledge.autoMerge.done, tone: "success" },
  failed: { label: t.knowledge.autoMerge.failed, tone: "danger" },
  stopped: { label: t.knowledge.autoMerge.stopped, tone: "neutral" },
};

/**
 * Tidying up the knowledge without picking anything: Claude decides which entries cover the same topic,
 * then writes and saves one merged entry per group. Closing the dialog lets it go on; "Anhalten" stops
 * before the next group is saved. Old versions stay in Git.
 */
export function AutoMergeDialog({
  owner,
  entries,
  open,
  onClose,
  onManual,
}: {
  owner: string;
  entries: KnowledgeSummary[];
  open: boolean;
  onClose: () => void;
  /** opens the dialog where the user picks entries by hand */
  onManual: () => void;
}) {
  const qc = useQueryClient();
  const [model, setModel] = useState<string | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** results of an older run (closed while planning, started again) are ignored */
  const attempt = useRef(0);
  const stopped = useRef(false);
  const running = useRef(false);
  /** titles stay readable after their entries are gone */
  const titles = useRef(new Map<string, string>());
  for (const e of entries) titles.current.set(e.id, e.title);
  const titleOf = (id: string) => titles.current.get(id) ?? id;

  const update = (i: number, patch: Partial<Group>) => setGroups((cur) => cur && cur.map((g, k) => (k === i ? { ...g, ...patch } : g)));

  const run = async (mine: number, plan: Group[]) => {
    let next = 0;
    let merged = 0;
    let failed = 0;
    const worker = async () => {
      while (next < plan.length && !stopped.current && mine === attempt.current) {
        const i = next++;
        const { ids } = plan[i]!;
        update(i, { status: "running" });
        try {
          const draft = await call("knowledge.mergeDraft", { projectId: owner, ids });
          if (stopped.current || mine !== attempt.current) {
            update(i, { status: "stopped" });
            continue;
          }
          const { entry } = await call("knowledge.merge", { projectId: owner, ids, title: draft.title, summary: draft.summary, tags: draft.tags, content: draft.content });
          qc.setQueryData(keys.knowledgeEntry(owner, entry.id), entry);
          void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
          update(i, { status: "done", title: entry.title });
          merged++;
        } catch (e) {
          update(i, { status: "failed", error: errorMessage(e) });
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, plan.length) }, worker));
    if (mine !== attempt.current) return;
    setGroups((cur) => cur && cur.map((g) => (g.status === "waiting" ? { ...g, status: "stopped" } : g)));
    if (merged) toast.success(t.knowledge.autoMerge.tidied, t.knowledge.autoMerge.tidiedDetail(merged, failed));
    else if (failed) toast.error(t.knowledge.autoMerge.nothingMerged, t.knowledge.autoMerge.nothingMergedDetail(failed));
  };

  const start = async () => {
    const mine = ++attempt.current;
    stopped.current = false;
    running.current = true;
    setBusy(true);
    setModel(null);
    setGroups(null);
    setPlanError(null);
    try {
      const plan = await call("knowledge.mergePlan", { projectId: owner });
      if (mine !== attempt.current) return;
      const list: Group[] = plan.groups.map((g) => ({ ...g, status: "waiting" }));
      setModel(plan.model);
      setGroups(list);
      if (list.length) await run(mine, list);
    } catch (e) {
      if (mine === attempt.current) setPlanError(errorMessage(e));
    } finally {
      if (mine === attempt.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };

  useEffect(() => {
    // Reopened while a run goes on: show it instead of starting a second one.
    if (open && !running.current) void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only opening starts a run
  }, [open]);

  const stop = () => {
    stopped.current = true;
    setGroups((cur) => cur && cur.map((g) => (g.status === "waiting" ? { ...g, status: "stopped" } : g)));
  };

  const close = () => {
    // Nothing to keep while Claude is still looking: a later plan would only start merging unseen.
    if (!groups) {
      attempt.current++;
      running.current = false;
      setBusy(false);
    }
    onClose();
  };

  const done = groups?.filter((g) => g.status === "done").length ?? 0;
  const active = groups?.some((g) => g.status === "waiting" || g.status === "running") ?? false;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && close()}
      title={t.knowledge.autoMerge.title}
      description={
        planError
          ? t.knowledge.autoMerge.planFailed
          : !groups
            ? t.knowledge.autoMerge.reading(entries.length)
            : !groups.length
              ? t.knowledge.autoMerge.noGroups
              : active
                ? t.knowledge.autoMerge.merging
                : t.knowledge.autoMerge.finished(done, groups.length)
      }
      className="w-180"
      footer={
        <>
          {(planError || (groups && !groups.length)) && (
            <Button
              onClick={() => {
                onClose();
                onManual();
              }}
            >
              <Combine className="h-3.5 w-3.5" /> {t.knowledge.autoMerge.pickYourself}
            </Button>
          )}
          {planError && <Button onClick={() => void start()}>{t.knowledge.common.retry}</Button>}
          {active && (
            <Button onClick={stop} disabled={stopped.current}>
              <Pause className="h-3.5 w-3.5" /> {t.knowledge.autoMerge.stop}
            </Button>
          )}
          <Button variant="primary" onClick={close}>
            {busy && !groups ? t.knowledge.common.cancel : t.knowledge.autoMerge.close}
          </Button>
        </>
      }
    >
      {planError ? (
        <ErrorBanner>{planError}</ErrorBanner>
      ) : !groups ? (
        <PlanSkeleton />
      ) : !groups.length ? (
        <p className="text-body text-muted">{t.knowledge.autoMerge.ownTopics}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex max-h-105 flex-col gap-2 overflow-y-auto">
            {groups.map((g, i) => (
              <li key={i} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
                <StatusIcon status={g.status} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-medium">{g.title ?? titleOf(g.ids[0]!)}</div>
                  {g.reason && <p className="text-xs text-muted">{g.reason}</p>}
                  <p className="mt-1 text-xs text-subtle">{t.knowledge.autoMerge.from(g.ids.map((id) => t.knowledge.merge.quoted(titleOf(id))).join(", "))}</p>
                  {g.error && <p className="mt-1 text-xs text-danger">{g.error}</p>}
                </div>
                <Badge tone={STATUS[g.status].tone} className={cn(g.status === "running" && "animate-pulse")}>
                  {STATUS[g.status].label}
                </Badge>
              </li>
            ))}
          </ul>
          {model && <p className="text-caption text-subtle">{t.knowledge.autoMerge.planBy(model)}</p>}
        </div>
      )}
    </Dialog>
  );
}

function StatusIcon({ status }: { status: Status }) {
  const cls = "mt-0.5 h-4 w-4 shrink-0";
  if (status === "done") return <Check className={cn(cls, "text-success")} />;
  if (status === "failed") return <AlertTriangle className={cn(cls, "text-danger")} />;
  if (status === "stopped") return <Pause className={cn(cls, "text-subtle")} />;
  if (status === "running") return <Combine className={cn(cls, "text-accent")} />;
  return <Clock className={cn(cls, "text-subtle")} />;
}

/** The group list while Claude reads the knowledge. */
function PlanSkeleton() {
  return (
    <SkeletonRegion label={t.knowledge.autoMerge.checking} className="flex flex-col gap-2">
      {[70, 55, 62].map((w, i) => (
        <div key={i} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
          <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 rounded-sm" style={{ width: `${w}%` }} />
            <Skeleton className="h-2.5 w-11/12 rounded-sm" />
            <Skeleton className="h-2.5 w-1/2 rounded-sm" />
          </div>
          <Skeleton className="h-5 w-20 shrink-0" />
        </div>
      ))}
      <p className="text-caption text-subtle">{t.knowledge.autoMerge.takesAMinute}</p>
    </SkeletonRegion>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { keepPreviousData, useMutation, useQuery, type UseMutationResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  FolderOpen,
  Gauge,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  History,
  MessageCircleQuestion,
  MessageSquare,
  NotebookText,
  Phone,
  PhoneIncoming,
  PhoneOutgoing,
  RefreshCw,
  ShieldQuestion,
  Timer,
  TimerOff,
  X,
} from "lucide-react";
import { STATS_PAGE_URL, type DailyReport, type DailyReportAgent, type DailyReportCall, type DailyReportCommit, type DailyReportOpen, type DailyReportSession, type ResultOf } from "@forge/protocol";
import { call, keys, useProjects } from "@/lib/queries";
import { openExternal } from "@/lib/native";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { clockTime } from "@/lib/utils";
import { modelLabel } from "@/lib/models";
import { splitProjects } from "@/lib/project-tree";
import { useUi } from "@/stores/ui";
import { useAgentReview } from "@/stores/agent-review";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge, EmptyState, ErrorBanner, SectionTitle, Tooltip } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import type { MenuItem } from "@/components/ui/dropdown";
import { SessionStatusBadge } from "@/components/workspace/SessionStatusBadge";
import { Markdown } from "@/components/workspace/Markdown";
import { dayLabel, dayLong, dayOptions, localDay, shiftDay } from "@/components/report/report-days";
import { UsageCharts, UsageHeadline, UsageSkeleton } from "@/components/report/usage-charts";
import { t } from "@/i18n";

const ICON = "h-3.5 w-3.5";
const ALL = "all";
const rp = t.report;

const AGENT_STATE: Record<DailyReportAgent["state"], { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  running: { label: rp.agentState.running, tone: "accent" },
  done: { label: rp.agentState.done, tone: "warning" },
  waiting: { label: rp.agentState.waiting, tone: "warning" },
  skipped: { label: rp.agentState.skipped, tone: "warning" },
  conflict: { label: rp.agentState.conflict, tone: "accent" },
  merged: { label: rp.agentState.merged, tone: "success" },
  discarded: { label: rp.agentState.discarded, tone: "neutral" },
};

const OPEN_KIND: Record<DailyReportOpen["kind"], { label: string; icon: ReactNode }> = {
  question: { label: rp.openKind.question, icon: <MessageCircleQuestion className={`${ICON} text-warning`} /> },
  plan: { label: rp.openKind.plan, icon: <ClipboardCheck className={`${ICON} text-warning`} /> },
  approval: { label: rp.openKind.approval, icon: <ShieldQuestion className={`${ICON} text-warning`} /> },
  error: { label: rp.openKind.error, icon: <AlertTriangle className={`${ICON} text-danger`} /> },
  autoContinue: { label: rp.openKind.autoContinue, icon: <Timer className={`${ICON} text-muted`} /> },
};

const CALL_RESULT: Record<DailyReportCall["result"], { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  answered: { label: rp.callResult.answered, tone: "success" },
  rejected: { label: rp.callResult.rejected, tone: "neutral" },
  missed: { label: rp.callResult.missed, tone: "warning" },
  failed: { label: rp.callResult.failed, tone: "danger" },
};

/** What happened on a day: sessions, agents, commits, what is open and the phone calls. */
export function ReportView() {
  const projectId = useUi((s) => s.reportProjectId);
  const openReport = useUi((s) => s.openReport);
  const [today, setToday] = useState(() => localDay(new Date()));
  const [date, setDate] = useState(today);
  const projects = useProjects();
  const roots = splitProjects(projects.data ?? []).roots;
  // A worktree's report is its main project's, agents included.
  const scoped = projects.data?.find((p) => p.id === projectId);
  const scopeId = scoped?.parentId ?? projectId;

  // Past midnight "today" moves on; a report that showed today follows it.
  useEffect(() => {
    const timer = setInterval(() => setToday(localDay(new Date())), 60_000);
    return () => clearInterval(timer);
  }, []);
  const [seenToday, setSeenToday] = useState(today);
  if (seenToday !== today) {
    setSeenToday(today);
    if (date === seenToday) setDate(today);
  }

  const report = useQuery({
    queryKey: keys.report(date, scopeId),
    queryFn: () => call("reports.daily", { date, projectId: scopeId ?? undefined }),
    refetchInterval: date === today ? 60_000 : false,
    // Another day or project keeps the old report on screen, dimmed, until the new one is there.
    placeholderData: keepPreviousData,
  });
  const summary = useMutation({ mutationFn: () => call("reports.dailySummary", { date, projectId: scopeId ?? undefined }) });
  const resetSummary = summary.reset;
  useEffect(() => {
    resetSummary();
  }, [date, scopeId, resetSummary]);

  const scopeName = scopeId ? (projects.data?.find((p) => p.id === scopeId)?.name ?? rp.project) : null;
  const r = report.data;
  const hasUsage = !!r && r.usage.days.some((d) => d.workMs > 0 || d.tokens > 0);
  const empty = r && !r.sessions.length && !r.agents.length && !r.commits.length && !r.open.length && !r.calls?.length;

  return (
    <Page
      title={rp.title}
      subtitle={rp.subtitle(dayLong(date), scopeName)}
      actions={
        <>
          <Tooltip content={rp.totalTooltip}>
            {/* A real link, so the right click offers opening and copying it. */}
            <a
              href={STATS_PAGE_URL}
              onClick={(e) => {
                e.preventDefault();
                void openExternal(STATS_PAGE_URL);
              }}
              className={buttonVariants({ variant: "ghost" })}
            >
              <Gauge className="h-4 w-4" />
              {rp.totalLink}
            </a>
          </Tooltip>
          <Tooltip content={rp.reload}>
            <Button size="icon" variant="ghost" aria-label={rp.reloadLabel} onClick={() => void report.refetch()} disabled={report.isFetching}>
              <RefreshCw className={`h-4 w-4 ${report.isFetching && !report.isLoading ? "animate-spin" : ""}`} />
            </Button>
          </Tooltip>
          <Button onClick={() => summary.mutate()} loading={summary.isPending} disabled={!r || !!empty || summary.isPending}>
            <NotebookText className="h-4 w-4" />
            {rp.summarize}
          </Button>
        </>
      }
    >
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Select
          value={scopeId ?? ALL}
          onChange={(v) => openReport(v === ALL ? null : v)}
          options={[{ value: ALL, label: rp.allProjects }, ...roots.map((p) => ({ value: p.id, label: p.name }))]}
          className="w-56"
          aria-label={rp.projectLabel}
        />
        <div className="flex items-center gap-1">
          <Tooltip content={rp.previousDay}>
            <Button size="icon" variant="ghost" aria-label={rp.previousDay} onClick={() => setDate(shiftDay(date, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Tooltip>
          <Select value={date} onChange={setDate} options={dayOptions(today, date)} className="w-40" aria-label={rp.dayLabel} />
          <Tooltip content={rp.nextDay}>
            <Button size="icon" variant="ghost" aria-label={rp.nextDay} disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Tooltip>
          {date !== today && (
            <Button size="sm" variant="ghost" onClick={() => setDate(today)}>
              {rp.today}
            </Button>
          )}
        </div>
      </div>

      {!summary.isIdle && <SummaryCard m={summary} onClose={() => summary.reset()} />}
      {report.isLoading && <ReportSkeleton />}
      {report.isError && <ErrorBanner title={rp.loadError}>{errorMessage(report.error)}</ErrorBanner>}
      {r && (
        <div className={`flex flex-col gap-6 transition-opacity ${report.isPlaceholderData ? "opacity-60" : ""}`} aria-busy={report.isPlaceholderData}>
          {hasUsage && <UsageHeadline u={r.usage} />}
          <Stats r={r} />
          {r.gitErrors.map((e) => (
            <ErrorBanner key={e.projectName} title={rp.gitError(e.projectName)}>
              {e.message}
            </ErrorBanner>
          ))}
          {r.open.length > 0 && <OpenSection items={r.open} refetch={() => void report.refetch()} />}
          {hasUsage && <UsageCharts u={r.usage} date={r.date} today={today} showProjects={!r.projectId} onPickDay={setDate} />}
          {empty ? (
            <EmptyState icon={<CalendarDays className="h-10 w-10" />} title={rp.nothingHappened(dayLabel(date, today))}>
              {rp.nothingDetail(scopeName)}
            </EmptyState>
          ) : (
            <>
              <SessionsSection items={r.sessions} showProject={!r.projectId} />
              <AgentsSection items={r.agents} showProject={!r.projectId} />
              <CommitsSection items={r.commits} showProject={!r.projectId} />
              {r.calls && <CallsSection items={r.calls} />}
            </>
          )}
          {r.truncated && <p className="text-caption text-subtle">{rp.truncated}</p>}
        </div>
      )}
    </Page>
  );
}

function SummaryCard({ m, onClose }: { m: UseMutationResult<ResultOf<"reports.dailySummary">, Error, void>; onClose: () => void }) {
  return (
    <section className="mb-6 rounded-xl border border-border bg-surface p-4" aria-label={rp.summary.label}>
      <div className="mb-2 flex items-center gap-2">
        <NotebookText className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-ui font-medium">{rp.summary.label}</h2>
        <Button size="icon-sm" variant="ghost" aria-label={rp.summary.close} onClick={onClose}>
          <X className={ICON} />
        </Button>
      </div>
      {m.isPending && (
        <>
          <SkeletonRegion label={rp.summary.loading} className="flex flex-col gap-2 py-1">
            {[88, 76, 92, 60].map((w, i) => (
              <Skeleton key={i} className="h-3 rounded-sm" style={{ width: `${w}%` }} />
            ))}
          </SkeletonRegion>
          <p className="mt-3 text-caption text-subtle">{rp.summary.working}</p>
        </>
      )}
      {m.isError && <ErrorBanner>{errorMessage(m.error)}</ErrorBanner>}
      {m.data && (
        <>
          <Markdown text={m.data.summary} />
          <p className="mt-3 text-caption text-subtle">{rp.summary.byline(modelLabel(m.data.model))}</p>
        </>
      )}
    </section>
  );
}

function Stats({ r }: { r: DailyReport }) {
  const turns = r.sessions.reduce((n, s) => n + s.turns, 0);
  const merged = r.agents.filter((a) => a.state === "merged").length;
  const auto = r.commits.filter((c) => c.auto).length;
  const tiles: Array<{ label: string; value: number; sub: string }> = [
    { label: rp.stats.sessions, value: r.sessions.length, sub: rp.turns(turns) },
    { label: rp.stats.agents, value: r.agents.length, sub: rp.stats.mergedCount(merged) },
    { label: rp.stats.commits, value: r.commits.length, sub: rp.stats.autoCommits(auto) },
    { label: rp.stats.open, value: r.open.length, sub: r.open.length ? rp.stats.waitingForYou : rp.stats.nothingOpen },
    ...(r.calls ? [{ label: rp.stats.calls, value: r.calls.length, sub: rp.stats.answeredCount(r.calls.filter((c) => c.result === "answered").length) }] : []),
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="text-caption text-muted">{tile.label}</div>
          <div className="text-display font-semibold tabular-nums">{tile.value}</div>
          <div className="truncate text-caption text-subtle">{tile.sub}</div>
        </div>
      ))}
    </div>
  );
}

function Row({ icon, title, sub, right, onOpen, menu, label }: { icon: ReactNode; title: ReactNode; sub?: ReactNode; right?: ReactNode; onOpen: () => void; menu: () => MenuItem[]; label: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      onContextMenu={contextItems(menu)}
      aria-label={label}
      className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2"
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-fg">{title}</span>
        {sub && <span className="block truncate text-caption text-muted">{sub}</span>}
      </span>
      {right && <span className="flex shrink-0 items-center gap-2 text-caption text-muted tabular-nums">{right}</span>}
    </button>
  );
}

function Section({ title, count, emptyText, children }: { title: string; count: number; emptyText: string; children: ReactNode }) {
  return (
    <section>
      <SectionTitle>
        {title} <span className="tabular-nums">({count})</span>
      </SectionTitle>
      {count ? <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">{children}</div> : <p className="text-body text-muted">{emptyText}</p>}
    </section>
  );
}

/** Where the entries lead; read at the click, like the palette does. */
const open = {
  session: (projectId: string, sessionId: string) => useUi.getState().openProject(projectId, sessionId),
  project: (projectId: string) => useUi.getState().openProject(projectId),
  agents: (rootId: string) => {
    useUi.getState().openProject(rootId);
    useUi.getState().setWorkspaceTab("agents");
  },
  commit: (projectId: string, hash: string) => {
    useUi.getState().openProject(projectId);
    useUi.getState().openCommit(projectId, hash);
  },
  report: (projectId: string) => useUi.getState().openReport(projectId),
};

function OpenSection({ items, refetch }: { items: DailyReportOpen[]; refetch: () => void }) {
  const cancelAutoContinue = (sessionId: string) =>
    call("sessions.cancelAutoContinue", { sessionId })
      .then(refetch)
      .catch((e: unknown) => toast.error(rp.open.cancelFailed, errorMessage(e)));
  return (
    <Section title={rp.open.title} count={items.length} emptyText="">
      {items.map((x) => (
        <Row
          key={`${x.kind}:${x.sessionId}:${x.requestId ?? ""}`}
          label={`${OPEN_KIND[x.kind].label}: ${x.text}`}
          icon={OPEN_KIND[x.kind].icon}
          title={x.text}
          sub={rp.open.sub(OPEN_KIND[x.kind].label, x.sessionTitle ?? rp.untitled, x.projectName)}
          right={x.kind === "autoContinue" ? rp.open.at(clockTime(x.at)) : clockTime(x.at)}
          onOpen={() => open.session(x.projectId, x.sessionId)}
          menu={() => [
            { label: x.kind === "question" || x.kind === "plan" || x.kind === "approval" ? rp.open.answer : rp.openSession, icon: <MessageSquare className={ICON} />, onSelect: () => open.session(x.projectId, x.sessionId) },
            ...(x.kind === "autoContinue" ? [{ label: rp.open.cancelAutoContinue, icon: <TimerOff className={ICON} />, onSelect: () => void cancelAutoContinue(x.sessionId) }] : []),
            { label: rp.openProject, icon: <FolderOpen className={ICON} />, onSelect: () => open.project(x.projectId) },
            { label: rp.open.copyText, icon: <Copy className={ICON} />, onSelect: () => copyText(x.text) },
          ]}
        />
      ))}
    </Section>
  );
}

function SessionsSection({ items, showProject }: { items: DailyReportSession[]; showProject: boolean }) {
  return (
    <Section title={rp.sessions.title} count={items.length} emptyText={rp.sessions.empty}>
      {items.map((s) => (
        <Row
          key={s.id}
          label={rp.sessions.openLabel(s.title ?? rp.untitled)}
          icon={s.agent ? <Bot className={`${ICON} text-muted`} /> : <MessageSquare className={`${ICON} text-muted`} />}
          title={s.title ?? rp.untitled}
          sub={[showProject || s.agent ? s.projectName : "", rp.turns(s.turns), s.errors ? rp.withErrors(s.errors) : ""].filter(Boolean).join(" · ")}
          right={
            <>
              <SessionStatusBadge status={s.status} />
              <span>
                {rp.sessions.timeRange(clockTime(s.firstAt), clockTime(s.lastAt))}
              </span>
            </>
          }
          onOpen={() => open.session(s.projectId, s.id)}
          menu={() => [
            { label: rp.openSession, icon: <MessageSquare className={ICON} />, onSelect: () => open.session(s.projectId, s.id) },
            { label: rp.openProject, icon: <FolderOpen className={ICON} />, onSelect: () => open.project(s.rootId) },
            ...(showProject ? [{ label: rp.sessions.reportForProject, icon: <CalendarDays className={ICON} />, onSelect: () => open.report(s.rootId) }] : []),
            { label: rp.sessions.copyTitle, icon: <Copy className={ICON} />, onSelect: () => copyText(s.title ?? "") },
          ]}
        />
      ))}
    </Section>
  );
}

function AgentsSection({ items, showProject }: { items: DailyReportAgent[]; showProject: boolean }) {
  const review = useAgentReview((s) => s.request);
  const view = (a: DailyReportAgent) => {
    if (a.exists && a.sessionId) open.session(a.worktreeId, a.sessionId);
    else open.agents(a.rootId);
  };
  return (
    <Section title={rp.agents.title} count={items.length} emptyText={rp.agents.empty}>
      {items.map((a) => (
        <Row
          key={a.worktreeId}
          label={rp.agents.viewLabel(a.branch ?? a.title ?? "")}
          icon={a.state === "merged" ? <GitMerge className={`${ICON} text-success`} /> : <Bot className={`${ICON} text-muted`} />}
          title={
            <>
              <span className="font-mono">{a.branch ?? rp.agents.noBranch}</span>
              {a.title && <span className="text-muted"> · {a.title}</span>}
            </>
          }
          sub={[showProject ? a.rootName : "", a.message ?? ""].filter(Boolean).join(" · ") || undefined}
          right={
            <>
              <Badge tone={AGENT_STATE[a.state].tone}>{AGENT_STATE[a.state].label}</Badge>
              <span>{clockTime(a.at)}</span>
            </>
          }
          onOpen={() => view(a)}
          menu={() => [
            ...(a.exists && a.sessionId ? [{ label: rp.agents.openAgentSession, icon: <MessageSquare className={ICON} />, onSelect: () => open.session(a.worktreeId, a.sessionId!) }] : []),
            { label: rp.agents.viewInTab, icon: <Bot className={ICON} />, onSelect: () => open.agents(a.rootId) },
            ...(a.exists && a.state !== "running" ? [{ label: rp.agents.mergeOrDiscard, icon: <GitMerge className={ICON} />, onSelect: () => review(a.worktreeId) }] : []),
            ...(a.parentSessionId ? [{ label: rp.agents.openParentSession, icon: <History className={ICON} />, onSelect: () => open.session(a.rootId, a.parentSessionId!) }] : []),
            ...(a.branch ? [{ label: rp.agents.copyBranch, icon: <GitBranch className={ICON} />, onSelect: () => copyText(a.branch!) }] : []),
          ]}
        />
      ))}
    </Section>
  );
}

function CommitsSection({ items, showProject }: { items: DailyReportCommit[]; showProject: boolean }) {
  return (
    <Section title={rp.commits.title} count={items.length} emptyText={rp.commits.empty}>
      {items.map((c) => (
        <Row
          key={`${c.projectId}:${c.hash}`}
          label={rp.commits.openLabel(c.subject)}
          icon={<GitCommitHorizontal className={`${ICON} text-muted`} />}
          title={c.subject}
          sub={
            <>
              <span className="font-mono">{c.shortHash}</span>
              {showProject && ` · ${c.projectName}`} · {c.author}
            </>
          }
          right={
            <>
              {c.auto && <Badge tone="accent">{rp.commits.autoBadge}</Badge>}
              {c.agentBranch && <Badge>{rp.commits.agentBadge(c.agentBranch)}</Badge>}
              <span>{clockTime(c.date)}</span>
            </>
          }
          onOpen={() => open.commit(c.projectId, c.hash)}
          menu={() => [
            { label: rp.commits.openInGit, icon: <GitCommitHorizontal className={ICON} />, onSelect: () => open.commit(c.projectId, c.hash) },
            ...(c.sessionId ? [{ label: rp.openSession, icon: <MessageSquare className={ICON} />, onSelect: () => open.session(c.projectId, c.sessionId!) }] : []),
            { label: rp.commits.copyHash, icon: <Copy className={ICON} />, onSelect: () => copyText(c.hash) },
            { label: rp.commits.copyMessage, icon: <Copy className={ICON} />, onSelect: () => copyText(c.subject) },
          ]}
        />
      ))}
    </Section>
  );
}

function CallsSection({ items }: { items: DailyReportCall[] }) {
  const openSettings = useUi((s) => s.openSettings);
  return (
    <Section title={rp.calls.title} count={items.length} emptyText={rp.calls.empty}>
      {items.map((c) => (
        <Row
          key={c.id}
          label={rp.calls.label(c.direction === "in", c.number)}
          icon={c.direction === "in" ? <PhoneIncoming className={`${ICON} text-muted`} /> : <PhoneOutgoing className={`${ICON} text-muted`} />}
          title={rp.calls.heading(c.direction === "in", c.number)}
          sub={[c.reason ?? "", c.lines ? rp.calls.linesInCall(c.lines) : ""].filter(Boolean).join(" · ") || undefined}
          right={
            <>
              <Badge tone={CALL_RESULT[c.result].tone}>{CALL_RESULT[c.result].label}</Badge>
              <span>{clockTime(c.startedAt)}</span>
            </>
          }
          onOpen={() => openSettings("phone")}
          menu={() => [
            { label: rp.calls.phoneSettings, icon: <Phone className={ICON} />, onSelect: () => openSettings("phone") },
            { label: rp.calls.copyNumber, icon: <Copy className={ICON} />, onSelect: () => copyText(c.number) },
          ]}
        />
      ))}
    </Section>
  );
}

/** Stat tiles and three list sections, in the shape of the report. */
function ReportSkeleton() {
  return (
    <SkeletonRegion label={rp.skeletonLabel} className="flex flex-col gap-6">
      <UsageSkeleton />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-4 py-3">
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-6 w-8" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        ))}
      </div>
      {[3, 2, 4].map((rows, s) => (
        <div key={s}>
          <Skeleton className="mb-2 h-3 w-24" />
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
                <Skeleton className="h-7 w-7 shrink-0 rounded-md" />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <Skeleton className="h-3 rounded-sm" style={{ width: `${45 + ((i * 17 + s * 11) % 35)}%` }} />
                  <Skeleton className="h-2.5 w-1/4 rounded-sm" />
                </div>
                <Skeleton className="h-5 w-16 rounded" />
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

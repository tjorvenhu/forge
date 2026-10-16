import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, type UseMutationResult } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Copy,
  FolderOpen,
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
import type { DailyReport, DailyReportAgent, DailyReportCall, DailyReportCommit, DailyReportOpen, DailyReportSession, ResultOf } from "@forge/protocol";
import { call, keys, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { clockTime } from "@/lib/utils";
import { modelLabel } from "@/lib/models";
import { splitProjects } from "@/lib/project-tree";
import { useUi } from "@/stores/ui";
import { useAgentReview } from "@/stores/agent-review";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Badge, EmptyState, ErrorBanner, SectionTitle, Tooltip } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import type { MenuItem } from "@/components/ui/dropdown";
import { SessionStatusBadge } from "@/components/workspace/SessionStatusBadge";
import { Markdown } from "@/components/workspace/Markdown";
import { dayLabel, dayLong, dayOptions, localDay, shiftDay } from "@/components/report/report-days";

const ICON = "h-3.5 w-3.5";
const ALL = "all";

const AGENT_STATE: Record<DailyReportAgent["state"], { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  running: { label: "Arbeitet", tone: "accent" },
  done: { label: "Fertig, nicht zusammengeführt", tone: "warning" },
  waiting: { label: "Wartet aufs Zusammenführen", tone: "warning" },
  skipped: { label: "Entscheidung nötig", tone: "warning" },
  conflict: { label: "Löst Konflikte", tone: "accent" },
  merged: { label: "Zusammengeführt", tone: "success" },
  discarded: { label: "Verworfen", tone: "neutral" },
};

const OPEN_KIND: Record<DailyReportOpen["kind"], { label: string; icon: ReactNode }> = {
  question: { label: "Rückfrage", icon: <MessageCircleQuestion className={`${ICON} text-warning`} /> },
  plan: { label: "Plan zur Freigabe", icon: <ClipboardCheck className={`${ICON} text-warning`} /> },
  approval: { label: "Freigabe", icon: <ShieldQuestion className={`${ICON} text-warning`} /> },
  error: { label: "Fehler", icon: <AlertTriangle className={`${ICON} text-danger`} /> },
  autoContinue: { label: "Weiter nach Nutzungslimit", icon: <Timer className={`${ICON} text-muted`} /> },
};

const CALL_RESULT: Record<DailyReportCall["result"], { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  answered: { label: "Angenommen", tone: "success" },
  rejected: { label: "Abgelehnt", tone: "neutral" },
  missed: { label: "Verpasst", tone: "warning" },
  failed: { label: "Fehlgeschlagen", tone: "danger" },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

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
    const t = setInterval(() => setToday(localDay(new Date())), 60_000);
    return () => clearInterval(t);
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
  });
  const summary = useMutation({ mutationFn: () => call("reports.dailySummary", { date, projectId: scopeId ?? undefined }) });
  const resetSummary = summary.reset;
  useEffect(() => {
    resetSummary();
  }, [date, scopeId, resetSummary]);

  const scopeName = scopeId ? (projects.data?.find((p) => p.id === scopeId)?.name ?? "Projekt") : null;
  const r = report.data;
  const empty = r && !r.sessions.length && !r.agents.length && !r.commits.length && !r.open.length && !r.calls?.length;

  return (
    <Page
      title="Tagesbericht"
      subtitle={`${dayLong(date)}${scopeName ? `, ${scopeName}` : ", alle Projekte"}`}
      actions={
        <>
          <Tooltip content="Neu laden">
            <Button size="icon" variant="ghost" aria-label="Bericht neu laden" onClick={() => void report.refetch()} disabled={report.isFetching}>
              <RefreshCw className={`h-4 w-4 ${report.isFetching && !report.isLoading ? "animate-spin" : ""}`} />
            </Button>
          </Tooltip>
          <Button onClick={() => summary.mutate()} loading={summary.isPending} disabled={!r || !!empty || summary.isPending}>
            <NotebookText className="h-4 w-4" />
            Zusammenfassen
          </Button>
        </>
      }
    >
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <Select
          value={scopeId ?? ALL}
          onChange={(v) => openReport(v === ALL ? null : v)}
          options={[{ value: ALL, label: "Alle Projekte" }, ...roots.map((p) => ({ value: p.id, label: p.name }))]}
          className="w-56"
          aria-label="Projekt"
        />
        <div className="flex items-center gap-1">
          <Tooltip content="Vorheriger Tag">
            <Button size="icon" variant="ghost" aria-label="Vorheriger Tag" onClick={() => setDate(shiftDay(date, -1))}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Tooltip>
          <Select value={date} onChange={setDate} options={dayOptions(today, date)} className="w-40" aria-label="Tag" />
          <Tooltip content="Nächster Tag">
            <Button size="icon" variant="ghost" aria-label="Nächster Tag" disabled={date >= today} onClick={() => setDate(shiftDay(date, 1))}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Tooltip>
          {date !== today && (
            <Button size="sm" variant="ghost" onClick={() => setDate(today)}>
              Heute
            </Button>
          )}
        </div>
      </div>

      {!summary.isIdle && <SummaryCard m={summary} onClose={() => summary.reset()} />}
      {report.isLoading && <ReportSkeleton />}
      {report.isError && <ErrorBanner title="Bericht konnte nicht geladen werden">{errorMessage(report.error)}</ErrorBanner>}
      {r && (
        <div className="flex flex-col gap-6">
          <Stats r={r} />
          {r.gitErrors.map((e) => (
            <ErrorBanner key={e.projectName} title={`Commits von ${e.projectName} nicht lesbar`}>
              {e.message}
            </ErrorBanner>
          ))}
          {r.open.length > 0 && <OpenSection items={r.open} refetch={() => void report.refetch()} />}
          {empty ? (
            <EmptyState icon={<CalendarDays className="h-10 w-10" />} title={`${dayLabel(date, today)} ist nichts passiert`}>
              Keine Sessions, Agenten, Commits oder Anrufe{scopeName ? ` in ${scopeName}` : ""}.
            </EmptyState>
          ) : (
            <>
              <SessionsSection items={r.sessions} showProject={!r.projectId} />
              <AgentsSection items={r.agents} showProject={!r.projectId} />
              <CommitsSection items={r.commits} showProject={!r.projectId} />
              {r.calls && <CallsSection items={r.calls} />}
            </>
          )}
          {r.truncated && <p className="text-caption text-subtle">Gekürzt: An diesem Tag gab es mehr Sessions oder Commits, als hier stehen.</p>}
        </div>
      )}
    </Page>
  );
}

function SummaryCard({ m, onClose }: { m: UseMutationResult<ResultOf<"reports.dailySummary">, Error, void>; onClose: () => void }) {
  return (
    <section className="mb-6 rounded-xl border border-border bg-surface p-4" aria-label="Zusammenfassung">
      <div className="mb-2 flex items-center gap-2">
        <NotebookText className="h-4 w-4 text-accent" />
        <h2 className="flex-1 text-ui font-medium">Zusammenfassung</h2>
        <Button size="icon-sm" variant="ghost" aria-label="Zusammenfassung schließen" onClick={onClose}>
          <X className={ICON} />
        </Button>
      </div>
      {m.isPending && (
        <>
          <SkeletonRegion label="Lädt Zusammenfassung" className="flex flex-col gap-2 py-1">
            {[88, 76, 92, 60].map((w, i) => (
              <Skeleton key={i} className="h-3 rounded-sm" style={{ width: `${w}%` }} />
            ))}
          </SkeletonRegion>
          <p className="mt-3 text-caption text-subtle">Claude fasst den Tag zusammen …</p>
        </>
      )}
      {m.isError && <ErrorBanner>{errorMessage(m.error)}</ErrorBanner>}
      {m.data && (
        <>
          <Markdown text={m.data.summary} />
          <p className="mt-3 text-caption text-subtle">Von Claude ({modelLabel(m.data.model)}) aus den Fakten dieses Berichts erstellt.</p>
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
    { label: "Sessions", value: r.sessions.length, sub: plural(turns, "Durchlauf", "Durchläufe") },
    { label: "Agenten", value: r.agents.length, sub: `${merged} zusammengeführt` },
    { label: "Commits", value: r.commits.length, sub: plural(auto, "Auto-Commit", "Auto-Commits") },
    { label: "Offen", value: r.open.length, sub: r.open.length ? "wartet auf dich" : "nichts offen" },
    ...(r.calls ? [{ label: "Anrufe", value: r.calls.length, sub: `${r.calls.filter((c) => c.result === "answered").length} angenommen` }] : []),
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-border bg-surface px-4 py-3">
          <div className="text-caption text-muted">{t.label}</div>
          <div className="text-display font-semibold tabular-nums">{t.value}</div>
          <div className="truncate text-caption text-subtle">{t.sub}</div>
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
      .catch((e: unknown) => toast.error("Nicht abgebrochen", errorMessage(e)));
  return (
    <Section title="Jetzt offen" count={items.length} emptyText="">
      {items.map((x) => (
        <Row
          key={`${x.kind}:${x.sessionId}:${x.requestId ?? ""}`}
          label={`${OPEN_KIND[x.kind].label}: ${x.text}`}
          icon={OPEN_KIND[x.kind].icon}
          title={x.text}
          sub={`${OPEN_KIND[x.kind].label} in ${x.sessionTitle ?? "Ohne Titel"} · ${x.projectName}`}
          right={x.kind === "autoContinue" ? `um ${clockTime(x.at)}` : clockTime(x.at)}
          onOpen={() => open.session(x.projectId, x.sessionId)}
          menu={() => [
            { label: x.kind === "question" || x.kind === "plan" || x.kind === "approval" ? "Beantworten" : "Session öffnen", icon: <MessageSquare className={ICON} />, onSelect: () => open.session(x.projectId, x.sessionId) },
            ...(x.kind === "autoContinue" ? [{ label: "Automatisches Weitermachen abbrechen", icon: <TimerOff className={ICON} />, onSelect: () => void cancelAutoContinue(x.sessionId) }] : []),
            { label: "Projekt öffnen", icon: <FolderOpen className={ICON} />, onSelect: () => open.project(x.projectId) },
            { label: "Text kopieren", icon: <Copy className={ICON} />, onSelect: () => copyText(x.text) },
          ]}
        />
      ))}
    </Section>
  );
}

function SessionsSection({ items, showProject }: { items: DailyReportSession[]; showProject: boolean }) {
  return (
    <Section title="Sessions" count={items.length} emptyText="Keine Session hat an diesem Tag gearbeitet.">
      {items.map((s) => (
        <Row
          key={s.id}
          label={`Session ${s.title ?? "Ohne Titel"} öffnen`}
          icon={s.agent ? <Bot className={`${ICON} text-muted`} /> : <MessageSquare className={`${ICON} text-muted`} />}
          title={s.title ?? "Ohne Titel"}
          sub={[showProject || s.agent ? s.projectName : "", plural(s.turns, "Durchlauf", "Durchläufe"), s.errors ? plural(s.errors, "mit Fehler", "mit Fehler") : ""].filter(Boolean).join(" · ")}
          right={
            <>
              <SessionStatusBadge status={s.status} />
              <span>
                {clockTime(s.firstAt)} bis {clockTime(s.lastAt)}
              </span>
            </>
          }
          onOpen={() => open.session(s.projectId, s.id)}
          menu={() => [
            { label: "Session öffnen", icon: <MessageSquare className={ICON} />, onSelect: () => open.session(s.projectId, s.id) },
            { label: "Projekt öffnen", icon: <FolderOpen className={ICON} />, onSelect: () => open.project(s.rootId) },
            ...(showProject ? [{ label: "Tagesbericht für dieses Projekt", icon: <CalendarDays className={ICON} />, onSelect: () => open.report(s.rootId) }] : []),
            { label: "Titel kopieren", icon: <Copy className={ICON} />, onSelect: () => copyText(s.title ?? "") },
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
    <Section title="Parallele Agenten" count={items.length} emptyText="Keine Agenten an diesem Tag.">
      {items.map((a) => (
        <Row
          key={a.worktreeId}
          label={`Agent ${a.branch ?? a.title ?? ""} ansehen`}
          icon={a.state === "merged" ? <GitMerge className={`${ICON} text-success`} /> : <Bot className={`${ICON} text-muted`} />}
          title={
            <>
              <span className="font-mono">{a.branch ?? "ohne Branch"}</span>
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
            ...(a.exists && a.sessionId ? [{ label: "Session des Agenten öffnen", icon: <MessageSquare className={ICON} />, onSelect: () => open.session(a.worktreeId, a.sessionId!) }] : []),
            { label: "Im Agenten-Reiter ansehen", icon: <Bot className={ICON} />, onSelect: () => open.agents(a.rootId) },
            ...(a.exists && a.state !== "running" ? [{ label: "Zusammenführen oder verwerfen", icon: <GitMerge className={ICON} />, onSelect: () => review(a.worktreeId) }] : []),
            ...(a.parentSessionId ? [{ label: "Startende Session öffnen", icon: <History className={ICON} />, onSelect: () => open.session(a.rootId, a.parentSessionId!) }] : []),
            ...(a.branch ? [{ label: "Branch kopieren", icon: <GitBranch className={ICON} />, onSelect: () => copyText(a.branch!) }] : []),
          ]}
        />
      ))}
    </Section>
  );
}

function CommitsSection({ items, showProject }: { items: DailyReportCommit[]; showProject: boolean }) {
  return (
    <Section title="Commits" count={items.length} emptyText="Keine Commits an diesem Tag.">
      {items.map((c) => (
        <Row
          key={`${c.projectId}:${c.hash}`}
          label={`Commit ${c.subject} im Git-Reiter öffnen`}
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
              {c.auto && <Badge tone="accent">Auto-Commit</Badge>}
              {c.agentBranch && <Badge>Agent {c.agentBranch}</Badge>}
              <span>{clockTime(c.date)}</span>
            </>
          }
          onOpen={() => open.commit(c.projectId, c.hash)}
          menu={() => [
            { label: "Im Git-Reiter öffnen", icon: <GitCommitHorizontal className={ICON} />, onSelect: () => open.commit(c.projectId, c.hash) },
            ...(c.sessionId ? [{ label: "Session öffnen", icon: <MessageSquare className={ICON} />, onSelect: () => open.session(c.projectId, c.sessionId!) }] : []),
            { label: "Hash kopieren", icon: <Copy className={ICON} />, onSelect: () => copyText(c.hash) },
            { label: "Nachricht kopieren", icon: <Copy className={ICON} />, onSelect: () => copyText(c.subject) },
          ]}
        />
      ))}
    </Section>
  );
}

function CallsSection({ items }: { items: DailyReportCall[] }) {
  const openSettings = useUi((s) => s.openSettings);
  return (
    <Section title="Anrufe" count={items.length} emptyText="Keine Anrufe an diesem Tag.">
      {items.map((c) => (
        <Row
          key={c.id}
          label={`Anruf ${c.direction === "in" ? "von" : "an"} ${c.number}`}
          icon={c.direction === "in" ? <PhoneIncoming className={`${ICON} text-muted`} /> : <PhoneOutgoing className={`${ICON} text-muted`} />}
          title={`${c.direction === "in" ? "Eingehend von" : "Ausgehend an"} ${c.number}`}
          sub={[c.reason ?? "", c.lines ? plural(c.lines, "Zeile im Gespräch", "Zeilen im Gespräch") : ""].filter(Boolean).join(" · ") || undefined}
          right={
            <>
              <Badge tone={CALL_RESULT[c.result].tone}>{CALL_RESULT[c.result].label}</Badge>
              <span>{clockTime(c.startedAt)}</span>
            </>
          }
          onOpen={() => openSettings("phone")}
          menu={() => [
            { label: "Telefon-Einstellungen", icon: <Phone className={ICON} />, onSelect: () => openSettings("phone") },
            { label: "Nummer kopieren", icon: <Copy className={ICON} />, onSelect: () => copyText(c.number) },
          ]}
        />
      ))}
    </Section>
  );
}

/** Stat tiles and three list sections, in the shape of the report. */
function ReportSkeleton() {
  return (
    <SkeletonRegion label="Lädt Tagesbericht" className="flex flex-col gap-6">
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

import type { ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, Database, Download, ExternalLink, FolderOpen, GitPullRequestArrow, Phone, Play, RotateCcw, Server, ShieldQuestion, Sparkles, SquareTerminal } from "lucide-react";
import type { ResultOf } from "@forge/protocol";
import { call, keys, useAppUpdate, useClaudeSetup, useDiagnostics, useLiveSessions, usePhoneState, useProjects } from "@/lib/queries";
import { useModelLabel } from "@/lib/models";
import { openExternal } from "@/lib/native";
import { clockTime, cn, relativeTime } from "@/lib/utils";
import { useActivity } from "@/stores/activity";
import { useUi } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, ErrorBanner, SectionTitle, Spinner } from "@/components/ui/misc";
import { SessionStatusBadge } from "@/components/workspace/SessionStatusBadge";
import { SummaryButton } from "@/components/workspace/SummaryButton";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

type LiveSession = ResultOf<"sessions.listLive">[number];
type Tone = "accent" | "warning" | "success" | "danger";

const ICON_TONE: Record<Tone, string> = { accent: "text-accent", warning: "text-warning", success: "text-success", danger: "text-danger" };
const WORKING = new Set(["starting", "running", "stopping"]);
const h = t.views.home;

/**
 * Start page as a status page: what runs right now (call, sessions, pushes, dev servers, test
 * databases, updates), what waits for the user, and the sessions to continue. Projects have their
 * own page.
 */
export function HomeView() {
  const projects = useProjects();
  const setNewProject = useUi((s) => s.setNewProject);
  const openReport = useUi((s) => s.openReport);
  const none = projects.isSuccess && projects.data.length === 0;

  return (
    <Page
      title={h.title}
      subtitle={h.subtitle}
      actions={
        <Button variant="ghost" onClick={() => openReport(null)}>
          <CalendarDays className="h-4 w-4" />
          {h.dailyReport}
        </Button>
      }
    >
      <ApiKeyWarning />
      {projects.isLoading && (
        <SkeletonRegion label={h.loadingHome} className="flex flex-col gap-8">
          <StatusGroupSkeleton rows={2} />
          <StatusGroupSkeleton title={h.recentlyEdited} rows={3} lead="badge" />
        </SkeletonRegion>
      )}
      {projects.isError && <ErrorBanner>{t.views.common.projectsLoadFailed}</ErrorBanner>}
      {none && (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title={t.views.common.noProjectsYet}
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setNewProject("import")}>
                {h.importFolder}
              </Button>
              <Button onClick={() => setNewProject("create")}>{h.newProject}</Button>
              <Button onClick={() => setNewProject("clone")}>{h.cloneRepo}</Button>
            </div>
          }
        >
          {h.noProjectsHint}
        </EmptyState>
      )}
      {projects.isSuccess && !none && (
        <div className="flex flex-col gap-8">
          <RunningNow />
          <ResumeSection />
        </div>
      )}
    </Page>
  );
}

function RunningNow() {
  const projects = useProjects().data ?? [];
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const openProject = useUi((s) => s.openProject);
  const openDevTools = useUi((s) => s.openDevTools);
  const label = useModelLabel();
  const phoneQuery = usePhoneState();
  const liveQuery = useLiveSessions();
  const appUpdateQuery = useAppUpdate();
  const setupQuery = useClaudeSetup();
  const phone = phoneQuery.data;
  const live = liveQuery.data ?? [];
  const ops = useActivity((s) => s.ops);
  const appUpdate = appUpdateQuery.data;
  const setup = setupQuery.data;
  const existing = projects.filter((p) => p.exists);
  const devServers = useQueries({
    queries: existing.map((p) => ({ queryKey: keys.devServer(p.id), queryFn: () => call("devserver.state", { projectId: p.id }), staleTime: 30_000 })),
  });
  const testDbs = useQueries({
    queries: existing.filter((p) => !p.parentId).map((p) => ({ queryKey: keys.testDb(p.id), queryFn: () => call("testdb.state", { projectId: p.id }), staleTime: Infinity })),
  });

  const waiting = live.filter((s) => s.status === "waiting_approval");
  const working = live.filter((s) => WORKING.has(s.status));
  const servers = devServers.map((q) => q.data).filter((d) => d?.status === "running");
  const dbs = testDbs.map((q) => q.data).filter((d) => d && d.status !== "stopped" && d.status !== "failed");
  const call_ = phone?.call ?? null;
  const updating = appUpdate?.phase === "downloading" || appUpdate?.phase === "ready" || setup?.phase === "running";

  const devTools = (projectId: string, section: "server" | "database") => {
    openProject(projectId);
    openDevTools(section);
  };
  const sessionRow = (s: LiveSession, tone: Tone, icon: ReactNode) => (
    <StatusRow
      key={s.id}
      icon={icon}
      tone={tone}
      pulse={tone === "accent"}
      title={s.title ?? t.views.common.untitled}
      detail={`${s.projectName}${s.model ? ` · ${label(s.model)}` : ""}`}
      badge={<SessionStatusBadge status={s.status} live={s.live} autoContinueAt={s.autoContinueAt} />}
      action={
        <Button size="sm" variant={tone === "warning" ? "primary" : "ghost"} onClick={() => openProject(s.projectId, s.id)}>
          <Play className="h-3.5 w-3.5" /> {t.views.common.open}
        </Button>
      }
    />
  );

  const empty = !call_ && !waiting.length && !working.length && !ops.length && !servers.length && !dbs.length && !updating;
  const loading = [phoneQuery, liveQuery, appUpdateQuery, setupQuery, ...devServers, ...testDbs].some((q) => q.isLoading);
  if (empty && loading)
    return (
      <SkeletonRegion label={h.loadingRunning}>
        <StatusGroupSkeleton rows={2} />
      </SkeletonRegion>
    );
  if (empty)
    return (
      <div className="rounded-xl border border-border bg-surface">
        <EmptyState icon={<CheckCircle2 className="h-8 w-8 text-success" />} title={h.nothingRunning}>
          {h.nothingRunningHint}
        </EmptyState>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      {call_ && (
        <StatusGroup title={h.phone}>
          <StatusRow
            icon={<Phone className="h-4 w-4" />}
            tone="accent"
            pulse
            title={call_.state === "ringing" ? (call_.direction === "in" ? h.callFrom(call_.number) : h.callingTo(call_.number)) : call_.direction === "in" ? h.callWith(call_.number) : h.callTo(call_.number)}
            detail={[call_.state === "active" ? h.since(clockTime(call_.startedAt)) : h.ringing, call_.reason, call_.unlocked ? h.controlUnlocked : null].filter(Boolean).join(" · ")}
          />
        </StatusGroup>
      )}
      {waiting.length > 0 && <StatusGroup title={h.waitingForYou}>{waiting.map((s) => sessionRow(s, "warning", <ShieldQuestion className="h-4 w-4" />))}</StatusGroup>}
      {working.length > 0 && <StatusGroup title={h.sessionsWorking}>{working.map((s) => sessionRow(s, "accent", <Sparkles className="h-4 w-4" />))}</StatusGroup>}
      {ops.length > 0 && (
        <StatusGroup title="Git">
          {ops.map((o) => (
            <StatusRow
              key={o.id}
              icon={<GitPullRequestArrow className="h-4 w-4" />}
              tone="accent"
              pulse
              title={h.gitRunning(o.label)}
              detail={`${names.get(o.projectId) ?? t.views.common.project} · ${h.since(clockTime(o.startedAt))}`}
              badge={<Spinner className="text-accent" />}
            />
          ))}
        </StatusGroup>
      )}
      {(servers.length > 0 || dbs.length > 0) && (
        <StatusGroup title={h.devEnvironment}>
          {servers.map((d) => (
            <StatusRow
              key={`s${d!.projectId}`}
              icon={<Server className="h-4 w-4" />}
              tone="success"
              title={h.devServer(names.get(d!.projectId) ?? t.views.common.project)}
              detail={[d!.url, d!.startedAt ? h.since(clockTime(d!.startedAt)) : null].filter(Boolean).join(" · ")}
              action={
                <>
                  {d!.url && (
                    <Button size="sm" variant="ghost" onClick={() => void openExternal(d!.url!)} title={h.openInBrowser(d!.url)}>
                      <ExternalLink className="h-3.5 w-3.5" /> {t.views.common.open}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => devTools(d!.projectId, "server")}>
                    <SquareTerminal className="h-3.5 w-3.5" /> {h.output}
                  </Button>
                </>
              }
            />
          ))}
          {dbs.map((d) => (
            <StatusRow
              key={`d${d!.projectId}`}
              icon={<Database className="h-4 w-4" />}
              tone={d!.status === "running" ? "success" : "accent"}
              pulse={d!.status !== "running"}
              title={h.testDatabase(names.get(d!.projectId) ?? t.views.common.project)}
              detail={d!.status === "running" ? `PostgreSQL ${d!.version}${d!.startedAt ? ` · ${h.since(clockTime(d!.startedAt))}` : ""}` : d!.status === "installing" ? h.dbDownloading : d!.status === "starting" ? h.dbStarting : h.dbStopping}
              action={
                <Button size="sm" variant="ghost" onClick={() => devTools(d!.projectId, "database")}>
                  {h.devTools}
                </Button>
              }
            />
          ))}
        </StatusGroup>
      )}
      {updating && (
        <StatusGroup title={h.updates}>
          {setup?.phase === "running" && (
            <StatusRow
              icon={<Download className="h-4 w-4" />}
              tone="accent"
              pulse
              title={setup.task === "install" ? h.installingClaude : setup.task === "update" ? h.updatingClaude : h.signingInClaude}
              detail={setup.message ?? ""}
            />
          )}
          {appUpdate?.phase === "downloading" && <StatusRow icon={<Download className="h-4 w-4" />} tone="accent" pulse title={h.appDownloading(appUpdate.latest?.version ?? "")} detail="" />}
          {appUpdate?.phase === "ready" && <StatusRow icon={<Download className="h-4 w-4" />} tone="success" title={h.appReady(appUpdate.latest?.version ?? "")} detail={h.appReadyDetail} />}
        </StatusGroup>
      )}
    </div>
  );
}

function StatusGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <SectionTitle>{title}</SectionTitle>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">{children}</div>
    </section>
  );
}

function StatusRow({ icon, tone, pulse, title, detail, badge, action }: { icon: ReactNode; tone: Tone; pulse?: boolean; title: string; detail: string; badge?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={cn("flex shrink-0", ICON_TONE[tone], pulse && "animate-soft-pulse")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body">{title}</div>
        {detail && <div className="truncate text-caption text-subtle">{detail}</div>}
      </div>
      {badge}
      {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
    </div>
  );
}

/** A StatusGroup in its loaded size; `lead` is the status icon of running things or the badge of resumable sessions. */
function StatusGroupSkeleton({ title, rows, lead = "icon" }: { title?: string; rows: number; lead?: "icon" | "badge" }) {
  return (
    <section>
      {title ? (
        <SectionTitle>{title}</SectionTitle>
      ) : (
        <div className="mb-2 flex h-4 items-center">
          <Skeleton className="h-2.5 w-28 rounded-sm" />
        </div>
      )}
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-2.5">
            {lead === "icon" ? <Skeleton className="h-4 w-4 shrink-0 rounded-sm" /> : <Skeleton className="h-5 w-16 shrink-0 rounded" />}
            <div className="min-w-0 flex-1">
              <div className="flex h-5 items-center">
                <Skeleton className="h-3 rounded-sm" style={{ width: `${40 + ((i * 23) % 30)}%` }} />
              </div>
              <div className="flex h-4 items-center">
                <Skeleton className="h-2.5 rounded-sm" style={{ width: `${25 + ((i * 17) % 20)}%` }} />
              </div>
            </div>
            {lead === "badge" && <Skeleton className="h-7 w-7 shrink-0" />}
            <Skeleton className="h-7 w-20 shrink-0" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** Sessions to pick up again: the latest ones that do not run right now. */
function ResumeSection() {
  const label = useModelLabel();
  const openProject = useUi((s) => s.openProject);
  const sessions = useQuery({ queryKey: keys.allSessions("", "all"), queryFn: () => call("sessions.listAll", {}) });
  const items = (sessions.data ?? []).filter((s) => !WORKING.has(s.status) && s.status !== "waiting_approval").slice(0, 5);
  if (sessions.isLoading)
    return (
      <SkeletonRegion label={h.loadingResume}>
        <StatusGroupSkeleton title={h.recentlyEdited} rows={3} lead="badge" />
      </SkeletonRegion>
    );
  if (!items.length) return null;
  return (
    <section>
      <SectionTitle>{h.recentlyEdited}</SectionTitle>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {items.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
            <SessionStatusBadge status={s.status} live={s.live} autoContinueAt={s.autoContinueAt} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body">{s.title ?? t.views.common.untitled}</div>
              <div className="text-caption text-subtle">
                {s.projectName} · {relativeTime(s.updatedAt)}
                {s.model ? ` · ${label(s.model)}` : ""}
              </div>
            </div>
            <SummaryButton sessionId={s.id} title={s.title} size="icon-sm" />
            <Button size="sm" variant="ghost" onClick={() => openProject(s.projectId, s.id)}>
              {s.live ? <Play className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {s.live ? t.views.common.open : h.resume}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function LoginButton() {
  const openClaudeLogin = useUi((s) => s.openClaudeLogin);
  return (
    <Button size="sm" variant="primary" onClick={() => openClaudeLogin("manual")}>
      {h.signIn}
    </Button>
  );
}

function SetupButton() {
  const openSettings = useUi((s) => s.openSettings);
  return (
    <Button size="sm" variant="primary" onClick={() => openSettings("claude")}>
      {h.setUp}
    </Button>
  );
}

function ApiKeyWarning() {
  const d = useDiagnostics().data;
  const setup = useClaudeSetup().data;
  if (!d) return null;
  if (!d.claude.found && setup?.task === "install" && setup.phase === "running")
    return (
      <div className="mb-5 flex items-center gap-2.5 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2.5 text-body">
        <Spinner className="text-accent" />
        {h.claudeInstalling}
      </div>
    );
  const notLoggedIn = d.claude.found && d.auth.checked && !d.auth.loggedIn;
  const keyActive = d.apiKeyEnvPresent && !d.apiKeyStripped;
  if (!d.claude.found)
    return (
      <div className="mb-5">
        <ErrorBanner title={h.claudeMissingTitle} action={<SetupButton />}>
          {h.claudeMissingHint}
        </ErrorBanner>
      </div>
    );
  if (notLoggedIn)
    return (
      <div className="mb-5">
        <ErrorBanner title={h.notSignedInTitle} action={<LoginButton />}>
          {h.notSignedInHint}
        </ErrorBanner>
      </div>
    );
  if (keyActive)
    return (
      <div className="mb-5 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
        <Badge tone="warning">{h.note}</Badge>
        {h.apiKeyActive}
      </div>
    );
  return null;
}

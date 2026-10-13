import type { ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Database, Download, ExternalLink, FolderOpen, GitPullRequestArrow, Phone, Play, RotateCcw, Server, ShieldQuestion, Sparkles, SquareTerminal } from "lucide-react";
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
import { ListSkeleton } from "@/components/ui/skeleton";

type LiveSession = ResultOf<"sessions.listLive">[number];
type Tone = "accent" | "warning" | "success" | "danger";

const ICON_TONE: Record<Tone, string> = { accent: "text-accent", warning: "text-warning", success: "text-success", danger: "text-danger" };
const WORKING = new Set(["starting", "running", "stopping"]);

/**
 * Start page as a status page: what runs right now (call, sessions, pushes, dev servers, test
 * databases, updates), what waits for the user, and the sessions to continue. Projects have their
 * own page.
 */
export function HomeView() {
  const projects = useProjects();
  const setNewProject = useUi((s) => s.setNewProject);
  const none = projects.isSuccess && projects.data.length === 0;

  return (
    <Page title="Start" subtitle="Was gerade läuft und was auf dich wartet">
      <ApiKeyWarning />
      {projects.isLoading && <ListSkeleton rows={4} />}
      {projects.isError && <ErrorBanner>Projekte konnten nicht geladen werden.</ErrorBanner>}
      {none && (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="Noch keine Projekte"
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setNewProject("import")}>
                Ordner importieren
              </Button>
              <Button onClick={() => setNewProject("create")}>Neues Projekt</Button>
              <Button onClick={() => setNewProject("clone")}>Repository klonen</Button>
            </div>
          }
        >
          Importiere einen bestehenden Projektordner oder lege ein neues Projekt an. FORGE startet Claude Code dann direkt im Projekt.
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
  const phone = usePhoneState().data;
  const live = useLiveSessions().data ?? [];
  const ops = useActivity((s) => s.ops);
  const appUpdate = useAppUpdate().data;
  const setup = useClaudeSetup().data;
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
      title={s.title ?? "Ohne Titel"}
      detail={`${s.projectName}${s.model ? ` · ${label(s.model)}` : ""}`}
      badge={<SessionStatusBadge status={s.status} live={s.live} autoContinueAt={s.autoContinueAt} />}
      action={
        <Button size="sm" variant={tone === "warning" ? "primary" : "ghost"} onClick={() => openProject(s.projectId, s.id)}>
          <Play className="h-3.5 w-3.5" /> Öffnen
        </Button>
      }
    />
  );

  const empty = !call_ && !waiting.length && !working.length && !ops.length && !servers.length && !dbs.length && !updating;
  if (empty)
    return (
      <div className="rounded-xl border border-border bg-surface">
        <EmptyState icon={<CheckCircle2 className="h-8 w-8 text-success" />} title="Gerade läuft nichts">
          Telefonate, arbeitende Sessions, Pushes, Dev-Server und Test-Datenbanken erscheinen hier, sobald sie laufen.
        </EmptyState>
      </div>
    );

  return (
    <div className="flex flex-col gap-6">
      {call_ && (
        <StatusGroup title="Telefon">
          <StatusRow
            icon={<Phone className="h-4 w-4" />}
            tone="accent"
            pulse
            title={call_.state === "ringing" ? (call_.direction === "in" ? `Anruf von ${call_.number}` : `Ruft ${call_.number} an`) : `Telefonat ${call_.direction === "in" ? "mit" : "an"} ${call_.number}`}
            detail={[call_.state === "active" ? `seit ${clockTime(call_.startedAt)}` : "klingelt", call_.reason, call_.unlocked ? "Steuern freigegeben" : null].filter(Boolean).join(" · ")}
          />
        </StatusGroup>
      )}
      {waiting.length > 0 && <StatusGroup title="Wartet auf dich">{waiting.map((s) => sessionRow(s, "warning", <ShieldQuestion className="h-4 w-4" />))}</StatusGroup>}
      {working.length > 0 && <StatusGroup title="Sessions bei der Arbeit">{working.map((s) => sessionRow(s, "accent", <Sparkles className="h-4 w-4" />))}</StatusGroup>}
      {ops.length > 0 && (
        <StatusGroup title="Git">
          {ops.map((o) => (
            <StatusRow
              key={o.id}
              icon={<GitPullRequestArrow className="h-4 w-4" />}
              tone="accent"
              pulse
              title={`${o.label} läuft`}
              detail={`${names.get(o.projectId) ?? "Projekt"} · seit ${clockTime(o.startedAt)}`}
              badge={<Spinner className="text-accent" />}
            />
          ))}
        </StatusGroup>
      )}
      {(servers.length > 0 || dbs.length > 0) && (
        <StatusGroup title="Dev-Umgebung">
          {servers.map((d) => (
            <StatusRow
              key={`s${d!.projectId}`}
              icon={<Server className="h-4 w-4" />}
              tone="success"
              title={`Dev-Server: ${names.get(d!.projectId) ?? "Projekt"}`}
              detail={[d!.url, d!.startedAt ? `seit ${clockTime(d!.startedAt)}` : null].filter(Boolean).join(" · ")}
              action={
                <>
                  {d!.url && (
                    <Button size="sm" variant="ghost" onClick={() => void openExternal(d!.url!)} title={`${d!.url} im Browser öffnen`}>
                      <ExternalLink className="h-3.5 w-3.5" /> Öffnen
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => devTools(d!.projectId, "server")}>
                    <SquareTerminal className="h-3.5 w-3.5" /> Ausgabe
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
              title={`Test-Datenbank: ${names.get(d!.projectId) ?? "Projekt"}`}
              detail={d!.status === "running" ? `PostgreSQL ${d!.version}${d!.startedAt ? ` · seit ${clockTime(d!.startedAt)}` : ""}` : d!.status === "installing" ? "wird geladen" : d!.status === "starting" ? "startet" : "stoppt"}
              action={
                <Button size="sm" variant="ghost" onClick={() => devTools(d!.projectId, "database")}>
                  Dev-Tools
                </Button>
              }
            />
          ))}
        </StatusGroup>
      )}
      {updating && (
        <StatusGroup title="Updates">
          {setup?.phase === "running" && (
            <StatusRow
              icon={<Download className="h-4 w-4" />}
              tone="accent"
              pulse
              title={setup.task === "install" ? "Claude Code wird installiert" : setup.task === "update" ? "Claude Code wird aktualisiert" : "Anmeldung bei Claude läuft"}
              detail={setup.message ?? ""}
            />
          )}
          {appUpdate?.phase === "downloading" && <StatusRow icon={<Download className="h-4 w-4" />} tone="accent" pulse title={`FORGE ${appUpdate.latest?.version ?? ""} wird geladen`} detail="" />}
          {appUpdate?.phase === "ready" && <StatusRow icon={<Download className="h-4 w-4" />} tone="success" title={`FORGE ${appUpdate.latest?.version ?? ""} ist bereit`} detail="Wird beim nächsten Neustart installiert" />}
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

/** Sessions to pick up again: the latest ones that do not run right now. */
function ResumeSection() {
  const label = useModelLabel();
  const openProject = useUi((s) => s.openProject);
  const sessions = useQuery({ queryKey: keys.allSessions("", "all"), queryFn: () => call("sessions.listAll", {}) });
  const items = (sessions.data ?? []).filter((s) => !WORKING.has(s.status) && s.status !== "waiting_approval").slice(0, 5);
  if (!items.length) return null;
  return (
    <section>
      <SectionTitle>Zuletzt bearbeitet</SectionTitle>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {items.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
            <SessionStatusBadge status={s.status} live={s.live} autoContinueAt={s.autoContinueAt} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body">{s.title ?? "Ohne Titel"}</div>
              <div className="text-caption text-subtle">
                {s.projectName} · {relativeTime(s.updatedAt)}
                {s.model ? ` · ${label(s.model)}` : ""}
              </div>
            </div>
            <SummaryButton sessionId={s.id} title={s.title} size="icon-sm" />
            <Button size="sm" variant="ghost" onClick={() => openProject(s.projectId, s.id)}>
              {s.live ? <Play className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {s.live ? "Öffnen" : "Fortsetzen"}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function SetupButton() {
  const openSettings = useUi((s) => s.openSettings);
  return (
    <Button size="sm" variant="primary" onClick={() => openSettings("claude")}>
      Einrichten
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
        Claude Code wird installiert. Danach meldest du dich unter Einstellungen mit deinem Claude-Konto an.
      </div>
    );
  const notLoggedIn = d.claude.found && d.auth.checked && !d.auth.loggedIn;
  const keyActive = d.apiKeyEnvPresent && !d.apiKeyStripped;
  if (!d.claude.found)
    return (
      <div className="mb-5">
        <ErrorBanner title="Claude Code ist noch nicht installiert" action={<SetupButton />}>
          FORGE richtet Claude Code mit einem Klick ein. Danach meldest du dich mit deinem Claude-Konto an.
        </ErrorBanner>
      </div>
    );
  if (notLoggedIn)
    return (
      <div className="mb-5">
        <ErrorBanner title="Claude Code ist nicht angemeldet" action={<SetupButton />}>
          Melde dich mit deinem Claude-Konto an, um Sessions zu starten.
        </ErrorBanner>
      </div>
    );
  if (keyActive)
    return (
      <div className="mb-5 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
        <Badge tone="warning">Hinweis</Badge>
        ANTHROPIC_API_KEY ist gesetzt und wird an Sessions weitergegeben. Das kann API-Kosten statt Abo-Nutzung auslösen.
      </div>
    );
  return null;
}

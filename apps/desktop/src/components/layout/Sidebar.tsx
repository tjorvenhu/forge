import { Download, Plus } from "lucide-react";
import { call, useClaudeSetup, useClaudeUpdate, useDiagnostics, useLiveSessions, useProjects, useUsage } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { useUi, type View } from "@/stores/ui";
import { cn, planLabel, relativeTime } from "@/lib/utils";
import { Logo } from "./Logo";
import { AppUpdateCard } from "./AppUpdate";
import { splitProjects } from "@/lib/project-tree";
import { NAV } from "./nav";
import { OpenSessions } from "./OpenSessions";
import { ErrorBoundary } from "./ErrorBoundary";

export function Sidebar() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const setNewProject = useUi((s) => s.setNewProject);
  const projects = useProjects();
  const liveCount = useLiveSessions().data?.length ?? 0;
  // Agents (worktrees) belong to their project and are not counted on their own.
  const list = splitProjects(projects.data ?? []).roots;
  const activeProjectId = useUi((s) => s.activeProjectId);
  const hasOpen = liveCount > 0 || (view === "workspace" && activeProjectId !== null);
  const counts: Partial<Record<View, { n: number; label: string }>> = {
    projects: { n: list.length, label: list.length === 1 ? "1 Projekt" : `${list.length} Projekte` },
    sessions: { n: liveCount, label: liveCount === 1 ? "1 offene Session" : `${liveCount} offene Sessions` },
  };

  return (
    <aside className="flex w-64 shrink-0 select-none flex-col border-r border-border bg-sidebar">
      <div className="flex items-center px-5 pb-5 pt-5">
        <Logo height={44} />
      </div>

      <div className="mx-4 border-t border-border" />

      <nav className="flex flex-col gap-1 px-3 pt-3" aria-label="Hauptnavigation">
        {NAV.map((n) => {
          const active = view === n.view || (n.view === "projects" && view === "workspace");
          const count = counts[n.view];
          const badge = count && count.n > 0 ? count : null;
          return (
            <button
              key={n.view}
              onClick={() => setView(n.view)}
              aria-current={active ? "page" : undefined}
              title={badge?.label}
              className={cn(
                // Same weight active or not: a bolder label would make the text jump.
                "flex h-10 items-center gap-3 rounded-lg px-3 text-ui transition-[color,background-color,transform] duration-120 active:scale-[0.98]",
                active ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <span className={active ? "text-accent" : ""}>
                <n.Icon className="h-4.5 w-4.5" />
              </span>
              <span className="flex-1 text-left">{n.label}</span>
              {badge && (
                <span className={cn("rounded-md px-2 py-0.5 text-caption tabular-nums", active ? "bg-accent/25 text-fg" : "bg-surface-3 text-muted")}>{badge.n}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mx-4 mt-3 border-t border-border" />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="text-body text-muted">Geöffnet</span>
          <Button size="icon-sm" variant="ghost" onClick={() => setNewProject("import")} className="h-6 w-6 text-subtle hover:bg-surface-2" aria-label="Projekt hinzufügen" title="Projekt hinzufügen">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ErrorBoundary>
          <OpenSessions />
        </ErrorBoundary>
        {!hasOpen && (
          <>
            <p className="px-3 pb-2 text-small text-subtle">Kein Projekt geöffnet. Wähle eins auf der Startseite oder unter Projekte.</p>
            <Button
              variant="outline"
              onClick={() => setNewProject("import")}
              className="h-11 w-full justify-start gap-2.5 rounded-lg border-dashed px-3 text-body-lg font-normal text-muted hover:border-border-strong hover:bg-transparent hover:text-fg"
            >
              <Plus className="h-4 w-4" /> Projekt hinzufügen
            </Button>
          </>
        )}
      </div>

      <ClaudeStatusCard />
    </aside>
  );
}

function ClaudeStatusCard() {
  const diag = useDiagnostics();
  const setup = useClaudeSetup().data;
  const usage = useUsage();
  const openSettings = useUi((s) => s.openSettings);
  const d = diag.data;
  let tone = "bg-subtle";
  let line = "Prüfe Status …";
  if (d) {
    if (!d.claude.found && setup?.task === "install" && setup.phase === "running") {
      tone = "bg-warning animate-soft-pulse";
      line = "Wird installiert …";
    } else if (!d.claude.found) {
      tone = "bg-danger";
      line = "CLI nicht gefunden";
    } else if (!d.auth.loggedIn) {
      tone = "bg-danger";
      line = "Nicht angemeldet";
    } else {
      tone = d.apiKeyEnvPresent && !d.apiKeyStripped ? "bg-warning" : "bg-success";
      line = planLabel(d.auth) ?? d.auth.authMethod ?? "angemeldet";
    }
  } else if (diag.isError) {
    tone = "bg-danger";
    line = "Status unbekannt";
  }
  const windows = usage.data?.available ? usage.data.windows.slice(0, 3) : [];
  return (
    <>
    <AppUpdateCard />
    <div className="m-3 flex flex-col gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 hover:border-border-strong">
      <button onClick={() => openSettings("claude")} className="flex flex-col gap-2 text-left" title="Claude-Code-Status, Nutzung und Diagnose">
        <div className="flex w-full items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <div className="text-body">Claude Code</div>
            <div className="flex items-center gap-1.5 text-caption text-muted">
              <span className={cn("h-1.5 w-1.5 rounded-full", tone)} />
              {line}
            </div>
          </div>
          <span className="text-caption text-subtle">{d?.claude.version?.split(" ")[0] ?? ""}</span>
        </div>
        {windows.length > 0 && (
          <div className="flex w-full flex-col gap-1.5" aria-label="Nutzung des Abos">
            {windows.map((w) => (
              <UsageBar key={w.key} label={w.label} value={w.utilization} resetsAt={w.resetsAt} />
            ))}
          </div>
        )}
      </button>
      <ClaudeUpdateButton />
    </div>
    </>
  );
}

function ClaudeUpdateButton() {
  const update = useClaudeUpdate();
  const setup = useClaudeSetup();
  const updating = setup.data?.task === "update" && setup.data.phase === "running";
  const info = update.data;
  if (!updating && !info?.available) return null;
  return (
    <Button
      size="sm"
      variant="primary"
      className="w-full"
      loading={updating}
      disabled={setup.data?.phase === "running"}
      title={info ? `Installiert: ${info.installed ?? "unbekannt"}, verfügbar: ${info.latest} (Kanal ${info.channel})` : undefined}
      onClick={() => call("claude.update", {}).catch((e: unknown) => toast.error("Update nicht gestartet", errorMessage(e)))}
    >
      {updating ? "Wird aktualisiert …" : (
        <>
          <Download className="h-3.5 w-3.5" /> Update auf {info?.latest}
        </>
      )}
    </Button>
  );
}

/** Tooltip of a usage bar; the stored reset time can already lie in the past until the next update. */
export function resetText(resetsAt: string, now = Date.now()): string {
  const at = new Date(resetsAt).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const when = relativeTime(resetsAt, now);
  if (new Date(resetsAt).getTime() <= now) return `Wurde ${when} zurückgesetzt (${at})`;
  return `Wird ${when === "gerade eben" ? "gleich" : when} zurückgesetzt (${at})`;
}

function UsageBar({ label, value, resetsAt }: { label: string; value: number; resetsAt: string | null }) {
  const tone = value >= 95 ? "bg-danger" : value >= 80 ? "bg-warning" : "bg-accent";
  const width = Math.min(100, Math.max(0, value));
  const reset = resetsAt ? resetText(resetsAt) : undefined;
  return (
    <div title={reset}>
      <div className="mb-0.5 flex justify-between text-caption">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums text-subtle">{value} %</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={width} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

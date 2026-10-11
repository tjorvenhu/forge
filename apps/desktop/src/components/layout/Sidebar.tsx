import { Download, Plus } from "lucide-react";
import { call, useClaudeSetup, useClaudeUpdate, useDiagnostics, useProjects, useUsage } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { useUi } from "@/stores/ui";
import { capitalize, cn, relativeTime } from "@/lib/utils";
import { Logo } from "./Logo";
import { NAV } from "./nav";
import { ProjectIcon } from "@/components/projects/ProjectIcon";

export function Sidebar() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const openProject = useUi((s) => s.openProject);
  const setNewProject = useUi((s) => s.setNewProject);
  const projects = useProjects();
  const list = projects.data ?? [];
  const favorites = list.filter((p) => p.favorite);
  const shown = favorites.length ? favorites : list.slice(0, 4);

  return (
    <aside className="flex w-64 shrink-0 select-none flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-3 px-5 pb-5 pt-5">
        <Logo size={38} />
        <div className="leading-tight">
          <div className="text-title font-bold tracking-wide">FORGE</div>
          <div className="text-caption-lg text-muted">Claude Development Studio</div>
        </div>
      </div>

      <div className="mx-4 border-t border-border" />

      <nav className="flex flex-col gap-1 px-3 pt-3" aria-label="Hauptnavigation">
        {NAV.map((n) => {
          const active = view === n.view || (n.view === "projects" && view === "workspace");
          return (
            <button
              key={n.view}
              onClick={() => setView(n.view)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-10 items-center gap-3 rounded-lg px-3 text-ui transition-colors",
                active ? "bg-accent-soft font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <span className={active ? "text-accent" : ""}>
                <n.Icon className="h-4.5 w-4.5" />
              </span>
              <span className="flex-1 text-left">{n.label}</span>
              {n.view === "projects" && list.length > 0 && (
                <span className={cn("rounded-md px-2 py-0.5 text-caption tabular-nums", active ? "bg-accent/25 text-fg" : "bg-surface-3 text-muted")}>{list.length}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mx-4 mt-3 border-t border-border" />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="text-body text-muted">{favorites.length ? "Favoriten" : "Zuletzt"}</span>
          <Button size="icon-sm" variant="ghost" onClick={() => setNewProject("import")} className="h-6 w-6 text-subtle hover:bg-surface-2" aria-label="Projekt hinzufügen" title="Projekt hinzufügen">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          {shown.map((p) => (
            <button
              key={p.id}
              onClick={() => openProject(p.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                view === "workspace" && activeProjectId === p.id ? "bg-surface-3" : "hover:bg-surface-2",
              )}
            >
              <ProjectIcon name={p.name} size={34} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui">{p.name}</div>
                <div className="truncate text-small text-subtle">{p.technologies.slice(0, 2).join(" · ") || "Projekt"}</div>
              </div>
            </button>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={() => setNewProject("import")}
          className="mt-2 h-11 w-full justify-start gap-2.5 rounded-lg border-dashed px-3 text-body-lg font-normal text-muted hover:border-border-strong hover:bg-transparent hover:text-fg"
        >
          <Plus className="h-4 w-4" /> Projekt hinzufügen
        </Button>
      </div>

      <ClaudeStatusCard />
    </aside>
  );
}

function ClaudeStatusCard() {
  const diag = useDiagnostics();
  const usage = useUsage();
  const setView = useUi((s) => s.setView);
  const d = diag.data;
  let tone = "bg-subtle";
  let line = "Prüfe Status …";
  if (d) {
    if (!d.claude.found) {
      tone = "bg-danger";
      line = "CLI nicht gefunden";
    } else if (!d.auth.loggedIn) {
      tone = "bg-danger";
      line = "Nicht angemeldet";
    } else {
      tone = d.apiKeyEnvPresent && !d.apiKeyStripped ? "bg-warning" : "bg-success";
      line = d.auth.subscriptionType ? `${capitalize(d.auth.subscriptionType)} Abo` : (d.auth.authMethod ?? "angemeldet");
    }
  } else if (diag.isError) {
    tone = "bg-danger";
    line = "Status unbekannt";
  }
  const windows = usage.data?.available ? usage.data.windows.slice(0, 3) : [];
  return (
    <div className="m-3 flex flex-col gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 hover:border-border-strong">
      <button onClick={() => setView("settings")} className="flex flex-col gap-2 text-left" title="Claude-Code-Status, Nutzung und Diagnose">
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

function UsageBar({ label, value, resetsAt }: { label: string; value: number; resetsAt: string | null }) {
  const tone = value >= 95 ? "bg-danger" : value >= 80 ? "bg-warning" : "bg-accent";
  const width = Math.min(100, Math.max(0, value));
  const reset = resetsAt ? `Zurückgesetzt ${relativeTime(resetsAt)} (${new Date(resetsAt).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" })})` : undefined;
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


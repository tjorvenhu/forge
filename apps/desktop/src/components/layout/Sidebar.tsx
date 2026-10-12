import { Download, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { call, useClaudeSetup, useClaudeUpdate, useDiagnostics, useLiveSessions, useProjects, useUsage } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ClaudeMark } from "@/components/workspace/ClaudeMark";
import { useUi, type View } from "@/stores/ui";
import { capitalize, cn, relativeTime } from "@/lib/utils";
import { useArrivals } from "@/lib/arrivals";
import { Logo } from "./Logo";
import { AppUpdateCard } from "./AppUpdate";
import { splitProjects } from "@/lib/project-tree";
import { NAV } from "./nav";
import { ProjectIcon } from "@/components/projects/ProjectIcon";

export function Sidebar() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const openProject = useUi((s) => s.openProject);
  const setNewProject = useUi((s) => s.setNewProject);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const projects = useProjects();
  const liveCount = useLiveSessions().data?.length ?? 0;
  // Agents (worktrees) belong to their project and are not counted or listed on their own.
  const list = splitProjects(projects.data ?? []).roots;
  const favorites = list.filter((p) => p.favorite);
  const shown = favorites.length ? favorites : list.slice(0, 4);
  // Projects added while FORGE runs slide in; the list on start does not.
  const isNew = useArrivals(projects.data?.map((p) => p.id));
  const counts: Partial<Record<View, { n: number; label: string }>> = {
    projects: { n: list.length, label: list.length === 1 ? "1 Projekt" : `${list.length} Projekte` },
    sessions: { n: liveCount, label: liveCount === 1 ? "1 offene Session" : `${liveCount} offene Sessions` },
  };
  const toggleLabel = collapsed ? "Seitenleiste ausklappen (Strg+B)" : "Seitenleiste einklappen (Strg+B)";

  return (
    <aside className={cn("flex shrink-0 select-none flex-col border-r border-border bg-sidebar", collapsed ? "w-16" : "w-64")}>
      <div className={cn("flex items-center pb-5 pt-5", collapsed ? "justify-center px-3" : "justify-between gap-2 pl-5 pr-3")}>
        {!collapsed && <Logo height={38} />}
        <Button size="icon" variant="ghost" onClick={() => toggleSidebar()} className="shrink-0 text-subtle hover:bg-surface-2 hover:text-fg" aria-label={toggleLabel} aria-expanded={!collapsed} title={toggleLabel}>
          {collapsed ? <PanelLeftOpen className="h-4.5 w-4.5" /> : <PanelLeftClose className="h-4.5 w-4.5" />}
        </Button>
      </div>

      <div className={cn("border-t border-border", collapsed ? "mx-3" : "mx-4")} />

      <nav className={cn("flex flex-col gap-1 pt-3", collapsed ? "items-center px-3" : "px-3")} aria-label="Hauptnavigation">
        {NAV.map((n) => {
          const active = view === n.view || (n.view === "projects" && view === "workspace");
          const count = counts[n.view];
          const badge = count && count.n > 0 ? count : null;
          return (
            <button
              key={n.view}
              onClick={() => setView(n.view)}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? (badge ? `${n.label}, ${badge.label}` : n.label) : undefined}
              title={collapsed ? (badge ? `${n.label}: ${badge.label}` : n.label) : badge?.label}
              className={cn(
                // Same weight active or not: a bolder label would make the text jump.
                "relative flex h-10 items-center rounded-lg text-ui transition-[color,background-color,transform] duration-120 active:scale-[0.98]",
                collapsed ? "w-10 justify-center" : "gap-3 px-3",
                active ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <span className={active ? "text-accent" : ""}>
                <n.Icon className="h-4.5 w-4.5" />
              </span>
              {!collapsed && <span className="flex-1 text-left">{n.label}</span>}
              {badge &&
                (collapsed ? (
                  <span className={cn("absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-center text-3xs leading-4 tabular-nums", active ? "bg-accent text-accent-fg" : "bg-surface-3 text-fg")}>{badge.n}</span>
                ) : (
                  <span className={cn("rounded-md px-2 py-0.5 text-caption tabular-nums", active ? "bg-accent/25 text-fg" : "bg-surface-3 text-muted")}>{badge.n}</span>
                ))}
            </button>
          );
        })}
      </nav>

      <div className={cn("mt-3 border-t border-border", collapsed ? "mx-3" : "mx-4")} />

      <div className={cn("min-h-0 flex-1 overflow-y-auto pt-3", collapsed ? "flex flex-col items-center gap-1 px-3" : "px-3")}>
        {collapsed ? (
          <>
            {shown.map((p) => (
              <button
                key={p.id}
                onClick={() => openProject(p.id)}
                title={p.name}
                aria-label={p.name}
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg transition-[background-color,transform] duration-120 active:scale-[0.97]",
                  isNew(p.id) && "animate-slide-up-in",
                  view === "workspace" && activeProjectId === p.id ? "bg-surface-3" : "hover:bg-surface-2",
                )}
              >
                <ProjectIcon name={p.name} size={30} />
              </button>
            ))}
            <Button size="icon" variant="ghost" onClick={() => setNewProject("import")} className="h-10 w-10 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Projekt hinzufügen" title="Projekt hinzufügen">
              <Plus className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
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
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-[background-color,transform] duration-120 active:scale-[0.99]",
                    isNew(p.id) && "animate-slide-up-in",
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
          </>
        )}
      </div>

      <ClaudeStatusCard compact={collapsed} />
    </aside>
  );
}

function ClaudeStatusCard({ compact }: { compact: boolean }) {
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
      line = d.auth.subscriptionType ? `${capitalize(d.auth.subscriptionType)} Abo` : (d.auth.authMethod ?? "angemeldet");
    }
  } else if (diag.isError) {
    tone = "bg-danger";
    line = "Status unbekannt";
  }
  const windows = usage.data?.available ? usage.data.windows.slice(0, 3) : [];
  if (compact) {
    const title = [`Claude Code: ${line}`, ...windows.map((w) => `${w.label}: ${w.utilization} %`)].join("\n");
    return (
      <>
        <AppUpdateCard compact />
        <button
          onClick={() => openSettings("claude")}
          className="relative mx-auto my-3 flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-surface hover:border-border-strong"
          title={title}
          aria-label={title}
        >
          <ClaudeMark size={18} />
          <span className={cn("absolute bottom-1.5 right-1.5 h-1.5 w-1.5 rounded-full", tone)} />
        </button>
      </>
    );
  }
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


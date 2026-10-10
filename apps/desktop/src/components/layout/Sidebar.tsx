import type { ReactNode } from "react";
import { Blocks, Bot, FolderKanban, GitPullRequest, History, Home, Plus, Settings } from "lucide-react";
import { useDiagnostics, useProjects, useUsage } from "@/lib/queries";
import { useUi, type View } from "@/stores/ui";
import { capitalize, cn, relativeTime } from "@/lib/utils";
import { Logo } from "./Logo";
import { ProjectIcon } from "@/components/projects/ProjectIcon";

const NAV: Array<{ view: View; label: string; icon: ReactNode }> = [
  { view: "home", label: "Home", icon: <Home className="h-4 w-4" /> },
  { view: "projects", label: "Projekte", icon: <FolderKanban className="h-4 w-4" /> },
  { view: "sessions", label: "Sessions", icon: <History className="h-4 w-4" /> },
  { view: "github", label: "GitHub", icon: <GitPullRequest className="h-4 w-4" /> },
  { view: "agents", label: "Agenten", icon: <Bot className="h-4 w-4" /> },
  { view: "mcp", label: "Erweiterungen", icon: <Blocks className="h-4 w-4" /> },
  { view: "settings", label: "Einstellungen", icon: <Settings className="h-4 w-4" /> },
];

export function Sidebar() {
  const { view, setView, activeProjectId, openProject, setNewProject } = useUi();
  const projects = useProjects();
  const list = projects.data ?? [];
  const favorites = list.filter((p) => p.favorite);
  const shown = favorites.length ? favorites : list.slice(0, 4);

  return (
    <aside className="flex w-60 shrink-0 select-none flex-col border-r border-border bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-4">
        <Logo />
        <div className="leading-tight">
          <div className="text-[15px] font-bold tracking-wide">FORGE</div>
          <div className="text-[11px] text-subtle">Claude Development Studio</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2" aria-label="Hauptnavigation">
        {NAV.map((n) => {
          const active = view === n.view || (n.view === "projects" && view === "workspace");
          return (
            <button
              key={n.view}
              onClick={() => setView(n.view)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors",
                active ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-3 hover:text-fg",
              )}
            >
              <span className={active ? "text-accent" : ""}>{n.icon}</span>
              <span className="flex-1 text-left">{n.label}</span>
              {n.view === "projects" && list.length > 0 && <span className="rounded bg-surface-3 px-1.5 text-[11px] text-muted">{list.length}</span>}
            </button>
          );
        })}
      </nav>

      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2">
        <div className="px-2.5 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">{favorites.length ? "Favoriten" : "Zuletzt"}</div>
        {shown.map((p) => (
          <button
            key={p.id}
            onClick={() => openProject(p.id)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
              view === "workspace" && activeProjectId === p.id ? "bg-surface-3" : "hover:bg-surface-3",
            )}
          >
            <ProjectIcon name={p.name} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{p.name}</div>
              <div className="truncate text-[11px] text-subtle">{p.technologies.slice(0, 2).join(" · ") || "Projekt"}</div>
            </div>
          </button>
        ))}
        <button
          onClick={() => setNewProject("import")}
          className="mt-1 flex w-full items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-[13px] text-muted hover:border-border-strong hover:text-fg"
        >
          <Plus className="h-4 w-4" /> Projekt hinzufügen
        </button>
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
    <button
      onClick={() => setView("settings")}
      className="m-2 flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-left hover:border-border-strong"
      title="Claude-Code-Status, Nutzung und Diagnose"
    >
      <div className="flex w-full items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">Claude Code</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className={cn("h-1.5 w-1.5 rounded-full", tone)} />
            {line}
          </div>
        </div>
        <span className="text-[11px] text-subtle">{d?.claude.version?.split(" ")[0] ?? ""}</span>
      </div>
      {windows.length > 0 && (
        <div className="flex w-full flex-col gap-1.5" aria-label="Nutzung des Abos">
          {windows.map((w) => (
            <UsageBar key={w.key} label={w.label} value={w.utilization} resetsAt={w.resetsAt} />
          ))}
        </div>
      )}
    </button>
  );
}

function UsageBar({ label, value, resetsAt }: { label: string; value: number; resetsAt: string | null }) {
  const tone = value >= 95 ? "bg-danger" : value >= 80 ? "bg-warning" : "bg-accent";
  const reset = resetsAt ? `Zurückgesetzt ${relativeTime(resetsAt)} (${new Date(resetsAt).toLocaleString("de-DE", { weekday: "short", hour: "2-digit", minute: "2-digit" })})` : undefined;
  return (
    <div title={reset}>
      <div className="mb-0.5 flex justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums text-subtle">{value} %</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}


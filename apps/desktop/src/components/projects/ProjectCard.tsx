import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, GitBranch, Globe, MoreHorizontal, Star, Trash2 } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime, shortPath, cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { DropdownMenu } from "@/components/ui/dropdown";
import { ProjectIcon } from "./ProjectIcon";
import { ProfileBadge } from "./ProfileBadge";
import { agentBusy, agentLabel } from "@/lib/project-tree";

export function ProjectCard({ p, agents = [], onRemove }: { p: ProjectWithStatus; agents?: ProjectWithStatus[]; onRemove: (p: ProjectWithStatus) => void }) {
  const openProject = useUi((s) => s.openProject);
  const qc = useQueryClient();

  const toggleFavorite = async () => {
    try {
      await call("projects.update", { projectId: p.id, favorite: !p.favorite });
      await qc.invalidateQueries({ queryKey: keys.projects });
    } catch (e) {
      toast.error("Favorit konnte nicht gespeichert werden", errorMessage(e));
    }
  };

  return (
    <div className={cn("group flex flex-col rounded-xl border border-border bg-surface transition-colors hover:border-border-strong", !p.exists && "opacity-70")}>
      <button className="flex items-start gap-3 p-4 text-left" onClick={() => openProject(p.id)} aria-label={`${p.name} öffnen`}>
        <ProjectIcon name={p.name} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{p.name}</span>
            {p.favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" aria-label="Favorit" />}
          </div>
          <div className="truncate font-mono text-caption text-subtle" title={p.path}>
            {shortPath(p.path)}
          </div>
        </div>
      </button>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
        {!p.exists ? (
          <Badge tone="danger">
            <AlertTriangle className="h-3 w-3" /> Ordner fehlt
          </Badge>
        ) : p.git ? (
          <>
            <Badge tone="neutral">
              <GitBranch className="h-3 w-3" /> {p.git.branch ?? "ohne Branch"}
            </Badge>
            {p.git.conflicted ? (
              <Badge tone="danger">Konflikt</Badge>
            ) : p.git.changedCount > 0 ? (
              <Badge tone="warning">{p.git.changedCount} geändert</Badge>
            ) : (
              <Badge tone="success">sauber</Badge>
            )}
            {p.git.remoteUrl && (
              <span title={p.git.remoteUrl}>
                <Badge tone="neutral">
                  <Globe className="h-3 w-3" /> {p.git.remoteUrl.includes("github.com") ? "GitHub" : "origin"}
                </Badge>
              </span>
            )}
          </>
        ) : (
          <Badge tone="neutral">kein Git</Badge>
        )}
        <ProfileBadge profile={p.profile} />
        {p.technologies.slice(0, 3).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>

      {agents.length > 0 && <AgentList agents={agents} />}

      <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-2 text-caption text-muted">
        <span className="truncate">
          {p.lastSession ? `Letzte Session ${relativeTime(p.lastSession.updatedAt)}: ${p.lastSession.title ?? "ohne Titel"}` : "Noch keine Session"}
        </span>
        <DropdownMenu
          trigger={
            <Button size="icon-sm" variant="ghost" className="h-6 w-6 rounded text-subtle" aria-label="Projektaktionen">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
          items={[
            { label: p.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten", icon: <Star className="h-3.5 w-3.5" />, onSelect: () => void toggleFavorite() },
            { label: "Entfernen oder löschen", icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onSelect: () => onRemove(p) },
          ]}
        />
      </div>
    </div>
  );
}

/** The parallel agents of a project (worktrees), compact inside its card. */
function AgentList({ agents }: { agents: ProjectWithStatus[] }) {
  const openProject = useUi((s) => s.openProject);
  const busy = agents.filter(agentBusy).length;
  return (
    <div className="mx-4 mb-3 rounded-lg border border-border bg-surface-2">
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-caption text-muted">
        <Bot className="h-3.5 w-3.5" />
        {agents.length} {agents.length === 1 ? "Agent" : "Agenten"}
        {busy > 0 && <span className="text-accent">· {busy} {busy === 1 ? "arbeitet" : "arbeiten"}</span>}
      </div>
      <ul className="pb-1">
        {agents.slice(0, 5).map((a) => {
          const working = agentBusy(a);
          const waiting = a.lastSession?.status === "waiting_approval";
          return (
            <li key={a.id}>
              <button
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-caption hover:bg-surface-3 active:bg-surface-3"
                onClick={() => openProject(a.id)}
                title={`${a.git?.branch ?? a.name} öffnen${a.lastSession ? ` · ${a.lastSession.title ?? "ohne Titel"}` : ""}`}
              >
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", waiting ? "bg-warning" : working ? "animate-soft-pulse bg-accent" : (a.git?.changedCount ?? 0) > 0 ? "bg-warning/60" : "bg-success/70")}
                  aria-label={waiting ? "wartet auf Freigabe" : working ? "arbeitet" : "bereit"}
                />
                <span className="shrink-0 font-mono text-fg">{agentLabel(a)}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{a.lastSession?.title ?? "noch keine Session"}</span>
                {(a.git?.changedCount ?? 0) > 0 && <span className="shrink-0 tabular-nums text-warning">{a.git!.changedCount}</span>}
                {a.lastSession && <span className="shrink-0 text-subtle">{relativeTime(a.lastSession.updatedAt)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {agents.length > 5 && <div className="px-2.5 pb-2 text-caption text-subtle">und {agents.length - 5} weitere, im Projekt unter Agenten</div>}
    </div>
  );
}

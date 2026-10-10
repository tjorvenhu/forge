import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, GitBranch, Globe, MoreHorizontal, Star, Trash2 } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime, shortPath, cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Badge } from "@/components/ui/misc";
import { DropdownMenu } from "@/components/ui/dropdown";
import { ProjectIcon } from "./ProjectIcon";
import { ProfileBadge } from "./ProfileBadge";

export function ProjectCard({ p, onRemove }: { p: ProjectWithStatus; onRemove: (p: ProjectWithStatus) => void }) {
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
          <div className="truncate font-mono text-[11px] text-subtle" title={p.path}>
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
              <GitBranch className="h-3 w-3" /> {p.git.branch ?? "detached"}
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

      <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-2 text-[11px] text-muted">
        <span className="truncate">
          {p.lastSession ? `Letzte Session ${relativeTime(p.lastSession.updatedAt)}: ${p.lastSession.title ?? "ohne Titel"}` : "Noch keine Session"}
        </span>
        <DropdownMenu
          trigger={
            <button className="rounded p-1 text-subtle hover:bg-surface-3 hover:text-fg" aria-label="Projektaktionen">
              <MoreHorizontal className="h-4 w-4" />
            </button>
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

import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, Code2, Copy, FolderOpen, FolderSearch, GitBranch, MessageSquarePlus, MoreHorizontal, Settings2, Shield, ShieldAlert, ShieldCheck, Star, Tag, Trash2 } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { contextItems, copyText } from "@/lib/context-menu";
import { revealPath } from "@/components/workspace/file-links";
import { errorMessage } from "@/lib/rpc";
import { relativeTime, cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { ProjectIcon } from "./ProjectIcon";
import { PROFILE_INFO } from "./ProfileBadge";
import { tagLabel } from "@/components/workspace/ProjectSettingsTab";
import { agentBusy, agentLabel } from "@/lib/project-tree";
import { LocalOnlyBadge } from "@/components/settings/SyncLocalOnly";

export function ProjectCard({ p, agents = [], onRemove }: { p: ProjectWithStatus; agents?: ProjectWithStatus[]; onRemove: (p: ProjectWithStatus) => void }) {
  const openProject = useUi((s) => s.openProject);
  const openProjectSettings = useUi((s) => s.openProjectSettings);
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
    <div
      className={cn("group flex flex-col rounded-xl border border-border bg-surface transition-colors hover:border-border-strong", !p.exists && "opacity-70")}
      onContextMenu={contextItems(() => [
        { label: "Öffnen", icon: <FolderOpen className="h-3.5 w-3.5" />, onSelect: () => openProject(p.id) },
        { label: "Neue Session", icon: <MessageSquarePlus className="h-3.5 w-3.5" />, onSelect: () => openProject(p.id, null) },
        { label: p.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten", icon: <Star className="h-3.5 w-3.5" />, onSelect: () => void toggleFavorite() },
        {
          label: "Projekteinstellungen",
          icon: <Settings2 className="h-3.5 w-3.5" />,
          onSelect: () => {
            openProject(p.id);
            openProjectSettings("general");
          },
        },
        ...(p.exists ? [{ label: "Im Explorer zeigen", icon: <FolderSearch className="h-3.5 w-3.5" />, onSelect: () => void revealPath(p.path) }] : []),
        { label: "Pfad kopieren", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(p.path) },
        { label: "Entfernen oder löschen", icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onSelect: () => onRemove(p) },
      ])}
    >
      <button className="flex items-center gap-3 px-4 pb-2.5 pt-4 text-left" onClick={() => openProject(p.id)} aria-label={`${p.name} öffnen`} title={`${p.name}\n${p.path}`}>
        <ProjectIcon id={p.parentId ?? p.id} name={p.name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{p.name}</span>
            {p.favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" aria-label="Favorit" />}
            <LocalOnlyBadge projectId={p.id} />
          </div>
          <GitLine p={p} />
        </div>
        <ProfileIcon profile={p.profile} />
      </button>

      {(p.technologies.length > 0 || p.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          {p.technologies.length > 0 && (
            <Summary icon={<Code2 className="h-3 w-3" />} title={`Technologien\n${p.technologies.map((t) => `- ${t}`).join("\n")}`}>
              {p.technologies.length === 1 ? p.technologies[0] : `${p.technologies[0]} +${p.technologies.length - 1}`}
            </Summary>
          )}
          {p.tags.length > 0 && (
            <Summary
              icon={<Tag className="h-3 w-3" />}
              title={`Aktive Tags\n${p.tags.map((t) => `- ${tagLabel(t)}`).join("\n")}\n\nKlicken, um sie unter Automatik einzustellen.`}
              onClick={() => {
                openProject(p.id);
                openProjectSettings("automation");
              }}
            >
              {p.tags.length === 1 ? "1 Tag" : `${p.tags.length} Tags`}
            </Summary>
          )}
        </div>
      )}

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

/** Branch and state in one line; remote and counts in the tooltip. */
function GitLine({ p }: { p: ProjectWithStatus }) {
  if (!p.exists)
    return (
      <div className="flex items-center gap-1 text-caption text-danger">
        <AlertTriangle className="h-3 w-3" /> Ordner fehlt
      </div>
    );
  if (!p.git) return <div className="text-caption text-subtle">{p.gitEnabled ? "kein Git" : "ohne Git"}</div>;
  const g = p.git;
  const state = g.conflicted ? "Konflikt" : g.changedCount > 0 ? `${g.changedCount} geändert` : "sauber";
  const remote = g.remoteUrl ? (g.remoteUrl.includes("github.com") ? "GitHub" : g.remoteUrl) : "kein Remote";
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-caption text-muted"
      title={`Git\n- Branch ${g.branch ?? "ohne Branch"}\n- ${g.conflicted ? "Konflikt beim Zusammenführen" : g.changedCount > 0 ? `${g.changedCount} ${g.changedCount === 1 ? "Datei" : "Dateien"} geändert` : "Keine offenen Änderungen"}\n- Remote: ${remote}${g.ahead || g.behind ? `\n- ${g.ahead} voraus, ${g.behind} zurück` : ""}`}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", g.conflicted ? "bg-danger" : g.changedCount > 0 ? "bg-warning" : "bg-success")} aria-hidden />
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono">{g.branch ?? "ohne Branch"}</span>
      <span className={cn("shrink-0", g.conflicted ? "text-danger" : g.changedCount > 0 ? "text-warning" : "text-subtle")}>· {state}</span>
    </div>
  );
}

const PROFILE_ICON = {
  safe: { Icon: ShieldCheck, tone: "text-success" },
  balanced: { Icon: Shield, tone: "text-warning" },
  autonomous: { Icon: ShieldAlert, tone: "text-danger" },
} as const;

/** The permission profile as a coloured shield; name and meaning in the tooltip. */
function ProfileIcon({ profile }: { profile: ProjectWithStatus["profile"] }) {
  const { Icon, tone } = PROFILE_ICON[profile];
  return (
    <span className={cn("shrink-0 self-start", tone)} title={`Profil: ${PROFILE_INFO[profile].label}\n${PROFILE_INFO[profile].description}`}>
      <Icon className="h-4 w-4" aria-label={`Profil ${PROFILE_INFO[profile].label}`} />
    </span>
  );
}

/** Several facts bundled into one chip; the full list in its tooltip. */
function Summary({ icon, title, children, onClick }: { icon: ReactNode; title: string; children: ReactNode; onClick?: () => void }) {
  const cls = "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border border-border bg-surface-2 px-1.5 text-caption font-medium text-muted";
  return onClick ? (
    <button type="button" className={cn(cls, "transition-colors duration-120 hover:border-border-strong hover:text-fg")} title={title} onClick={onClick}>
      {icon}
      {children}
    </button>
  ) : (
    <span className={cls} title={title}>
      {icon}
      {children}
    </span>
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

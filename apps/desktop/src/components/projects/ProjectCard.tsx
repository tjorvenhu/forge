import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Bot, CalendarDays, Code2, Copy, FileStack, FolderMinus, FolderSearch, Folders, GitBranch, History, Link, MessageSquarePlus, MoreHorizontal, Settings2, Shield, ShieldAlert, ShieldCheck, Star, Tag, Trash2 } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { contextItems, copyText } from "@/lib/context-menu";
import { revealPath } from "@/components/workspace/file-links";
import { errorMessage } from "@/lib/rpc";
import { relativeTime, cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { useTemplateDialogs } from "@/stores/templates";
import { useProjectGroupDialogs } from "@/stores/project-groups";
import { useGitRemoteDialog } from "@/stores/git-remote";
import type { MenuItem } from "@/components/ui/dropdown";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { ProjectIcon } from "./ProjectIcon";
import { setProjectGroup } from "./ProjectGroupDialogs";
import { switchProjectAgents } from "./AgentsSwitch";
import { startProjectDrag, useProjectDrag } from "./project-drag";
import { PROFILE_INFO } from "./ProfileBadge";
import { tagLabel } from "@/components/workspace/ProjectSettingsTab";
import { agentBusy, agentLabel } from "@/lib/project-tree";
import { LocalOnlyBadge } from "@/components/settings/SyncLocalOnly";
import { t } from "@/i18n";

export function ProjectCard({
  p,
  agents = [],
  onRemove,
  onGroupDrop,
}: {
  p: ProjectWithStatus;
  agents?: ProjectWithStatus[];
  onRemove: (p: ProjectWithStatus) => void;
  /** set: the card can be dragged onto a group section of the projects page */
  onGroupDrop?: (p: ProjectWithStatus, group: string | null) => void;
}) {
  const dragged = useProjectDrag((s) => s.project?.id === p.id);
  const openProject = useUi((s) => s.openProject);
  const openProjectSettings = useUi((s) => s.openProjectSettings);
  const openReport = useUi((s) => s.openReport);
  const qc = useQueryClient();

  const toggleFavorite = async () => {
    try {
      await call("projects.update", { projectId: p.id, favorite: !p.favorite });
      await qc.invalidateQueries({ queryKey: keys.projects });
    } catch (e) {
      toast.error(t.projects.card.favoriteNotSaved, errorMessage(e));
    }
  };
  // Shared by the context menu and the "…" button so both offer the same actions.
  const menuItems = (): MenuItem[] => [
    { label: t.projects.card.newSession, icon: <MessageSquarePlus className="h-3.5 w-3.5" />, onSelect: () => openProject(p.id, null) },
    ...(p.lastSession ? [{ label: t.projects.card.openLastSession, icon: <History className="h-3.5 w-3.5" />, onSelect: () => openProject(p.id, p.lastSession!.id) }] : []),
    { label: t.projects.card.dailyReport, icon: <CalendarDays className="h-3.5 w-3.5" />, onSelect: () => openReport(p.parentId ?? p.id) },
    ...(p.exists ? [{ label: t.projects.card.applyTemplate, icon: <FileStack className="h-3.5 w-3.5" />, onSelect: () => useTemplateDialogs.getState().openApply({ projectId: p.id }) }] : []),
    { label: p.favorite ? t.projects.card.removeFavorite : t.projects.card.addFavorite, icon: <Star className="h-3.5 w-3.5" />, onSelect: () => void toggleFavorite() },
    { label: p.group ? t.projects.groups.changeGroup : t.projects.groups.setGroup, icon: <Folders className="h-3.5 w-3.5" />, onSelect: () => useProjectGroupDialogs.getState().openAssign(p) },
    ...(p.group ? [{ label: t.projects.groups.removeFromGroup, icon: <FolderMinus className="h-3.5 w-3.5" />, onSelect: () => void setProjectGroup(qc, p, null) }] : []),
    ...(!p.parentId && p.git?.isRepo ? [{ label: t.git.remote.menu, icon: <Link className="h-3.5 w-3.5" />, onSelect: () => useGitRemoteDialog.getState().open(p) }] : []),
    ...(!p.parentId && p.gitEnabled
      ? [{ label: p.agentsEnabled ? t.projects.agents.menuOff : t.projects.agents.menuOn, icon: <Bot className="h-3.5 w-3.5" />, onSelect: () => switchProjectAgents(qc, p, !p.agentsEnabled) }]
      : []),
    {
      label: t.projects.card.projectSettings,
      icon: <Settings2 className="h-3.5 w-3.5" />,
      onSelect: () => {
        openProject(p.id);
        openProjectSettings("general");
      },
    },
    ...(p.exists ? [{ label: t.projects.card.showInExplorer, icon: <FolderSearch className="h-3.5 w-3.5" />, onSelect: () => void revealPath(p.path) }] : []),
    { label: t.projects.card.copyPath, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(p.path) },
    { label: t.projects.card.removeOrDelete, icon: <Trash2 className="h-3.5 w-3.5" />, danger: true, onSelect: () => onRemove(p) },
  ];

  return (
    <div
      className={cn(
        "group flex flex-col rounded-xl border border-border bg-surface transition-[border-color,opacity] hover:border-border-strong",
        !p.exists && "opacity-70",
        dragged && "border-dashed border-accent opacity-50",
      )}
      onPointerDown={onGroupDrop && ((e) => startProjectDrag(e, p, onGroupDrop))}
      onContextMenu={contextItems(menuItems)}
    >
      <button className="flex items-center gap-3 px-4 pb-2.5 pt-4 text-left" onClick={() => openProject(p.id, null)} aria-label={t.projects.card.openNamed(p.name)} title={`${p.name}\n${p.path}`}>
        <ProjectIcon id={p.parentId ?? p.id} name={p.name} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{p.name}</span>
            {p.favorite && <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" aria-label={t.projects.card.favorite} />}
            <LocalOnlyBadge projectId={p.id} />
          </div>
          <GitLine p={p} />
        </div>
        {p.profile !== "autonomous" && <ProfileIcon profile={p.profile} />}
      </button>

      {(p.technologies.length > 0 || p.tags.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
          {p.technologies.length > 0 && (
            <Summary icon={<Code2 className="h-3 w-3" />} title={`${t.projects.card.technologies}\n${p.technologies.map((tech) => `- ${tech}`).join("\n")}`}>
              {p.technologies.length === 1 ? p.technologies[0] : `${p.technologies[0]} +${p.technologies.length - 1}`}
            </Summary>
          )}
          {p.tags.length > 0 && (
            <Summary
              icon={<Tag className="h-3 w-3" />}
              title={`${t.projects.card.activeTags}\n${p.tags.map((tag) => `- ${tagLabel(tag)}`).join("\n")}\n\n${t.projects.card.tagsClickHint}`}
              onClick={() => {
                openProject(p.id);
                openProjectSettings("automation");
              }}
            >
              {t.projects.card.tagCount(p.tags.length)}
            </Summary>
          )}
        </div>
      )}

      {agents.length > 0 && <AgentList agents={agents} />}

      <div className="mt-auto flex items-center justify-between border-t border-border px-4 py-2 text-caption text-muted">
        <span className="truncate">
          {p.lastSession ? t.projects.card.lastSession(relativeTime(p.lastSession.updatedAt), p.lastSession.title ?? null) : t.projects.card.noSession}
        </span>
        <DropdownMenu
          trigger={
            <Button size="icon-sm" variant="ghost" className="h-6 w-6 rounded text-subtle" aria-label={t.projects.card.projectActions}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
          items={menuItems()}
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
        <AlertTriangle className="h-3 w-3" /> {t.projects.card.folderMissing}
      </div>
    );
  if (!p.git) return <div className="text-caption text-subtle">{p.gitEnabled ? t.projects.card.noGitRepo : t.projects.card.gitOff}</div>;
  const g = p.git;
  const state = g.conflicted ? t.projects.card.conflict : g.changedCount > 0 ? t.projects.card.changed(g.changedCount) : t.projects.card.clean;
  const remote = g.remoteUrl ? (g.remoteUrl.includes("github.com") ? "GitHub" : g.remoteUrl) : t.projects.card.noRemote;
  const changes = g.conflicted ? t.projects.card.mergeConflict : g.changedCount > 0 ? t.projects.card.filesChanged(g.changedCount) : t.projects.card.noOpenChanges;
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-caption text-muted"
      title={t.projects.card.gitTitle(g.branch ?? t.projects.card.noBranch, changes, remote, g.ahead || g.behind ? t.projects.card.aheadBehind(g.ahead, g.behind) : "")}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", g.conflicted ? "bg-danger" : g.changedCount > 0 ? "bg-warning" : "bg-success")} aria-hidden />
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="truncate font-mono">{g.branch ?? t.projects.card.noBranch}</span>
      <span className={cn("shrink-0", g.conflicted ? "text-danger" : g.changedCount > 0 ? "text-warning" : "text-subtle")}>· {state}</span>
    </div>
  );
}

const PROFILE_ICON = {
  safe: { Icon: ShieldCheck, tone: "text-success" },
  balanced: { Icon: Shield, tone: "text-warning" },
  autonomous: { Icon: ShieldAlert, tone: "text-danger" },
} as const;

/** The permission profile as a coloured shield; name and meaning in the tooltip. Not shown for the default (autonomous). */
function ProfileIcon({ profile }: { profile: ProjectWithStatus["profile"] }) {
  const { Icon, tone } = PROFILE_ICON[profile];
  return (
    <span className={cn("shrink-0 self-start", tone)} title={t.projects.card.profileTitle(PROFILE_INFO[profile].label, PROFILE_INFO[profile].description)}>
      <Icon className="h-4 w-4" aria-label={t.projects.card.profileLabel(PROFILE_INFO[profile].label)} />
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
        {t.projects.card.agents(agents.length)}
        {busy > 0 && <span className="text-accent">{t.projects.card.working(busy)}</span>}
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
                title={`${t.projects.card.openNamed(a.git?.branch ?? a.name)}${a.lastSession ? ` · ${a.lastSession.title ?? t.projects.card.untitled}` : ""}`}
              >
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", waiting ? "bg-warning" : working ? "animate-soft-pulse bg-accent" : (a.git?.changedCount ?? 0) > 0 ? "bg-warning/60" : "bg-success/70")}
                  aria-label={waiting ? t.projects.card.waitingApproval : working ? t.projects.card.agentWorking : t.projects.card.ready}
                />
                <span className="shrink-0 font-mono text-fg">{agentLabel(a)}</span>
                <span className="min-w-0 flex-1 truncate text-muted">{a.lastSession?.title ?? t.projects.card.noSessionYet}</span>
                {(a.git?.changedCount ?? 0) > 0 && <span className="shrink-0 tabular-nums text-warning">{a.git!.changedCount}</span>}
                {a.lastSession && <span className="shrink-0 text-subtle">{relativeTime(a.lastSession.updatedAt)}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {agents.length > 5 && <div className="px-2.5 pb-2 text-caption text-subtle">{t.projects.card.moreAgents(agents.length - 5)}</div>}
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { Bot, ChevronDown, Columns2, FolderTree, GitMerge, GripHorizontal, LayoutGrid, Maximize2, SquareTerminal, Star, Tag, Wrench, X } from "lucide-react";
import type { ProfileId } from "@forge/protocol";
import { call, keys, useProject, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { agentLabel } from "@/lib/project-tree";
import { cn, shortPath } from "@/lib/utils";
import { MAIN_AREA, useUi, workspaceTabsFor, type SplitPane, type WorkspaceTab } from "@/stores/ui";
import { useAgentReview } from "@/stores/agent-review";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, Tooltip } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { PROFILE_IDS, PROFILE_INFO, ProfileBadge, ProfileIcon } from "@/components/projects/ProfileBadge";
import { tagLabel } from "@/components/workspace/ProjectSettingsTab";
import { RemoteControlButton } from "@/components/workspace/RemoteControl";
import { PhoneButton } from "@/components/layout/PhoneButton";
import { AlwaysOnTopButton } from "@/components/layout/AlwaysOnTopButton";
import { SyncButton } from "@/components/layout/SyncButton";
import { HeaderDivider } from "@/components/layout/Page";
import { useSplitLayout } from "./chat-slot";
import { CrewPresence } from "@/components/crew/CrewPresence";
import { t } from "@/i18n";

const m = t.workspace.header;

/** The tab is stored for the whole app, not per project: a project without git shows the chat instead of Agenten or Git. */
export function useWorkspaceTab(project: { gitEnabled: boolean }): WorkspaceTab {
  const stored = useUi((s) => s.workspaceTab);
  return workspaceTabsFor(project).includes(stored) ? stored : "chat";
}

/** Below this width of the main area the right sidebar does not fit next to the chat. */
const NARROW_WIDTH = 1024;

/** Whether the main area is too narrow for the right sidebar; measured by the split view, the window as a fallback. */
export function useNarrow() {
  const mainWidth = useSplitLayout()?.mainWidth ?? null;
  // The sidebar of the app takes 256px of the window.
  const [windowNarrow, setWindowNarrow] = useState(() => window.innerWidth - 256 < NARROW_WIDTH);
  useEffect(() => {
    const onResize = () => setWindowNarrow(window.innerWidth - 256 < NARROW_WIDTH);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return mainWidth !== null ? mainWidth < NARROW_WIDTH : windowNarrow;
}

/**
 * The layout switches side by side: tab row (Chat, Agenten, Git ...) like a ribbon, by default
 * the chat fills the view; bottom panel; right sidebar; a further area of the split view.
 */
function LayoutToggles({ project }: { project: { gitEnabled: boolean } }) {
  const workspaceTab = useWorkspaceTab(project);
  const { toolbarOpen, toggleToolbar, rightPanelOpen, toggleRightPanel, bottomPanelOpen, toggleBottomPanel } = useUi(
    useShallow((s) => ({
      toolbarOpen: s.toolbarOpen,
      toggleToolbar: s.toggleToolbar,
      rightPanelOpen: s.rightPanelOpen,
      toggleRightPanel: s.toggleRightPanel,
      bottomPanelOpen: s.bottomPanelOpen,
      toggleBottomPanel: s.toggleBottomPanel,
    })),
  );
  const narrow = useNarrow();
  const showRight = rightPanelOpen && !narrow && workspaceTab === "chat";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => toggleToolbar()}
        aria-pressed={toolbarOpen}
        aria-label={m.toolbar}
        title={m.toolbarTitle(toolbarOpen, project.gitEnabled)}
        className={cn(toolbarOpen && "text-accent")}
      >
        <Wrench className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => toggleBottomPanel()}
        aria-pressed={bottomPanelOpen}
        aria-label={m.bottomBar}
        title={m.bottomBarTitle(bottomPanelOpen)}
        className={cn(bottomPanelOpen && "text-accent")}
      >
        <SquareTerminal className="h-4 w-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => toggleRightPanel()}
        aria-pressed={showRight}
        aria-label={m.rightSidebar}
        disabled={narrow || workspaceTab !== "chat"}
        title={
          narrow
            ? m.sidebarTooNarrow
            : workspaceTab !== "chat"
              ? m.sidebarChatOnly
              : m.sidebarTitle(showRight, project.gitEnabled)
        }
        className={cn(showRight && "text-accent")}
      >
        <FolderTree className="h-4 w-4" />
      </Button>
      <SplitButton />
    </div>
  );
}

/** Opens a further area next to the main one, as long as the view has room for it. */
function SplitButton() {
  const split = useSplitLayout();
  const add = useUi((s) => s.addSplitPane);
  if (!split) return null;
  const full = split.shown >= split.capacity;
  const hint = !full ? m.splitHint(split.shown, split.capacity) : split.capacity > 1 ? m.splitFull(split.capacity) : m.splitNoRoom;
  return (
    <Button size="icon-sm" variant="ghost" aria-label={m.split} disabled={full} onClick={() => add()} title={hint} className={cn(split.shown > 1 && "text-accent")}>
      <Columns2 className="h-4 w-4" />
    </Button>
  );
}

/** The grip in the middle of an area's header: drag it onto another area to swap the two. Only in the split view. */
export function AreaGrip({ area }: { area: string }) {
  const split = useSplitLayout();
  if (!split || split.shown < 2) return null;
  return (
    <button
      type="button"
      aria-label={m.moveArea}
      title={m.moveAreaTitle}
      onPointerDown={(e) => split.startAreaDrag(area, e)}
      className="absolute left-1/2 top-0 z-10 flex h-3.5 w-12 -translate-x-1/2 cursor-grab items-center justify-center rounded-b-md text-subtle transition-colors duration-120 hover:bg-surface-3 hover:text-fg active:cursor-grabbing"
    >
      <GripHorizontal className="h-3.5 w-3.5" />
    </button>
  );
}

/** Whether the view is split right now; then the switches sit in SplitControlBar instead of the main header. */
export function useSplitActive() {
  return (useSplitLayout()?.shown ?? 1) > 1;
}

/**
 * Bar across the whole split view, above the areas: the layout switches of the main area and the
 * app-wide buttons, so they stay in reach however narrow the areas get.
 */
export function SplitControlBar({ projectId }: { projectId: string }) {
  const project = useProject(projectId).data;
  const shown = useSplitLayout()?.shown ?? 1;
  const closeAll = useUi((s) => s.closeSplitPanes);
  return (
    <div className="flex h-12 shrink-0 animate-fade-in items-center gap-3 border-b border-border px-5">
      <LayoutGrid className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 truncate text-body font-medium">{m.splitView}</span>
      <span className="hidden shrink-0 text-caption-lg text-subtle md:inline">{m.areas(shown)}</span>
      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => closeAll()} title={m.unsplitTitle}>
        {m.unsplit}
      </Button>
      <div className="flex-1" />
      {project ? (
        <>
          <LayoutToggles project={project} />
          <RemoteControlButton project={project} />
        </>
      ) : (
        <div className="flex items-center gap-0.5" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-7 w-7" />
          ))}
        </div>
      )}
      <HeaderDivider />
      <SyncButton />
      <AlwaysOnTopButton />
      <PhoneButton />
    </div>
  );
}

/**
 * Head of a project area: icon, name, favourite, tags, permission profile. The main area also carries
 * the layout switches and the app-wide buttons (in the split view the SplitControlBar does); a split
 * pane instead a project switch, "Zum Hauptbereich" and close.
 */
export function WorkspaceHeader({ projectId, pane }: { projectId: string; pane?: SplitPane }) {
  const project = useProject(projectId).data!;
  const qc = useQueryClient();
  const openProjectSettings = useUi((s) => s.openProjectSettings);
  const split = useSplitActive();
  const controls = !pane && !split;

  const sandboxOnly = project.tags.includes("sandbox-only");

  /** Shows a project change at once; the refetch afterwards brings the stored state, also after an error. */
  const optimistic = (patch: Partial<typeof project>) => qc.setQueryData(keys.project(projectId), (p: typeof project | undefined) => (p ? { ...p, ...patch } : p));

  const setProfile = async (profile: ProfileId) => {
    optimistic({ profile });
    try {
      await call("projects.update", { projectId, profile });
      await qc.invalidateQueries({ queryKey: keys.project(projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(m.profileSet(PROFILE_INFO[profile].label), m.profileSetHint);
    } catch (e) {
      void qc.invalidateQueries({ queryKey: keys.project(projectId) });
      toast.error(m.profileNotChanged, errorMessage(e));
    }
  };

  const toggleFavorite = async () => {
    const favorite = !project.favorite;
    optimistic({ favorite });
    try {
      await call("projects.update", { projectId, favorite });
      await qc.invalidateQueries({ queryKey: keys.project(projectId) });
      void qc.invalidateQueries({ queryKey: keys.projects });
    } catch (e) {
      void qc.invalidateQueries({ queryKey: keys.project(projectId) });
      toast.error(m.notSaved, errorMessage(e));
    }
  };

  const name = (
    <h1 className="-mr-1.5 min-w-0 truncate text-title-sm font-semibold" title={`${project.name}\n${shortPath(project.path, 4)}`}>
      {project.name}
    </h1>
  );

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
      <AreaGrip area={pane ? pane.id : MAIN_AREA} />
      <ProjectIcon id={project.parentId ?? project.id} name={project.name} size={26} />
      {/* Only the name gives way in a narrow window; the star sits outside it, so it cannot slide over the tags. */}
      {pane ? <ProjectSwitch pane={pane} current={projectId}>{name}</ProjectSwitch> : name}
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={() => void toggleFavorite()}
        className="hover:text-warning"
        aria-label={project.favorite ? m.unfavorite : m.favoriteAria}
        title={project.favorite ? m.unfavorite : m.favoriteTitle}
      >
        <Star className={cn("h-4 w-4", project.favorite && "fill-warning text-warning")} />
      </Button>

      {project.tags.length > 0 && (
        <button
          type="button"
          onClick={() => {
            // The project settings are a tab of the main area.
            if (pane) useUi.getState().promoteSplitPane(pane.id);
            openProjectSettings("automation");
          }}
          title={m.tagsTitle(project.tags.map((t) => `- ${tagLabel(t)}`).join("\n"))}
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-caption-lg text-muted transition-colors duration-120 hover:bg-surface-3 hover:text-fg"
        >
          <Tag className="h-3.5 w-3.5" />
          <span className="hidden @2xl:inline">{m.tagCount(project.tags.length)}</span>
        </button>
      )}

      {!pane && split && (
        <Tooltip content={m.mainAreaTooltip}>
          <span className="hidden shrink-0 @2xl:inline-flex">
            <Badge tone="accent">{m.mainArea}</Badge>
          </span>
        </Tooltip>
      )}

      <div className="flex-1" />

      {project.gitEnabled && <CrewPresence projectId={projectId} />}
      {project.parentId && (
        <Button size="sm" variant="outline" className="shrink-0 gap-1.5" onClick={() => useAgentReview.getState().request(projectId)} title={m.finishAgentTitle}>
          <GitMerge className="h-4 w-4" />
          <span className="hidden @5xl:inline">{m.finishAgent}</span>
        </Button>
      )}
      {controls && <LayoutToggles project={project} />}
      {controls && <RemoteControlButton project={project} />}

      <DropdownMenu
        header={m.profileHeader}
        trigger={
          <button
            className="flex h-9 shrink-0 items-center whitespace-nowrap rounded-lg px-2 hover:bg-surface-3"
            aria-label={m.profileAria(PROFILE_INFO[project.profile].label)}
            title={m.profileChange}
          >
            <ProfileBadge profile={project.profile} />
          </button>
        }
        items={PROFILE_IDS.map((p) => ({
          label: `${PROFILE_INFO[p].label}${p === project.profile ? m.active : ""}`,
          disabled: p === "autonomous" && sandboxOnly,
          hint: p === "autonomous" && sandboxOnly ? "sandbox-only" : undefined,
          icon: <ProfileIcon profile={p} />,
          onSelect: () => void setProfile(p),
        }))}
      />
      {pane ? (
        <>
          <HeaderDivider />
          <PaneActions pane={pane} />
        </>
      ) : (
        controls && (
          // App-wide switches, apart from the project's own controls.
          <>
            <HeaderDivider />
            <SyncButton />
            <AlwaysOnTopButton />
            <PhoneButton />
          </>
        )
      )}
    </header>
  );
}

/** Projects to pick for a split pane: favourites first, then the most recently opened. Agents come with their main project. */
export function useProjectChoices() {
  const projects = useProjects();
  const list = (projects.data ?? [])
    .filter((p) => !p.parentId)
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? "") || a.name.localeCompare(b.name));
  return { projects: list, all: projects.data ?? [], loading: projects.isPending };
}

/** The name of a split pane's project, as a menu to show another project there. */
function ProjectSwitch({ pane, current, children }: { pane: SplitPane; current: string; children: ReactNode }) {
  const { projects, all } = useProjectChoices();
  const setPane = useUi((s) => s.setSplitPane);
  const root = all.find((p) => p.id === current)?.parentId ?? current;
  const agents = all.filter((p) => p.parentId === root);
  return (
    <DropdownMenu
      align="start"
      header={m.projectInArea}
      trigger={
        <button className="-mx-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-surface-3" aria-label={m.switchProject}>
          {children}
          <ChevronDown className="ml-1.5 h-3.5 w-3.5 shrink-0 text-muted" />
        </button>
      }
      items={[
        ...projects.slice(0, 25).map((p) => ({
          label: p.name,
          hint: p.id === current ? m.open : p.favorite ? m.favorite : undefined,
          disabled: p.id === current,
          icon: <ProjectIcon id={p.id} name={p.name} size={16} className="rounded" />,
          onSelect: () => setPane(pane.id, p.id),
        })),
        ...agents
          .filter((a) => a.id !== current)
          .map((a) => ({ label: m.agent(agentLabel(a)), icon: <Bot className="h-3.5 w-3.5 text-accent" />, onSelect: () => setPane(pane.id, a.id) })),
        { label: m.pickOther, icon: <Columns2 className="h-3.5 w-3.5" />, onSelect: () => setPane(pane.id, null) },
      ]}
    />
  );
}

/** Swap with the main area, or close the pane; its session keeps running. */
export function PaneActions({ pane }: { pane: SplitPane }) {
  const promote = useUi((s) => s.promoteSplitPane);
  const close = useUi((s) => s.closeSplitPane);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {pane.projectId && (
        <Tooltip content={m.promoteTooltip}>
          <Button size="icon-sm" variant="ghost" aria-label={m.promote} onClick={() => promote(pane.id)}>
            <Maximize2 className="h-4 w-4" />
          </Button>
        </Tooltip>
      )}
      <Tooltip content={m.closeTooltip}>
        <Button size="icon-sm" variant="ghost" aria-label={m.closeArea} onClick={() => close(pane.id)}>
          <X className="h-4 w-4" />
        </Button>
      </Tooltip>
    </div>
  );
}

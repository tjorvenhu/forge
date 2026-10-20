import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Eye, FolderMinus, Folders, MoreHorizontal, Pencil, Search } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { useProjects } from "@/lib/queries";
import { contextItems } from "@/lib/context-menu";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { useProjectGroupDialogs } from "@/stores/project-groups";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { DropdownMenu, type MenuItem } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { AddProjectActions } from "@/components/projects/AddProjectActions";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { RemoveProjectDialog } from "@/components/projects/RemoveProjectDialog";
import { CardGridSkeleton } from "@/components/ui/skeleton";
import { groupKey, groupNames, groupProjects, splitProjects, type ProjectGroupSection } from "@/lib/project-tree";
import { t } from "@/i18n";

type Filter = "all" | "favorites" | "dirty" | "missing";
/** value of the "all groups" entry; group keys are lower-case names and "" */
const ALL_GROUPS = "*";
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3";

export function ProjectsView() {
  const projects = useProjects();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [removing, setRemoving] = useState<ProjectWithStatus | null>(null);
  const groupFilter = useUi((s) => s.projectGroupFilter);
  const showProjectGroup = useUi((s) => s.showProjectGroup);

  // Agents (worktrees) are shown inside the card of their project, not as projects of their own.
  const { roots, agentsOf } = useMemo(() => splitProjects(projects.data ?? []), [projects.data]);
  const groups = useMemo(() => groupNames(roots), [roots]);
  const grouped = groups.length > 0;
  // A filter for a group that no longer exists (renamed elsewhere, on the phone) shows all again.
  const activeGroup = grouped && groupFilter !== null && (groupFilter === "" || groups.some((g) => groupKey(g) === groupFilter)) ? groupFilter : null;
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = (p: ProjectWithStatus) => `${p.name} ${p.path} ${p.group ?? ""} ${p.git?.branch ?? ""} ${p.tags.join(" ")} ${p.technologies.join(" ")}`.toLowerCase().includes(needle);
    return roots.filter((p) => {
      const agents = agentsOf.get(p.id) ?? [];
      if (activeGroup !== null && groupKey(p.group) !== activeGroup) return false;
      if (needle && !matches(p) && !agents.some(matches)) return false;
      if (filter === "favorites") return p.favorite;
      if (filter === "dirty") return [p, ...agents].some((x) => (x.git?.changedCount ?? 0) > 0);
      if (filter === "missing") return !p.exists;
      return true;
    });
  }, [roots, agentsOf, q, filter, activeGroup]);
  const sections = useMemo(() => groupProjects(items), [items]);
  const agentCount = (projects.data?.length ?? 0) - roots.length;
  const filtering = q.trim() !== "" || filter !== "all";

  const card = (p: ProjectWithStatus) => <ProjectCard key={p.id} p={p} agents={agentsOf.get(p.id)} onRemove={setRemoving} />;

  return (
    <Page
      title={t.views.projects.title}
      subtitle={t.views.projects.subtitle(roots.length, agentCount)}
      actions={<AddProjectActions />}
    >
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.views.projects.searchPlaceholder} className="pl-8" aria-label={t.views.projects.searchLabel} />
        </div>
        {grouped && (
          <Select<string>
            value={activeGroup ?? ALL_GROUPS}
            onChange={(v) => showProjectGroup(v === ALL_GROUPS ? null : v)}
            className="w-44"
            aria-label={t.projects.groups.filterLabel}
            options={[
              { value: ALL_GROUPS, label: t.projects.groups.filterAll },
              ...groups.map((g) => ({ value: groupKey(g), label: g })),
              { value: "", label: t.projects.groups.none },
            ]}
          />
        )}
        <Select<Filter>
          value={filter}
          onChange={setFilter}
          className="w-44"
          aria-label={t.views.projects.filterLabel}
          options={[
            { value: "all", label: t.views.projects.filterAll },
            { value: "favorites", label: t.views.projects.filterFavorites },
            { value: "dirty", label: t.views.projects.filterDirty },
            { value: "missing", label: t.views.projects.filterMissing },
          ]}
        />
      </div>
      {projects.isLoading && <CardGridSkeleton count={6} min={300} gap="gap-3" body={1} label={t.views.projects.loading} />}
      {projects.isError && <ErrorBanner>{t.views.common.projectsLoadFailed}</ErrorBanner>}
      {projects.isSuccess && items.length === 0 && (
        <EmptyState title={projects.data.length ? t.views.projects.noMatches : t.views.common.noProjectsYet}>
          {projects.data.length ? t.views.projects.adjustSearch : t.views.projects.addAbove}
        </EmptyState>
      )}
      {grouped ? (
        <div className="flex flex-col gap-5">
          {sections.map((s) => (
            // While searching or filtering, closed groups open: a hit must not hide behind a header.
            <GroupSection key={s.key} section={s} forceOpen={filtering} filtered={activeGroup !== null}>
              {s.projects.map(card)}
            </GroupSection>
          ))}
        </div>
      ) : (
        <div className={GRID}>{items.map(card)}</div>
      )}
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </Page>
  );
}

function GroupSection({ section, forceOpen, filtered, children }: { section: ProjectGroupSection; forceOpen: boolean; filtered: boolean; children: ReactNode }) {
  const collapsed = useUi((s) => s.collapsedProjectGroups.includes(section.key));
  const toggle = useUi((s) => s.toggleProjectGroup);
  const showProjectGroup = useUi((s) => s.showProjectGroup);
  const dialogs = useProjectGroupDialogs();
  const open = forceOpen || !collapsed;
  const label = section.name ?? t.projects.groups.none;
  const m = t.projects.groups;

  const items = (): MenuItem[] => [
    { label: open ? m.collapse : m.expand, icon: <ChevronRight className={cn("h-3.5 w-3.5", open && "rotate-90")} />, onSelect: () => toggle(section.key, open) },
    filtered
      ? { label: m.showAll, icon: <Eye className="h-3.5 w-3.5" />, onSelect: () => showProjectGroup(null) }
      : { label: m.showOnly, icon: <Eye className="h-3.5 w-3.5" />, onSelect: () => showProjectGroup(section.key) },
    ...(section.name
      ? [
          { label: m.rename, icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => dialogs.openRename(section.name!) },
          { label: m.dissolve, icon: <FolderMinus className="h-3.5 w-3.5" />, danger: true, onSelect: () => dialogs.openDissolve(section.name!) },
        ]
      : []),
  ];

  return (
    <section aria-label={label}>
      <div className="mb-2 flex h-7 items-center gap-2" onContextMenu={contextItems(items)}>
        <button
          type="button"
          onClick={() => toggle(section.key, open)}
          aria-expanded={open}
          title={m.toggle(label, open)}
          className="flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left text-muted transition-colors duration-120 hover:text-fg"
        >
          <ChevronRight className={cn("h-4 w-4 shrink-0 transition-transform duration-120", open && "rotate-90")} />
          <Folders className={cn("h-4 w-4 shrink-0", section.name ? "text-accent" : "text-subtle")} />
          <span className={cn("truncate text-body font-semibold", section.name ? "text-fg" : "text-muted")}>{label}</span>
          <span className="shrink-0 text-caption tabular-nums text-subtle">{m.count(section.projects.length)}</span>
        </button>
        <div className="h-px flex-1 bg-border" />
        <DropdownMenu
          trigger={
            <Button size="icon-sm" variant="ghost" className="h-6 w-6 rounded text-subtle" aria-label={m.actions}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
          items={items()}
        />
      </div>
      {/* The collapse clips its content; the margin keeps focus rings of the cards visible. */}
      <Collapse open={open} className="-m-1 p-1">
        <div className={GRID}>{children}</div>
      </Collapse>
    </section>
  );
}

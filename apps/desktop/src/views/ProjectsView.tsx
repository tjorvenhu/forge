import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { useProjects } from "@/lib/queries";
import { Page } from "@/components/layout/Page";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { AddProjectActions } from "@/components/projects/AddProjectActions";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { RemoveProjectDialog } from "@/components/projects/RemoveProjectDialog";
import { CardGridSkeleton } from "@/components/ui/skeleton";
import { splitProjects } from "@/lib/project-tree";
import { t } from "@/i18n";

type Filter = "all" | "favorites" | "dirty" | "missing";

export function ProjectsView() {
  const projects = useProjects();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [removing, setRemoving] = useState<ProjectWithStatus | null>(null);

  // Agents (worktrees) are shown inside the card of their project, not as projects of their own.
  const { roots, agentsOf } = useMemo(() => splitProjects(projects.data ?? []), [projects.data]);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const matches = (p: ProjectWithStatus) => `${p.name} ${p.path} ${p.git?.branch ?? ""} ${p.tags.join(" ")} ${p.technologies.join(" ")}`.toLowerCase().includes(needle);
    return roots.filter((p) => {
      const agents = agentsOf.get(p.id) ?? [];
      if (needle && !matches(p) && !agents.some(matches)) return false;
      if (filter === "favorites") return p.favorite;
      if (filter === "dirty") return [p, ...agents].some((x) => (x.git?.changedCount ?? 0) > 0);
      if (filter === "missing") return !p.exists;
      return true;
    });
  }, [roots, agentsOf, q, filter]);
  const agentCount = (projects.data?.length ?? 0) - roots.length;

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
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {items.map((p) => (
          <ProjectCard key={p.id} p={p} agents={agentsOf.get(p.id)} onRemove={setRemoving} />
        ))}
      </div>
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </Page>
  );
}

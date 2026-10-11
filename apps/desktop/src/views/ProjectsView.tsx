import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { useProjects } from "@/lib/queries";
import { Page } from "@/components/layout/Page";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBanner, Loading } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { AddProjectActions } from "@/components/projects/AddProjectActions";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { RemoveProjectDialog } from "@/components/projects/RemoveProjectDialog";

type Filter = "all" | "favorites" | "dirty" | "missing";

export function ProjectsView() {
  const projects = useProjects();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [removing, setRemoving] = useState<ProjectWithStatus | null>(null);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (projects.data ?? []).filter((p) => {
      if (needle && !`${p.name} ${p.path} ${p.tags.join(" ")} ${p.technologies.join(" ")}`.toLowerCase().includes(needle)) return false;
      if (filter === "favorites") return p.favorite;
      if (filter === "dirty") return (p.git?.changedCount ?? 0) > 0;
      if (filter === "missing") return !p.exists;
      return true;
    });
  }, [projects.data, q, filter]);

  return (
    <Page
      title="Projekte"
      subtitle={`${projects.data?.length ?? 0} Projekte`}
      actions={<AddProjectActions />}
    >
      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, Pfad, Tag oder Technologie" className="pl-8" aria-label="Projekte durchsuchen" />
        </div>
        <Select<Filter>
          value={filter}
          onChange={setFilter}
          className="w-44"
          aria-label="Filter"
          options={[
            { value: "all", label: "Alle" },
            { value: "favorites", label: "Favoriten" },
            { value: "dirty", label: "Mit Änderungen" },
            { value: "missing", label: "Ordner fehlt" },
          ]}
        />
      </div>
      {projects.isLoading && <Loading />}
      {projects.isError && <ErrorBanner>Projekte konnten nicht geladen werden.</ErrorBanner>}
      {projects.isSuccess && items.length === 0 && (
        <EmptyState title={projects.data.length ? "Keine Treffer" : "Noch keine Projekte"}>
          {projects.data.length ? "Suchbegriff oder Filter anpassen." : "Füge oben ein Projekt hinzu."}
        </EmptyState>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {items.map((p) => (
          <ProjectCard key={p.id} p={p} onRemove={setRemoving} />
        ))}
      </div>
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </Page>
  );
}

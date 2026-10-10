import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen, FolderPlus, GitBranch, Play, RotateCcw } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, useDiagnostics, useProjects } from "@/lib/queries";
import { useModelLabel } from "@/lib/models";
import { relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, ErrorBanner, SectionTitle, Loading } from "@/components/ui/misc";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { RemoveProjectDialog } from "@/components/projects/RemoveProjectDialog";
import { SessionStatusBadge } from "@/components/workspace/SessionStatusBadge";
import { SummaryButton } from "@/components/workspace/SummaryButton";

export function HomeView() {
  const projects = useProjects();
  const setNewProject = useUi((s) => s.setNewProject);
  const [removing, setRemoving] = useState<ProjectWithStatus | null>(null);
  const list = projects.data ?? [];
  const favorites = list.filter((p) => p.favorite);
  const recent = [...list]
    .filter((p) => !p.favorite)
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt))
    .slice(0, 6);

  return (
    <Page
      title="Home"
      subtitle="Projekte, laufende Arbeit und Status auf einen Blick"
      actions={
        <>
          <Button onClick={() => setNewProject("clone")}>
            <GitBranch className="h-3.5 w-3.5" /> Klonen
          </Button>
          <Button onClick={() => setNewProject("create")}>
            <FolderPlus className="h-3.5 w-3.5" /> Neu
          </Button>
          <Button variant="primary" onClick={() => setNewProject("import")}>
            <FolderOpen className="h-3.5 w-3.5" /> Ordner öffnen
          </Button>
        </>
      }
    >
      <ApiKeyWarning />
      {projects.isLoading && <Loading />}
      {projects.isError && <ErrorBanner>Projekte konnten nicht geladen werden.</ErrorBanner>}
      {projects.isSuccess && list.length === 0 && (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="Noch keine Projekte"
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => setNewProject("import")}>
                Ordner importieren
              </Button>
              <Button onClick={() => setNewProject("create")}>Neues Projekt</Button>
              <Button onClick={() => setNewProject("clone")}>Repository klonen</Button>
            </div>
          }
        >
          Importiere einen bestehenden Projektordner oder lege ein neues Projekt an. FORGE startet Claude Code dann direkt im Projekt.
        </EmptyState>
      )}

      {list.length > 0 && (
        <div className="flex flex-col gap-8">
          <ResumeSection />
          {favorites.length > 0 && (
            <section>
              <SectionTitle>Favoriten</SectionTitle>
              <Grid items={favorites} onRemove={setRemoving} />
            </section>
          )}
          {recent.length > 0 && (
            <section>
              <SectionTitle>Zuletzt geöffnet</SectionTitle>
              <Grid items={recent} onRemove={setRemoving} />
            </section>
          )}
        </div>
      )}
      <RemoveProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </Page>
  );
}

function Grid({ items, onRemove }: { items: ProjectWithStatus[]; onRemove: (p: ProjectWithStatus) => void }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
      {items.map((p) => (
        <ProjectCard key={p.id} p={p} onRemove={onRemove} />
      ))}
    </div>
  );
}

function ResumeSection() {
  const label = useModelLabel();
  const openProject = useUi((s) => s.openProject);
  const sessions = useQuery({ queryKey: ["allSessions", "", ""], queryFn: () => call("sessions.listAll", {}) });
  const items = (sessions.data ?? []).slice(0, 5);
  if (!items.length) return null;
  return (
    <section>
      <SectionTitle>Fortsetzen</SectionTitle>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        {items.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
            <SessionStatusBadge status={s.status} live={s.live} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]">{s.title ?? "Ohne Titel"}</div>
              <div className="text-[11px] text-subtle">
                {s.projectName} · {relativeTime(s.updatedAt)}
                {s.model ? ` · ${label(s.model)}` : ""}
              </div>
            </div>
            <SummaryButton sessionId={s.id} title={s.title} size="icon-sm" />
            <Button size="sm" variant="ghost" onClick={() => openProject(s.projectId, s.id)}>
              {s.live ? <Play className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
              {s.live ? "Öffnen" : "Fortsetzen"}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function SetupButton() {
  const setView = useUi((s) => s.setView);
  return (
    <Button size="sm" variant="primary" onClick={() => setView("settings")}>
      Einrichten
    </Button>
  );
}

function ApiKeyWarning() {
  const d = useDiagnostics().data;
  if (!d) return null;
  const notLoggedIn = d.claude.found && d.auth.checked && !d.auth.loggedIn;
  const keyActive = d.apiKeyEnvPresent && !d.apiKeyStripped;
  if (!d.claude.found)
    return (
      <div className="mb-5">
        <ErrorBanner title="Claude Code ist noch nicht installiert" action={<SetupButton />}>
          FORGE richtet Claude Code mit einem Klick ein. Danach meldest du dich mit deinem Claude-Konto an.
        </ErrorBanner>
      </div>
    );
  if (notLoggedIn)
    return (
      <div className="mb-5">
        <ErrorBanner title="Claude Code ist nicht angemeldet" action={<SetupButton />}>
          Melde dich mit deinem Claude-Konto an, um Sessions zu starten.
        </ErrorBanner>
      </div>
    );
  if (keyActive)
    return (
      <div className="mb-5 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[13px]">
        <Badge tone="warning">Hinweis</Badge>
        ANTHROPIC_API_KEY ist gesetzt und wird an Sessions weitergegeben. Das kann API-Kosten statt Abo-Nutzung auslösen.
      </div>
    );
  return null;
}

import { Bot, ExternalLink, Workflow } from "lucide-react";
import { GitHubAccountCard, GitHubRepoList, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { useDiagnostics, useProject, useRuntimeInfo } from "@/lib/queries";
import { openExternal, remoteToWebUrl } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionTitle, Spinner } from "@/components/ui/misc";

export function GitHubView() {
  const diag = useDiagnostics();
  const activeProjectId = useUi((s) => s.activeProjectId);
  const project = useProject(activeProjectId);
  useAutoOpenGitHub();
  const gh = diag.data?.gh;
  const web = remoteToWebUrl(project.data?.git?.remoteUrl ?? null);
  return (
    <Page title="GitHub" subtitle="Konto, Repositories und Projekt-Remote">
      <div className="flex max-w-3xl flex-col gap-4">
        <section className="rounded-xl border border-border bg-surface p-4">
          <SectionTitle>GitHub-Konto</SectionTitle>
          {gh && !gh.found ? (
            <p className="text-[13px] text-danger">Die GitHub-Anbindung fehlt in dieser Installation. Bitte FORGE neu installieren.</p>
          ) : (
            <GitHubAccountCard />
          )}
        </section>
        <GitHubRepoList />
        <section className="rounded-xl border border-border bg-surface p-4">
          <SectionTitle>Aktuelles Projekt</SectionTitle>
          {!project.data ? (
            <p className="text-[13px] text-muted">Kein Projekt geöffnet.</p>
          ) : (
            <div className="flex items-center gap-3 text-[13px]">
              <span className="font-medium">{project.data.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{project.data.git?.remoteUrl ?? "kein Remote origin"}</span>
              {web && (
                <Button size="sm" onClick={() => void openExternal(web)}>
                  <ExternalLink className="h-3.5 w-3.5" /> Im Browser
                </Button>
              )}
            </div>
          )}
        </section>
        <p className="text-xs text-subtle">Push mit Schutzregeln und Pull Requests folgen in Phase 2.</p>
      </div>
    </Page>
  );
}

export function AgentsView() {
  const info = useRuntimeInfo();
  const agents = info.data?.agents ?? [];
  return (
    <Page title="Agenten" subtitle="Von Claude Code gemeldete Subagenten (eingebaut, Nutzer- und Projektkonfiguration)">
      {info.isLoading && <Spinner />}
      {info.isSuccess && agents.length === 0 && (
        <EmptyState icon={<Bot className="h-10 w-10" />} title="Keine Agenten gemeldet">
          Die Liste stammt aus der Claude-Code-Initialisierung.
        </EmptyState>
      )}
      <div className="grid max-w-5xl grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {agents.map((a) => (
          <div key={a.name} className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <Bot className="h-4 w-4 text-accent" /> {a.name}
            </div>
            <p className="mt-1.5 line-clamp-4 text-xs text-muted">{a.description}</p>
          </div>
        ))}
      </div>
      <p className="mt-6 text-xs text-subtle">Agentenorchestrierung mit getrennten Worktrees ist für Phase 3 geplant.</p>
    </Page>
  );
}

export function AutomationsView() {
  return (
    <Page title="Automatisierungen" subtitle="Feature-Workflows, Checks und geplante Aufgaben">
      <EmptyState icon={<Workflow className="h-10 w-10" />} title="Noch nicht verfügbar">
        Der One-Click-Feature-Workflow (Plan, Branch, Implementierung, Tests, Review, Commit, PR) und automatische Checks sind für Phase 2 geplant. Bis dahin laufen alle
        Schritte manuell im Workspace.
      </EmptyState>
    </Page>
  );
}

import { ExternalLink } from "lucide-react";
import { GitHubAccountCard, GitHubRepoList, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { useDiagnostics, useProject } from "@/lib/queries";
import { openExternal, remoteToWebUrl } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { SectionTitle } from "@/components/ui/misc";

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

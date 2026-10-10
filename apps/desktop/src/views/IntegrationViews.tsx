import { Bot, ExternalLink, GitPullRequest, Server, Workflow } from "lucide-react";
import { useDiagnostics, useProject, useRuntimeInfo } from "@/lib/queries";
import { openExternal, remoteToWebUrl } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState, SectionTitle, Spinner } from "@/components/ui/misc";

export function GitHubView() {
  const diag = useDiagnostics();
  const activeProjectId = useUi((s) => s.activeProjectId);
  const project = useProject(activeProjectId);
  const gh = diag.data?.gh;
  const web = remoteToWebUrl(project.data?.git?.remoteUrl ?? null);
  return (
    <Page title="GitHub" subtitle="Anbindung über die offizielle GitHub CLI (gh). FORGE speichert keine Tokens.">
      <div className="flex max-w-3xl flex-col gap-4">
        <section className="rounded-xl border border-border bg-surface p-4">
          <SectionTitle>GitHub CLI</SectionTitle>
          {!gh ? (
            <Spinner />
          ) : !gh.found ? (
            <p className="text-[13px] text-muted">
              gh ist nicht installiert. Unter Windows: <code className="font-mono">winget install GitHub.cli</code>, danach <code className="font-mono">gh auth login</code>.
            </p>
          ) : (
            <div className="flex flex-col gap-2 text-[13px]">
              <div className="flex items-center gap-2">
                <GitPullRequest className="h-4 w-4" /> {gh.version}
                {gh.authenticated ? <Badge tone="success">angemeldet</Badge> : <Badge tone="warning">nicht angemeldet</Badge>}
              </div>
              {!gh.authenticated && (
                <p className="text-muted">
                  Im Terminal <code className="font-mono">gh auth login</code> ausführen. Danach unter Einstellungen „Neu prüfen“.
                </p>
              )}
            </div>
          )}
        </section>
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
        <p className="text-xs text-subtle">Pull Requests, Push mit Guardrails und PR-Status folgen in Phase 2.</p>
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

export function McpView() {
  const info = useRuntimeInfo();
  const servers = info.data?.mcpServers ?? [];
  const commands = info.data?.commands ?? [];
  return (
    <Page title="MCP Server" subtitle="Status aus der zuletzt gestarteten Claude-Session">
      {info.isLoading && <Spinner />}
      {info.isSuccess && servers.length === 0 && (
        <EmptyState icon={<Server className="h-10 w-10" />} title="Noch keine Daten">
          Der MCP-Status wird beim Start einer Session von Claude Code gemeldet. Starte eine Session und öffne diese Seite erneut.
        </EmptyState>
      )}
      {servers.length > 0 && (
        <div className="max-w-3xl divide-y divide-border rounded-xl border border-border bg-surface">
          {servers.map((s) => (
            <div key={s.name} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <Server className="h-4 w-4 text-muted" />
              <span className="flex-1">{s.name}</span>
              <Badge tone={s.status === "connected" ? "success" : s.status === "failed" ? "danger" : "neutral"}>{s.status}</Badge>
            </div>
          ))}
        </div>
      )}
      {commands.length > 0 && (
        <section className="mt-6 max-w-3xl">
          <SectionTitle>Slash-Commands und Skills ({commands.length})</SectionTitle>
          <div className="divide-y divide-border rounded-xl border border-border bg-surface">
            {commands.slice(0, 50).map((c) => (
              <div key={c.name} className="flex gap-3 px-4 py-2 text-[13px]">
                <span className="w-56 shrink-0 truncate font-mono text-xs">/{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.description}</span>
              </div>
            ))}
          </div>
        </section>
      )}
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

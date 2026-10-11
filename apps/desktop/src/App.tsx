import { useEffect, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { isTauri, rpc } from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { Sidebar } from "@/components/layout/Sidebar";
import { Toaster } from "@/components/layout/Toaster";
import { TitleTooltips } from "@/components/ui/title-tooltips";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { HomeView } from "@/views/HomeView";
import { ProjectsView } from "@/views/ProjectsView";
import { SessionsView } from "@/views/SessionsView";
import { SettingsView } from "@/views/SettingsView";
import { WorkspaceView } from "@/views/WorkspaceView";
import { GitHubView } from "@/views/GitHubView";
import { AgentsView } from "@/views/AgentsView";
import { ExtensionsView } from "@/views/ExtensionsView";
import { useGlobalShortcuts } from "@/lib/shortcuts";

type Boot = { state: "starting" } | { state: "up" } | { state: "down"; detail?: string } | { state: "no-tauri" };

export function App() {
  const [boot, setBoot] = useState<Boot>(() => (isTauri() ? { state: "starting" } : { state: "no-tauri" }));

  useEffect(() => {
    if (!isTauri()) return;
    const off = rpc.onStatus((up, detail) => setBoot(up ? { state: "up" } : { state: "down", detail }));
    rpc.start().catch((e: unknown) => setBoot({ state: "down", detail: String(e) }));
    return off;
  }, []);

  if (boot.state === "no-tauri") {
    return (
      <Centered>
        <AlertTriangle className="h-6 w-6 text-warning" />
        <div className="text-sm font-medium">FORGE läuft nur als Desktop-App.</div>
        <div className="max-w-md text-center text-body text-muted">
          Die Oberfläche braucht den lokalen Hintergrunddienst. Starte sie mit <code className="font-mono">pnpm dev</code> im Projektordner.
        </div>
      </Centered>
    );
  }
  if (boot.state === "starting") {
    return (
      <Centered>
        <Spinner />
        <div className="text-body text-muted">Hintergrunddienst startet …</div>
      </Centered>
    );
  }
  if (boot.state === "down") {
    return (
      <Centered>
        <AlertTriangle className="h-6 w-6 text-danger" />
        <div className="text-sm font-medium">Der FORGE-Hintergrunddienst läuft nicht.</div>
        {boot.detail && <pre className="max-h-48 max-w-2xl overflow-auto rounded-md bg-surface p-3 font-mono text-xs text-muted">{boot.detail}</pre>}
        <div className="max-w-md text-center text-body text-muted">Voraussetzung ist Node.js ab Version 22.13 im PATH.</div>
        <Button variant="primary" onClick={() => void rpc.restart()}>
          <RotateCw className="h-3.5 w-3.5" /> Neu starten
        </Button>
      </Centered>
    );
  }
  return <Shell />;
}

function Shell() {
  useGlobalShortcuts();
  const view = useUi((s) => s.view);
  const activeProjectId = useUi((s) => s.activeProjectId);
  return (
    <div className="flex h-full min-w-0">
      <ErrorBoundary>
        <Sidebar />
      </ErrorBoundary>
      <main className="flex min-w-0 flex-1 flex-col">
        <ErrorBoundary resetKey={`${view}:${activeProjectId}`}>
          {view === "home" && <HomeView />}
          {view === "projects" && <ProjectsView />}
          {view === "sessions" && <SessionsView />}
          {view === "settings" && <SettingsView />}
          {view === "workspace" && <WorkspaceView />}
          {view === "github" && <GitHubView />}
          {view === "agents" && <AgentsView />}
          {view === "mcp" && <ExtensionsView />}
        </ErrorBoundary>
      </main>
      <NewProjectDialog />
      <CommandPalette />
      <Toaster />
      <TitleTooltips />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6">{children}</div>;
}

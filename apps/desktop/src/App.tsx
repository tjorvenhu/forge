import { lazy, Suspense, useEffect, useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import { isTauri, rpc } from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { Sidebar } from "@/components/layout/Sidebar";
import { Toaster } from "@/components/layout/Toaster";
import { TitleTooltips } from "@/components/ui/title-tooltips";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { AppUpdateDialog } from "@/components/layout/AppUpdate";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { HomeView } from "@/views/HomeView";
import { ProjectsView } from "@/views/ProjectsView";
import { WorkspaceView } from "@/views/WorkspaceView";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useAlwaysOnTop } from "@/lib/window-options";
import type { ChatWindowTarget } from "@/lib/chat-windows";
import { ChatWindowShell } from "@/views/ChatWindowView";
import { AgentReviewDialog } from "@/components/workspace/AgentReviewDialog";

// Views that are not needed at start (they bring CodeMirror and more) load on first use, or
// in idle time right after the start, so the first switch does not wait either.
const loadSessions = () => import("@/views/SessionsView");
const loadSettings = () => import("@/views/SettingsView");
const loadExtensions = () => import("@/views/ExtensionsView");
const SessionsView = lazy(() => loadSessions().then((m) => ({ default: m.SessionsView })));
const SettingsView = lazy(() => loadSettings().then((m) => ({ default: m.SettingsView })));
const ExtensionsView = lazy(() => loadExtensions().then((m) => ({ default: m.ExtensionsView })));

function preloadViews() {
  const run = () => void Promise.all([loadSessions(), loadSettings(), loadExtensions()]).catch(() => {});
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
  else setTimeout(run, 2000);
}

type Boot = { state: "starting" } | { state: "up" } | { state: "down"; detail?: string } | { state: "no-tauri" };

export function App({ chatWindow = null }: { chatWindow?: ChatWindowTarget | null }) {
  const [boot, setBoot] = useState<Boot>(() => (isTauri() ? { state: "starting" } : { state: "no-tauri" }));
  const isChat = chatWindow !== null;

  useEffect(() => {
    if (!isTauri()) return;
    const off = rpc.onStatus((up, detail) => {
      setBoot(up ? { state: "up" } : { state: "down", detail });
      if (up && !isChat) preloadViews();
    });
    rpc.start({ manageSidecar: !isChat }).catch((e: unknown) => setBoot({ state: "down", detail: String(e) }));
    return off;
  }, [isChat]);

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
        <Logo height={64} />
        <div className="flex items-center gap-2 text-body text-muted">
          <Spinner /> FORGE startet …
        </div>
      </Centered>
    );
  }
  if (boot.state === "down") {
    return (
      <Centered>
        <AlertTriangle className="h-6 w-6 text-danger" />
        <div className="text-sm font-medium">Der FORGE-Hintergrunddienst läuft nicht.</div>
        {boot.detail && <pre className="max-h-48 max-w-2xl overflow-auto rounded-md bg-surface p-3 font-mono text-xs text-muted">{boot.detail}</pre>}
        {isChat ? (
          <div className="max-w-md text-center text-body text-muted">Starte ihn im FORGE-Hauptfenster neu. Dieses Fenster verbindet sich danach von selbst.</div>
        ) : (
          <>
            <div className="max-w-md text-center text-body text-muted">Voraussetzung ist Node.js ab Version 22.13 im PATH.</div>
            <Button variant="primary" onClick={() => void rpc.restart()}>
              <RotateCw className="h-3.5 w-3.5" /> Neu starten
            </Button>
          </>
        )}
      </Centered>
    );
  }
  return chatWindow ? <ChatWindowShell target={chatWindow} /> : <Shell />;
}

function Shell() {
  useGlobalShortcuts();
  useAlwaysOnTop();
  const view = useUi((s) => s.view);
  const activeProjectId = useUi((s) => s.activeProjectId);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        <ErrorBoundary>
          <Sidebar />
        </ErrorBoundary>
        <main className="flex min-w-0 flex-1 flex-col">
          <ErrorBoundary resetKey={`${view}:${activeProjectId}`}>
            <Suspense
              fallback={
                <div className="flex flex-1 items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              {/* Keyed per view: each switch fades the new view in (enter only, nothing waits for an exit). */}
              <div key={view} className="flex min-h-0 min-w-0 flex-1 animate-view-in flex-col">
                {view === "home" && <HomeView />}
                {view === "projects" && <ProjectsView />}
                {view === "sessions" && <SessionsView />}
                {view === "settings" && <SettingsView />}
                {view === "workspace" && <WorkspaceView />}
                {view === "mcp" && <ExtensionsView />}
              </div>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <NewProjectDialog />
      <CommandPalette />
      <AppUpdateDialog />
      <AgentReviewDialog />
      <Toaster />
      <TitleTooltips />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6">{children}</div>;
}

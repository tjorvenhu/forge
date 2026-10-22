import { lazy, Suspense, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ExternalLink, RotateCw } from "lucide-react";
import { isTauri, rpc } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { Sidebar } from "@/components/layout/Sidebar";
import { Toaster } from "@/components/layout/Toaster";
import { CrewBubble } from "@/components/crew/CrewBubble";
import { ContextMenuHost } from "@/components/layout/ContextMenuHost";
import { TemplateHost } from "@/components/templates/TemplateHost";
import { SessionUsageDialogHost } from "@/components/usage/SessionUsage";
import { TitleTooltips } from "@/components/ui/title-tooltips";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { NewProjectDialog } from "@/components/projects/NewProjectDialog";
import { ProjectGroupDialogs } from "@/components/projects/ProjectGroupDialogs";
import { AgentsOffDialog } from "@/components/projects/AgentsSwitch";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { AppUpdateDialog } from "@/components/layout/AppUpdate";
import { InstallRepairBanner, RELEASES_URL } from "@/components/layout/InstallRepair";
import { SetupWizard } from "@/components/setup/SetupWizard";
import { SyncPrompt } from "@/components/setup/SyncPrompt";
import { UsageStatsPrompt } from "@/components/setup/UsageStatsPrompt";
import { SupportDialog } from "@/components/settings/SupportSettings";
import { ClaudeLoginDialog, ClaudeLogoutDialog } from "@/components/settings/ClaudeLoginDialog";
import { Logo } from "@/components/layout/Logo";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { HomeView } from "@/views/HomeView";
import { ProjectsView } from "@/views/ProjectsView";
import { WorkspaceView } from "@/views/WorkspaceView";
import { useGlobalShortcuts } from "@/lib/shortcuts";
import { useAlwaysOnTop } from "@/lib/window-options";
import { useScreenshotKey } from "@/lib/screenshot";
import { reopenChatWindows } from "@/lib/app-install";
import type { ChatWindowTarget } from "@/lib/chat-windows";
import { ChatWindowShell } from "@/views/ChatWindowView";
import { AgentReviewDialog } from "@/components/workspace/AgentReviewDialog";
import { RemoteCheckDialog } from "@/components/git/RemoteCheckDialog";
import { PushAllDialog } from "@/components/git/PushAllDialog";
import { RemoteDialog } from "@/components/git/RemoteDialog";
import { useLanguageSync } from "@/i18n/sync";
import { t } from "@/i18n";

// Views that are not needed at start (they bring CodeMirror and more) load on first use, or
// in idle time right after the start, so the first switch does not wait either.
const loadSessions = () => import("@/views/SessionsView");
const loadSettings = () => import("@/views/SettingsView");
const loadExtensions = () => import("@/views/ExtensionsView");
const loadReport = () => import("@/views/ReportView");
const SessionsView = lazy(() => loadSessions().then((m) => ({ default: m.SessionsView })));
const ReportView = lazy(() => loadReport().then((m) => ({ default: m.ReportView })));
const SettingsView = lazy(() => loadSettings().then((m) => ({ default: m.SettingsView })));
const ExtensionsView = lazy(() => loadExtensions().then((m) => ({ default: m.ExtensionsView })));

function preloadViews() {
  const run = () => void Promise.all([loadSessions(), loadReport(), loadSettings(), loadExtensions()]).catch(() => {});
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
        <div className="text-sm font-medium">{t.app.desktopOnly}</div>
        <div className="max-w-md text-center text-body text-muted">
          {t.app.needsSidecar} {t.app.startWith} <code className="font-mono">pnpm dev</code> {t.app.inProjectFolder}
        </div>
      </Centered>
    );
  }
  if (boot.state === "starting") {
    return (
      <Centered>
        <Logo height={53} />
        <div className="flex items-center gap-2 text-body text-muted">
          <Spinner /> {t.app.starting}
        </div>
      </Centered>
    );
  }
  if (boot.state === "down") {
    return (
      <Centered>
        <AlertTriangle className="h-6 w-6 text-danger" />
        <div className="text-sm font-medium">{t.app.sidecarDown}</div>
        {boot.detail && <pre className="max-h-48 max-w-2xl overflow-auto rounded-md bg-surface p-3 font-mono text-xs text-muted">{boot.detail}</pre>}
        {isChat ? (
          <div className="max-w-md text-center text-body text-muted">{t.app.restartInMain}</div>
        ) : (
          <>
            <IncompleteInstallHint />
            <Button variant="primary" onClick={() => void rpc.restart()}>
              <RotateCw className="h-3.5 w-3.5" /> {t.app.restart}
            </Button>
          </>
        )}
      </Centered>
    );
  }
  return chatWindow ? <ChatWindowShell target={chatWindow} /> : <Shell />;
}

function Shell() {
  useLanguageSync();
  useGlobalShortcuts();
  useAlwaysOnTop();
  useScreenshotKey();
  useEffect(() => void reopenChatWindows(), []);
  const view = useUi((s) => s.view);
  const activeProjectId = useUi((s) => s.activeProjectId);
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex min-h-0 min-w-0 flex-1">
        <ErrorBoundary>
          <Sidebar />
        </ErrorBoundary>
        <main className="flex min-w-0 flex-1 flex-col">
          <ErrorBoundary>
            <InstallRepairBanner />
          </ErrorBoundary>
          <ErrorBoundary resetKey={`${view}:${activeProjectId}`}>
            <Suspense fallback={<PageSkeleton />}>
              {/* Keyed per view: each switch fades the new view in (enter only, nothing waits for an exit). */}
              <div key={view} className="flex min-h-0 min-w-0 flex-1 animate-view-in flex-col">
                {view === "home" && <HomeView />}
                {view === "projects" && <ProjectsView />}
                {view === "sessions" && <SessionsView />}
                {view === "report" && <ReportView />}
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
      <SetupWizard />
      <ClaudeLoginDialog />
      <ClaudeLogoutDialog />
      <SyncPrompt />
      <UsageStatsPrompt />
      <SupportDialog />
      <AgentReviewDialog />
      <CrewBubble />
      <Toaster />
      <TitleTooltips />
      <ContextMenuHost />
      <TemplateHost />
      <SessionUsageDialogHost />
      <ProjectGroupDialogs />
      <AgentsOffDialog />
      <RemoteCheckDialog />
      <PushAllDialog />
      <RemoteDialog />
    </div>
  );
}

/** Stand-in for a lazy view in the frame of `Page`: header with title and subtitle, then content. */
function PageSkeleton() {
  return (
    <SkeletonRegion label={t.app.loadingView} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-16 items-center border-b border-border px-6 py-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-3 w-80" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-5">
        <Skeleton className="h-9 w-72 rounded-lg" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-2.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/**
 * Why the sidecar may not run: in an installation without its bundled runtime (an update zip unpacked
 * instead of the installer) node is missing. The shell checks the folder, the sidecar cannot.
 */
function IncompleteInstallHint() {
  const [missing, setMissing] = useState<string[] | null>(null);
  useEffect(() => {
    invoke<{ release: boolean; missing: string[] }>("install_check")
      .then((r) => setMissing(r.release ? r.missing : []))
      .catch(() => setMissing([]));
  }, []);
  if (missing === null)
    return (
      <SkeletonRegion label={t.app.loadingInstallCheck} className="flex justify-center">
        <Skeleton className="h-3.5 w-72" />
      </SkeletonRegion>
    );
  if (!missing.length) return <div className="max-w-md text-center text-body text-muted">{t.app.nodeRequired}</div>;
  return (
    <div className="flex max-w-md flex-col items-center gap-2 text-center text-body text-muted">
      <div>
        {t.app.incomplete(missing.join(", "))}
      </div>
      <Button variant="outline" onClick={() => void openExternal(RELEASES_URL)}>
        <ExternalLink className="h-3.5 w-3.5" /> {t.app.openReleases}
      </Button>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-3 p-6">{children}</div>;
}

import { useEffect } from "react";
import { useProject, useSession } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { reportChatWindow, type ChatWindowTarget } from "@/lib/chat-windows";
import { loadChatWindowPin } from "@/lib/window-options";
import { splitActive, useUi } from "@/stores/ui";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { Toaster } from "@/components/layout/Toaster";
import { ContextMenuHost } from "@/components/layout/ContextMenuHost";
import { TemplateHost } from "@/components/templates/TemplateHost";
import { TitleTooltips } from "@/components/ui/title-tooltips";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { ChatPanel, ChatPanelSkeleton } from "@/components/workspace/ChatPanel";
import { ClaudeLoginRequiredNotice } from "@/components/settings/ClaudeLoginDialog";

/**
 * A chat window: one session chat of one project, without sidebar, tabs and workspace. The app-wide
 * shortcuts stay with the main window; the composer keeps its own.
 */
export function ChatWindowShell({ target }: { target: ChatWindowTarget }) {
  useReportShownSession(target.projectId);
  useEffect(() => void loadChatWindowPin(), []);
  const project = useProject(target.projectId);

  let content;
  if (project.isLoading) content = <ChatPanelSkeleton detached />;
  else if (project.isError || !project.data)
    content = (
      <div className="p-6">
        <ErrorBanner title="Projekt nicht gefunden">{errorMessage(project.error)}</ErrorBanner>
      </div>
    );
  else if (!project.data.exists) content = <EmptyState title="Chat nicht verfügbar">Der Projektordner fehlt.</EmptyState>;
  else content = <ChatPanel project={project.data} detached />;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ErrorBoundary>{content}</ErrorBoundary>
      </main>
      <Toaster />
      <TitleTooltips />
      {/* No command palette in a chat window: the menu leaves out the search. */}
      <ContextMenuHost search={false} />
      <TemplateHost apply={false} />
      <ClaudeLoginRequiredNotice />
    </div>
  );
}

/** Keeps the shell's list of chat windows and the window title in line with the shown session. */
function useReportShownSession(projectId: string) {
  const { sessionId } = splitActive(useUi((s) => s.activeSession[projectId]));
  const session = useSession(sessionId);
  const title = sessionId ? (session.data?.title ?? "Ohne Titel") : "Neue Session";
  const ready = !sessionId || !!session.data;
  useEffect(() => {
    if (ready) reportChatWindow(sessionId, title);
  }, [sessionId, title, ready]);
}

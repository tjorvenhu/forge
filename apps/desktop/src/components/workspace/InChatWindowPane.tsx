import { AppWindow, SquareArrowOutDownLeft, SquareArrowOutUpRight } from "lucide-react";
import type { Project } from "@forge/protocol";
import { openChatWindow, recallChatWindow } from "@/lib/chat-windows";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";
import { t } from "@/i18n";

/** Takes the place of a chat in the main window while the chat is open in its own window. */
export function InChatWindowPane({ project, sessionId, title }: { project: Project; sessionId: string; title: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 animate-view-in items-center justify-center overflow-y-auto">
      <EmptyState
        icon={<AppWindow className="h-9 w-9" />}
        title={t.workspace.inChatWindow.title}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void openChatWindow(project.id, sessionId, title)}>
              <SquareArrowOutUpRight className="h-3.5 w-3.5" /> {t.workspace.inChatWindow.show}
            </Button>
            <Button size="sm" variant="primary" onClick={() => recallChatWindow(sessionId)}>
              <SquareArrowOutDownLeft className="h-3.5 w-3.5" /> {t.workspace.inChatWindow.recall}
            </Button>
          </div>
        }
      >
        {t.workspace.inChatWindow.text}
      </EmptyState>
    </div>
  );
}

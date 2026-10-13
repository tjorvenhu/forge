import { AppWindow, SquareArrowOutDownLeft, SquareArrowOutUpRight } from "lucide-react";
import type { Project } from "@forge/protocol";
import { openChatWindow, recallChatWindow } from "@/lib/chat-windows";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/misc";

/** Takes the place of a chat in the main window while the chat is open in its own window. */
export function InChatWindowPane({ project, sessionId, title }: { project: Project; sessionId: string; title: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 animate-view-in items-center justify-center overflow-y-auto">
      <EmptyState
        icon={<AppWindow className="h-9 w-9" />}
        title="Dieser Chat ist in einem eigenen Fenster geöffnet"
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => void openChatWindow(project.id, sessionId, title)}>
              <SquareArrowOutUpRight className="h-3.5 w-3.5" /> Fenster anzeigen
            </Button>
            <Button size="sm" variant="primary" onClick={() => recallChatWindow(sessionId)}>
              <SquareArrowOutDownLeft className="h-3.5 w-3.5" /> Zurückholen
            </Button>
          </div>
        }
      >
        Nachrichten, Freigaben und Antworten laufen dort. Zurückholen schließt das Fenster und zeigt den Chat wieder hier.
      </EmptyState>
    </div>
  );
}

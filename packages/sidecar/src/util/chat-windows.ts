import type { ChatWindowAction, ServerEvent } from "@forge/protocol";

/**
 * The chat windows of the desktop, as the main window reports them (app.chatWindows). Only the
 * shell can open, take back or pin them; the phone asks the main window with chatWindow.request.
 */
export class ChatWindowState {
  private sessions: string[] = [];
  private pinned: string[] = [];

  constructor(private readonly emit: (e: ServerEvent) => void) {}

  report(sessions: string[], pinned: string[]) {
    this.sessions = [...sessions];
    this.pinned = pinned.filter((s) => sessions.includes(s));
  }

  get(): { sessions: string[]; pinned: string[] } {
    return { sessions: [...this.sessions], pinned: [...this.pinned] };
  }

  request(action: ChatWindowAction, target: { projectId: string; sessionId: string; title: string | null }) {
    this.emit({ event: "chatWindow.request", payload: { action, ...target } });
  }
}

import { Bot, ListTree, User } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { cardKey, useCardState, useCardStore } from "@/stores/card-state";
import { Tooltip } from "@/components/ui/misc";
import type { ChatItem } from "./chat-items";

/** What the chat shows: everything, only the user's prompts, or only Claude's answers (text, no tools). */
export type ChatView = "all" | "prompts" | "answers";

export const CHAT_VIEWS: ReadonlyArray<{ id: ChatView; Icon: LucideIcon; label: string; title: string }> = [
  { id: "all", Icon: ListTree, label: t.chat.view.all, title: t.chat.view.allTitle },
  { id: "prompts", Icon: User, label: t.chat.view.prompts, title: t.chat.view.promptsTitle },
  { id: "answers", Icon: Bot, label: t.chat.view.answers, title: t.chat.view.answersTitle },
];

const viewKey = (sessionId: string) => cardKey(sessionId, "chat", "view");

/** Per session, kept while FORGE runs (also when the chat is closed and opened again). */
export function useChatView(sessionId: string): [ChatView, (v: ChatView) => void] {
  const [view, setView] = useCardState<ChatView>(viewKey(sessionId), "all");
  return [view, (v) => setView(v)];
}

export function chatView(sessionId: string): ChatView {
  return (useCardStore.getState().values.get(viewKey(sessionId)) as ChatView | undefined) ?? "all";
}

export function setChatView(sessionId: string, view: ChatView) {
  useCardStore.getState().set(viewKey(sessionId), view);
}

export interface FilteredItems {
  items: ChatItem[];
  /** keys of answers that open a turn (a prompt came before them): they get Claude's marker and the turn spacing */
  turnStarts: ReadonlySet<string>;
}

/**
 * The rows of a view. Prompts are the user's messages (also those FORGE sent); answers are Claude's texts
 * of the main conversation, tool calls and FORGE's cards are left out.
 */
export function filterChatItems(items: ChatItem[], view: ChatView): FilteredItems {
  if (view === "all") return { items, turnStarts: EMPTY };
  const out: ChatItem[] = [];
  const turnStarts = new Set<string>();
  let afterPrompt = true;
  for (const it of items) {
    if (it.kind === "user") {
      afterPrompt = true;
      if (view === "prompts") out.push(it);
    } else if (it.kind === "assistant" && view === "answers" && it.text.trim()) {
      if (afterPrompt) turnStarts.add(it.key);
      afterPrompt = false;
      out.push(it);
    }
  }
  return { items: out, turnStarts };
}

const EMPTY: ReadonlySet<string> = new Set();

/** Three small buttons in the chat's header. */
export function ChatViewToggle({ sessionId, compact }: { sessionId: string; compact: boolean }) {
  const [view, setView] = useChatView(sessionId);
  return (
    <div role="radiogroup" aria-label={t.chat.view.group} className="flex shrink-0 items-center rounded-md border border-border p-0.5">
      {CHAT_VIEWS.map((v) => (
        <Tooltip key={v.id} content={v.title}>
          <button
            type="button"
            role="radio"
            aria-checked={view === v.id}
            aria-label={v.label}
            onClick={() => setView(v.id)}
            className={cn(
              "flex h-6 items-center gap-1 rounded px-1.5 text-caption-lg transition-colors",
              view === v.id ? "bg-surface-3 text-fg" : "text-muted hover:text-fg",
            )}
          >
            <v.Icon className="h-3.5 w-3.5" />
            {!compact && v.id !== "all" && <span>{v.label}</span>}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

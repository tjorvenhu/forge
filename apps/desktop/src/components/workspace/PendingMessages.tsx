import { FileText } from "lucide-react";
import type { PendingMessage } from "@/stores/pending-messages";
import { ChatRow } from "./ChatRow";
import { UserAvatar } from "./UserMessage";
import { t } from "@/i18n";

/** Messages on their way to Claude: they look like sent ones, a little dimmer, until the real one arrives. */
export function PendingMessages({ items }: { items: PendingMessage[] }) {
  return (
    <div className="flex w-full flex-col gap-3 px-6 pt-8">
      {items.map((m) => (
        <div key={m.id} className="-mx-3 animate-slide-up-in rounded-md bg-surface-2 px-3 py-2.5 opacity-70" aria-busy>
          <ChatRow className="text-ui leading-[1.65]" marker={<UserAvatar />}>
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                {m.files.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption leading-normal">
                    {m.files.map((f, i) => (
                      <span key={i} className="flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-muted">
                        <FileText className="h-3 w-3" />
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <span className="ml-auto flex h-[1lh] shrink-0 items-center text-caption text-subtle">
                <span className="animate-soft-pulse">{t.chat.pending.sending}</span>
              </span>
            </div>
          </ChatRow>
        </div>
      ))}
    </div>
  );
}

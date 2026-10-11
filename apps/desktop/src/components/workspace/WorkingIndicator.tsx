import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import type { BackgroundTask } from "@forge/protocol";
import { Kbd } from "@/components/ui/misc";
import { ChatRow } from "./ChatRow";
import { ClaudeMark } from "./ClaudeMark";
import { formatElapsed, pickPhrase } from "./working";

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Commands Claude left running in the background; it picks the session up again when they finish. */
export function BackgroundIndicator({ tasks }: { tasks: BackgroundTask[] }) {
  const now = useNow();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-0.5 px-6 pb-4 text-small">
      {tasks.map((t) => (
        <ChatRow key={t.taskId} marker={<Hourglass className="animate-soft-pulse h-3.5 w-3.5 text-accent" />}>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-fg" title={t.description}>
              Im Hintergrund: {t.description}
            </span>
            <span className="shrink-0 tabular-nums text-subtle">seit {formatElapsed(now - new Date(t.startedAt).getTime())}</span>
          </div>
        </ChatRow>
      ))}
      <ChatRow>
        <span className="text-subtle">Claude meldet sich in dieser Session, sobald {tasks.length === 1 ? "die Aufgabe" : "eine Aufgabe"} fertig ist.</span>
      </ChatRow>
    </div>
  );
}

/** Activity line under the chat while a turn runs, like the spinner line of the Claude Code shell. */
export function WorkingIndicator({ startedAt }: { startedAt: string }) {
  const now = useNow();
  const elapsed = now - new Date(startedAt).getTime();
  return (
    <div className="mx-auto max-w-5xl px-6 pb-4 pt-1 text-small">
      <ChatRow
        marker={
          <span className="flex motion-safe:animate-spin-slow">
            <ClaudeMark size={13} />
          </span>
        }
      >
        <span className="font-medium text-claude">{pickPhrase(startedAt, elapsed)} …</span>{" "}
        <span className="tabular-nums text-subtle">
          ({formatElapsed(elapsed)} · <Kbd>Esc</Kbd> zum Unterbrechen)
        </span>
      </ChatRow>
    </div>
  );
}

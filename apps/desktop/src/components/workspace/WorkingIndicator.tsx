import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import type { BackgroundTask } from "@forge/protocol";
import { Kbd } from "@/components/ui/misc";
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
    <div className="mx-auto flex max-w-4xl flex-col gap-1 px-6 pb-4 text-xs text-muted">
      {tasks.map((t) => (
        <div key={t.taskId} className="flex items-center gap-2">
          <Hourglass className="animate-soft-pulse h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="min-w-0 truncate text-fg" title={t.description}>
            Im Hintergrund: {t.description}
          </span>
          <span className="shrink-0 tabular-nums text-subtle">(seit {formatElapsed(now - new Date(t.startedAt).getTime())})</span>
        </div>
      ))}
      <div className="pl-5.5 text-subtle">Claude meldet sich in dieser Session, sobald {tasks.length === 1 ? "die Aufgabe" : "eine Aufgabe"} fertig ist.</div>
    </div>
  );
}

/** Activity line under the chat while a turn runs: a changing phrase and the time since the turn started. */
export function WorkingIndicator({ startedAt }: { startedAt: string }) {
  const now = useNow();
  const elapsed = now - new Date(startedAt).getTime();
  return (
    <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 pb-4 text-xs text-muted">
      <span className="animate-soft-pulse h-2 w-2 rounded-full bg-accent" />
      <span className="text-fg">{pickPhrase(startedAt, elapsed)} …</span>
      <span className="tabular-nums text-subtle">
        ({formatElapsed(elapsed)} · <Kbd>Esc</Kbd> stoppt)
      </span>
    </div>
  );
}

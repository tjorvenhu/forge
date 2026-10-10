import { useEffect, useState } from "react";
import { Kbd } from "@/components/ui/misc";
import { formatElapsed, pickPhrase } from "./working";

/** Activity line under the chat while a turn runs: a changing phrase and the time since the turn started. */
export function WorkingIndicator({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
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

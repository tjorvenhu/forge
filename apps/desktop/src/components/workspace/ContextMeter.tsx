import { Shrink } from "lucide-react";
import type { ContextUsage } from "@forge/protocol";
import { cn, formatTokens } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";

/** From here on the meter warns; Claude Code compacts on its own near the limit. */
const WARN_AT = 70;
const DANGER_AT = 90;

export function contextTone(percentage: number): "ok" | "warn" | "danger" {
  return percentage >= DANGER_AT ? "danger" : percentage >= WARN_AT ? "warn" : "ok";
}

/**
 * How full the context window is after the last turn, with a button for /compact.
 * Compacting replaces the history with a summary, so it is offered, never done automatically here.
 */
export function ContextMeter({ usage, onCompact, disabled }: { usage: ContextUsage; onCompact: () => void; disabled: boolean }) {
  const pct = Math.max(0, Math.round(usage.percentage));
  const tone = contextTone(pct);
  const used = usage.categories.filter((c) => c.kind === "used").sort((a, b) => b.tokens - a.tokens);
  return (
    <div className="flex items-center gap-1">
      <Tooltip
        content={
          <div className="space-y-1 py-0.5">
            <div className="font-medium">
              Kontext: {formatTokens(usage.totalTokens)} von {formatTokens(usage.maxTokens)} Tokens ({pct} %)
            </div>
            {used.slice(0, 6).map((c) => (
              <div key={c.name} className="flex justify-between gap-4 text-muted">
                <span>{c.name}</span>
                <span className="tabular-nums">{formatTokens(c.tokens)}</span>
              </div>
            ))}
            {tone !== "ok" && <div className="pt-1 text-warning">Wird es knapp, fasst Claude Code den Verlauf selbst zusammen. Mit Komprimieren geht das sofort.</div>}
          </div>
        }
      >
        <div className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-caption text-muted" aria-label={`Kontext zu ${pct} Prozent belegt`} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-3">
            <div
              className={cn("h-full rounded-full", tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-accent")}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
          <span className={cn("tabular-nums", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warning" : "")}>{pct} %</span>
        </div>
      </Tooltip>
      <Tooltip content="Verlauf zusammenfassen, um Platz im Kontext zu schaffen (/compact)">
        <Button size="icon-sm" variant="ghost" onClick={onCompact} disabled={disabled} aria-label="Kontext komprimieren">
          <Shrink className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}

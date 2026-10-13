import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useTokenRate } from "@/stores/token-rate";

/** seconds of history in the sparkline */
const HISTORY = 30;

/** Last HISTORY seconds of the rate, one value per second, oldest first. */
function useHistory(): number[] {
  const [history, setHistory] = useState<number[]>(() => Array<number>(HISTORY).fill(0));
  useEffect(() => {
    const t = setInterval(() => setHistory((h) => [...h.slice(1), useTokenRate.getState().perSecond]), 1000);
    return () => clearInterval(t);
  }, []);
  return history;
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const step = 100 / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(20 - (v / max) * 18 - 1).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 20" preserveAspectRatio="none" className="h-4 w-full text-accent" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Output tokens per second of everything FORGE runs with Claude: sessions, subagents, agents, phone. */
export function TokenRate() {
  const perSecond = useTokenRate((s) => s.perSecond);
  const history = useHistory();
  const active = perSecond > 0 || history.some((v) => v > 0);
  return (
    <div className="w-full" title="Ausgegebene Tokens pro Sekunde, über alle Sessions, Subagenten, Agenten und das Telefon">
      <div className="mb-0.5 flex justify-between text-caption">
        <span className="text-muted">Ausgabe</span>
        <span className={cn("tabular-nums", perSecond > 0 ? "text-fg" : "text-subtle")}>{perSecond.toLocaleString("de-DE")} Token/s</span>
      </div>
      <div className={cn("transition-opacity duration-300", active ? "opacity-100" : "opacity-30")}>
        <Sparkline values={history} />
      </div>
    </div>
  );
}

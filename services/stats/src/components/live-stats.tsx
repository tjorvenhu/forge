"use client";

import { useEffect, useState } from "react";
import type { Online, Totals } from "@/lib/db";
import { formatCount, formatDateTime } from "@/lib/format";
import { Group, LiveDot, Row, SectionTitle, Tile } from "./blocks";
import { StatsCharts } from "./charts";
import { AnimatedNumber } from "./motion";
import { TOKEN_ROWS, tiles } from "./tiles";

/** The online count is cheap and changes often; the totals are cached for five minutes on the server anyway. */
const ONLINE_EVERY_MS = 30_000;
const TOTALS_EVERY_MS = 5 * 60_000;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Keeps the numbers current while the tab is visible: the online count every 30 seconds, the rest every 5 minutes. */
function useLiveTotals(initial: Totals): Totals {
  const [totals, setTotals] = useState(initial);
  useEffect(() => {
    let lastTotals = Date.now();
    const refresh = async () => {
      if (document.hidden) return;
      const due = Date.now() - lastTotals >= TOTALS_EVERY_MS;
      const [t, live] = await Promise.all([due ? getJson<Totals>("/api/v1/totals") : null, getJson<Online>("/api/v1/live")]);
      if (t) lastTotals = Date.now();
      // The online count of the totals can be five minutes old; the live one wins.
      setTotals((old) => {
        const next = t ?? old;
        if (!live) return next;
        const byPlan = new Map(live.plans.map((p) => [p.plan, p.online]));
        return { ...next, onlineInstalls: live.onlineInstalls, plans: next.plans.map((p) => ({ ...p, online: byPlan.get(p.plan) ?? 0 })) };
      });
    };
    // The page may come from the five-minute cache: fetch the online count right away.
    void refresh();
    const timer = setInterval(() => void refresh(), ONLINE_EVERY_MS);
    // Back in the tab: catch up at once instead of waiting for the next tick.
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return totals;
}

export function LiveStats({ initial }: { initial: Totals }) {
  const totals = useLiveTotals(initial);
  const online = totals.onlineInstalls > 0;

  return (
    <>
      <section aria-labelledby="figures">
        <SectionTitle
          action={
            <span className="section-meta">
              <span className={online ? "live-badge live-badge-on" : "live-badge"} title="Die Zahlen aktualisieren sich von selbst">
                <LiveDot on={online} />
                Live
              </span>
              Stand {formatDateTime(totals.updatedAt)} Uhr
            </span>
          }
        >
          <span id="figures">Kennzahlen</span>
        </SectionTitle>
        <div className="tiles">
          {tiles(totals).map(({ value, format, ...t }, i) => (
            <Tile key={t.label} {...t} index={i} value={<AnimatedNumber value={value} format={format} />} />
          ))}
        </div>
        <p className="tiles-note">
          Modelle und Kosten melden erst neuere FORGE-Versionen. Claude-Aufrufe davor zählen bei Tokens und Durchläufen, fehlen aber im Wert in API-Preisen. Der größte Teil der
          Tokens kommt aus dem Prompt-Cache, der nur einen Bruchteil neuer Eingabe kostet.
        </p>
      </section>

      <StatsCharts totals={totals} />

      <Group title="Tokens im Detail" description="Alle Claude-Anfragen aus FORGE, nach Art der Tokens">
        {TOKEN_ROWS.map((r) => (
          <Row key={r.key} icon={r.icon} label={r.label} description={r.description}>
            <AnimatedNumber value={totals.counters[r.key]} format={formatCount} />
          </Row>
        ))}
      </Group>
    </>
  );
}

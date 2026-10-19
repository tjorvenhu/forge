"use client";

import { useEffect, useState } from "react";
import type { Online, Totals } from "@/lib/db";
import { LiveDot, Stat } from "./blocks";
import { StatsCharts } from "./charts";
import { useI18n } from "./locale";
import { AnimatedNumber } from "./motion";
import { tiles } from "./tiles";

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
        return live ? { ...next, onlineInstalls: live.onlineInstalls } : next;
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
  const { locale, t, f } = useI18n();
  const online = totals.onlineInstalls > 0;

  return (
    <>
      <div className="stats-meta">
        <span className={online ? "live-badge live-badge-on" : "live-badge"} title={t.stats.liveTitle}>
          <LiveDot on={online} />
          {t.stats.live}
        </span>
        <span>{t.stats.updated(f.dateTime(totals.updatedAt))}</span>
      </div>
      <div className="stats-grid">
        {tiles(totals, locale).map(({ value, format, ...s }, i) => (
          <Stat key={s.label} {...s} index={i} value={<AnimatedNumber value={value} format={format} />} />
        ))}
      </div>
      <StatsCharts totals={totals} />
    </>
  );
}

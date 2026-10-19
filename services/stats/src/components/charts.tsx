"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import type { Totals } from "@/lib/db";
import { groupModels } from "@/lib/models";
import { Skeleton } from "./blocks";
import { useI18n } from "./locale";
import { Reveal } from "./motion";

// Charts after the daily report of the app (apps/desktop/src/components/report/usage-charts.tsx): cards
// with title and subtitle, columns from one baseline with a tooltip, horizontal bars.

/** Height of the plot area; the x-axis band comes on top. */
const PLOT_H = 132;
/** Horizontal bars shown; the rest is one line of text. */
const MAX_BARS = 6;

/** Clean 1-2-5 steps for an axis up to `max`. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const steps = Array.from({ length: 13 }, (_, i) => [1, 2, 5].map((s) => s * 10 ** i)).flat();
  const step = steps.find((s) => max / s <= 4) ?? steps[steps.length - 1]!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

function ChartCard({ title, sub, wide, children }: { title: string; sub: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className={wide ? "chart-card chart-card-wide" : "chart-card"} aria-label={title}>
      <div className="chart-head">
        <h3>{title}</h3>
        <p>{sub}</p>
      </div>
      {children}
    </section>
  );
}

interface Column {
  key: string;
  value: number;
  /** tooltip: the value first, then what it belongs to */
  tip: [value: string, label: string];
  /** x-axis label under this column; null leaves the slot empty */
  axis: string | null;
}

/** Vertical columns from one baseline, at most 24px wide with a 2px gap, hairline grid, tooltip on hover and focus. */
function Columns({ columns }: { columns: Column[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const { t, f } = useI18n();
  const max = Math.max(0, ...columns.map((c) => c.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]! || 1;
  const y = (v: number) => PLOT_H - (v / top) * PLOT_H;
  const tip = hover !== null ? columns[hover] : null;
  const align = hover === null ? "" : hover < columns.length * 0.15 ? " tip-start" : hover >= columns.length * 0.85 ? " tip-end" : "";
  return (
    <div className="columns">
      <div className="y-axis" style={{ height: PLOT_H }} aria-hidden>
        {ticks.map((v) => (
          <span key={v} style={{ top: y(v) }}>
            {f.count(v)}
          </span>
        ))}
      </div>
      <div className="plot-wrap">
        <div className="plot" style={{ height: PLOT_H }}>
          {ticks.map((v) => (
            <div key={v} className="gridline" style={{ top: y(v) }} aria-hidden />
          ))}
          {max === 0 ? (
            <p className="chart-empty plot-empty">{t.stats.charts.empty}</p>
          ) : (
            <div className="bars" onPointerLeave={() => setHover(null)}>
              {columns.map((c, i) => (
                <div
                  key={c.key}
                  className={`col${hover === i ? " col-hover" : ""}${i === columns.length - 1 ? " col-latest" : ""}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${c.tip[1]}: ${c.tip[0]}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  <span className="col-bar" style={{ height: c.value > 0 ? Math.max(2, (c.value / top) * PLOT_H) : 0, "--i": i } as CSSProperties} />
                </div>
              ))}
            </div>
          )}
          {tip && hover !== null && (
            <div role="tooltip" className={`tooltip${align}`} style={{ left: `${((hover + 0.5) / columns.length) * 100}%`, top: Math.max(0, y(tip.value) - 6) }}>
              <div className="tooltip-value">{tip.tip[0]}</div>
              <div className="tooltip-label">{tip.tip[1]}</div>
            </div>
          )}
        </div>
        <div className="x-axis" aria-hidden>
          {columns.map((c) => (
            <span key={c.key}>{c.axis ?? ""}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Bar {
  key: string;
  label: string;
  value: number;
  valueText: string;
  detail: string;
}

/** Horizontal bars with the value at the end of the label line; hover and focus show the details. */
function Bars({ bars, more }: { bars: Bar[]; more: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const { t } = useI18n();
  const max = Math.max(1, ...bars.map((b) => b.value));
  if (!bars.length) return <p className="chart-empty bars-empty">{t.stats.charts.empty}</p>;
  return (
    <ul className="hbars" onPointerLeave={() => setHover(null)}>
      {bars.map((b, i) => {
        const width = Math.max(1, (b.value / max) * 100);
        return (
          <li
            key={b.key}
            className={hover === b.key ? "hbar hbar-hover" : "hbar"}
            tabIndex={0}
            aria-label={`${b.label}: ${b.valueText}, ${b.detail}`}
            onPointerEnter={() => setHover(b.key)}
            onFocus={() => setHover(b.key)}
            onBlur={() => setHover(null)}
          >
            <div className="hbar-line">
              <span className="hbar-label">{b.label}</span>
              <span className="hbar-value">{b.valueText}</span>
            </div>
            <div className="hbar-track">
              <div className="hbar-fill" style={{ width: `${width}%`, "--i": i } as CSSProperties} />
              {hover === b.key && (
                <div role="tooltip" className={`tooltip tooltip-bar${width > 70 ? " tip-end" : width < 30 ? " tip-start" : ""}`} style={{ left: `${width}%` }}>
                  <div className="tooltip-value">{b.valueText}</div>
                  <div className="tooltip-label">{b.detail}</div>
                </div>
              )}
            </div>
          </li>
        );
      })}
      {more > 0 && <li className="hbars-more">{t.stats.charts.more(more)}</li>}
    </ul>
  );
}

export function StatsCharts({ totals }: { totals: Totals }) {
  const { t, f } = useI18n();
  const m = t.stats.charts;
  const turns = (n: number) => m.turns(n, f.count(n));
  const installs = (n: number) => m.installs(n, f.count(n));
  const history = totals.history;
  const today = history[history.length - 1]?.day;
  const dayName = (day: string) => (day === today ? m.today(f.dayLong(day)) : f.dayLong(day));
  // Every 7th day counted back from today carries an axis label.
  const axis = (i: number, day: string) => ((history.length - 1 - i) % 7 === 0 ? f.dayShort(day) : null);

  const models = groupModels(totals.models);
  const modelTokens = models.reduce((n, row) => n + row.tokens, 0);

  return (
    <Reveal className="charts">
      <ChartCard title={m.tokensPerDay} sub={m.tokensPerDaySub}>
        <Columns
          columns={history.map((d, i) => ({
            key: d.day,
            value: d.tokens,
            tip: [m.tokens(f.count(d.tokens)), `${dayName(d.day)} · ${turns(d.claudeTurns)}`],
            axis: axis(i, d.day),
          }))}
        />
      </ChartCard>
      <ChartCard title={m.activePerDay} sub={m.activePerDaySub}>
        <Columns
          columns={history.map((d, i) => ({
            key: d.day,
            value: d.activeInstalls,
            tip: [installs(d.activeInstalls), dayName(d.day)],
            axis: axis(i, d.day),
          }))}
        />
      </ChartCard>
      <ChartCard wide title={m.tokensByModel} sub={m.tokensByModelSub}>
        <Bars
          more={Math.max(0, models.length - MAX_BARS)}
          bars={models.slice(0, MAX_BARS).map((row) => ({
            key: row.label,
            label: row.label,
            value: row.tokens,
            valueText: f.count(row.tokens),
            detail: m.modelDetail(f.percent(row.tokens, modelTokens)),
          }))}
        />
      </ChartCard>
    </Reveal>
  );
}

// Keys into the chart texts, so the skeleton shows the same titles as the charts.
const CARDS = [
  { key: "tokensPerDay", kind: "columns" },
  { key: "activePerDay", kind: "columns" },
  { key: "tokensByModel", kind: "bars" },
] as const;

/** Placeholder in the shape of the charts: same titles, columns and bars at the same heights. */
export function ChartsSkeleton() {
  const { t } = useI18n();
  return (
    <div className="charts" aria-busy>
      {CARDS.map((card, c) => (
        <section key={card.key} className={card.kind === "bars" ? "chart-card chart-card-wide" : "chart-card"} aria-label={t.stats.charts[card.key]}>
          <div className="chart-head">
            <h3>{t.stats.charts[card.key]}</h3>
            <p>
              <Skeleton width={`${40 + c * 10}%`} />
            </p>
          </div>
          {card.kind === "columns" ? (
            <div className="columns">
              <div className="y-axis" style={{ height: PLOT_H }} />
              <div className="plot-wrap">
                <div className="bars" style={{ position: "relative", height: PLOT_H }}>
                  {Array.from({ length: 30 }, (_, i) => (
                    <div key={i} className="col">
                      <span className="col-bar skeleton-bar" style={{ height: `${12 + ((i * 37 + c * 11) % 70)}%` }} />
                    </div>
                  ))}
                </div>
                <div className="x-axis" />
              </div>
            </div>
          ) : (
            <ul className="hbars">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="hbar">
                  <div className="hbar-line">
                    <span className="hbar-label">
                      <Skeleton width={`${30 + ((i * 13) % 25)}%`} />
                    </span>
                  </div>
                  <div className="hbar-track">
                    <div className="hbar-fill skeleton-bar" style={{ width: `${90 - i * 22}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

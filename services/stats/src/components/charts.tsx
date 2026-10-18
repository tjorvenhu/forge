"use client";

import { useState, type ReactNode } from "react";
import { BarChart3, Table2 } from "lucide-react";
import type { Totals } from "@/lib/db";
import { formatCount, formatDayLong, formatDayShort, formatUsd } from "@/lib/format";
import { groupModels } from "@/lib/models";
import { planLabel, sortPlans } from "@/lib/plans";
import { newestVersion } from "@/lib/versions";
import { SectionTitle, Skeleton } from "./blocks";

// Charts after the daily report of the app (apps/desktop/src/components/report/usage-charts.tsx): cards
// with title, subtitle and a table twin, columns from one baseline with a tooltip, horizontal bars.

/** Height of the plot area; the x-axis band comes on top. */
const PLOT_H = 132;
/** Horizontal bars shown before the rest moves to the table. */
const MAX_BARS = 6;
const EMPTY = "Noch keine Daten für diesen Zeitraum";

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

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n === 1 ? one : many}`;

function ChartCard({ title, sub, rows, wide, children }: { title: string; sub: ReactNode; rows: Array<[string, string]>; wide?: boolean; children: ReactNode }) {
  const [table, setTable] = useState(false);
  return (
    <section className={wide ? "chart-card chart-card-wide" : "chart-card"} aria-label={title}>
      <div className="chart-head">
        <div className="chart-titles">
          <h3>{title}</h3>
          <p>{sub}</p>
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={table ? `${title} als Diagramm` : `${title} als Tabelle`}
          title={table ? "Als Diagramm" : "Als Tabelle"}
          aria-pressed={table}
          onClick={() => setTable(!table)}
        >
          {table ? <BarChart3 aria-hidden /> : <Table2 aria-hidden />}
        </button>
      </div>
      {table ? (
        <div className="chart-table">
          {rows.length ? (
            <table>
              <tbody>
                {rows.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="chart-empty">{EMPTY}</p>
          )}
        </div>
      ) : (
        children
      )}
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
            {formatCount(v)}
          </span>
        ))}
      </div>
      <div className="plot-wrap">
        <div className="plot" style={{ height: PLOT_H }}>
          {ticks.map((v) => (
            <div key={v} className="gridline" style={{ top: y(v) }} aria-hidden />
          ))}
          {max === 0 ? (
            <p className="chart-empty plot-empty">{EMPTY}</p>
          ) : (
            <div className="bars" onPointerLeave={() => setHover(null)}>
              {columns.map((c, i) => (
                <div
                  key={c.key}
                  className={hover === i ? "col col-hover" : "col"}
                  tabIndex={0}
                  role="img"
                  aria-label={`${c.tip[1]}: ${c.tip[0]}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  <span className="col-bar" style={{ height: c.value > 0 ? Math.max(2, (c.value / top) * PLOT_H) : 0 }} />
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
  /** small text next to the label, e.g. "neueste" */
  tag?: string;
  value: number;
  valueText: string;
  detail: string;
  /** the bar the chart is about; the others step back to gray */
  emphasis?: boolean;
}

/** Horizontal bars with the value at the end of the label line; hover and focus show the details. */
function Bars({ bars, emphasize, more }: { bars: Bar[]; emphasize?: boolean; more: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, ...bars.map((b) => b.value));
  if (!bars.length) return <p className="chart-empty bars-empty">{EMPTY}</p>;
  return (
    <ul className="hbars" onPointerLeave={() => setHover(null)}>
      {bars.map((b) => {
        const width = Math.max(1, (b.value / max) * 100);
        const muted = emphasize && !b.emphasis;
        return (
          <li
            key={b.key}
            className={hover === b.key ? "hbar hbar-hover" : "hbar"}
            tabIndex={0}
            aria-label={`${b.label}${b.tag ? ` (${b.tag})` : ""}: ${b.valueText}, ${b.detail}`}
            onPointerEnter={() => setHover(b.key)}
            onFocus={() => setHover(b.key)}
            onBlur={() => setHover(null)}
          >
            <div className="hbar-line">
              <span className="hbar-label">{b.label}</span>
              {b.tag && <span className="hbar-tag">{b.tag}</span>}
              <span className="hbar-value">{b.valueText}</span>
            </div>
            <div className="hbar-track">
              <div className={muted ? "hbar-fill hbar-fill-muted" : "hbar-fill"} style={{ width: `${width}%` }} />
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
      {more > 0 && <li className="hbars-more">und {more} weitere, siehe Tabelle</li>}
    </ul>
  );
}

const percent = (part: number, whole: number) => `${whole ? Math.round((part / whole) * 100) : 0} %`;

export function StatsCharts({ totals }: { totals: Totals }) {
  const history = totals.history;
  const today = history[history.length - 1]?.day;
  const dayName = (day: string) => `${formatDayLong(day)}${day === today ? ", heute" : ""}`;
  // Every 7th day counted back from today carries an axis label.
  const axis = (i: number, day: string) => ((history.length - 1 - i) % 7 === 0 ? formatDayShort(day) : null);
  const tokenSum = history.reduce((n, d) => n + d.tokens, 0);
  const peakActive = history.reduce((n, d) => Math.max(n, d.activeInstalls), 0);

  const models = groupModels(totals.models);
  const modelTokens = models.reduce((n, m) => n + m.tokens, 0);
  const versions = totals.versions;
  const versionInstalls = versions.reduce((n, v) => n + v.installs, 0);
  const newest = newestVersion(versions);
  const plans = sortPlans(totals.plans);
  const planInstalls = plans.reduce((n, p) => n + p.installs, 0);
  const planDetail = (p: (typeof plans)[number]) =>
    `${percent(p.installs, planInstalls)} der aktiven Installationen · ${formatCount(p.online)} gerade online${p.plan ? "" : " · ältere FORGE-Version oder ohne Claude-Abo"}`;

  return (
    <>
      <section aria-labelledby="history">
        <SectionTitle>
          <span id="history">Letzte 30 Tage</span>
        </SectionTitle>
        <div className="charts">
          <ChartCard
            title="Tokens pro Tag"
            sub={tokenSum ? `Alle Token-Arten, zusammen ${formatCount(tokenSum)}` : "Alle Token-Arten, Tage in UTC"}
            rows={[...history].reverse().map((d) => [dayName(d.day), `${formatCount(d.tokens)} Tokens, ${plural(d.claudeTurns, "Durchlauf", "Durchläufe")}`])}
          >
            <Columns
              columns={history.map((d, i) => ({
                key: d.day,
                value: d.tokens,
                tip: [`${formatCount(d.tokens)} Tokens`, `${dayName(d.day)} · ${plural(d.claudeTurns, "Durchlauf", "Durchläufe")}`],
                axis: axis(i, d.day),
              }))}
            />
          </ChartCard>
          <ChartCard
            title="Aktive Installationen pro Tag"
            sub={peakActive ? `Mit Meldung am Tag, höchstens ${formatCount(peakActive)}` : "Installationen mit Meldung am Tag"}
            rows={[...history].reverse().map((d) => [dayName(d.day), plural(d.activeInstalls, "Installation", "Installationen")])}
          >
            <Columns
              columns={history.map((d, i) => ({
                key: d.day,
                value: d.activeInstalls,
                tip: [plural(d.activeInstalls, "Installation", "Installationen"), dayName(d.day)],
                axis: axis(i, d.day),
              }))}
            />
          </ChartCard>
        </div>
      </section>

      <section aria-labelledby="models">
        <SectionTitle>
          <span id="models">Modelle</span>
        </SectionTitle>
        <div className="charts">
          <ChartCard
            wide
            title="Tokens nach Modell"
            sub="Alle Token-Arten seit dem 17. Oktober 2026, nur neuere FORGE-Versionen melden Modelle"
            rows={models.map((m) => [m.label, `${formatCount(m.tokens)} Tokens, ${percent(m.tokens, modelTokens)}, ≈ ${formatUsd(m.costUsdCents)}`])}
          >
            <Bars
              more={Math.max(0, models.length - MAX_BARS)}
              bars={models.slice(0, MAX_BARS).map((m) => ({
                key: m.label,
                label: m.label,
                value: m.tokens,
                valueText: formatCount(m.tokens),
                detail: `${percent(m.tokens, modelTokens)} der Tokens · ≈ ${formatUsd(m.costUsdCents)}`,
              }))}
            />
          </ChartCard>
        </div>
      </section>

      <section aria-labelledby="distribution">
        <SectionTitle>
          <span id="distribution">Abos und Versionen</span>
        </SectionTitle>
        <div className="charts">
          <ChartCard
            title="Claude-Abos"
            sub="Aktive Installationen der letzten 30 Tage nach Abo des angemeldeten Kontos"
            rows={plans.map((p) => [planLabel(p.plan), `${plural(p.installs, "Installation", "Installationen")}, ${planDetail(p)}`])}
          >
            <Bars
              more={Math.max(0, plans.length - MAX_BARS)}
              bars={plans.slice(0, MAX_BARS).map((p) => ({
                key: p.plan ?? "",
                label: planLabel(p.plan),
                tag: p.online ? `${formatCount(p.online)} online` : undefined,
                value: p.installs,
                valueText: formatCount(p.installs),
                detail: planDetail(p),
              }))}
            />
          </ChartCard>
          <ChartCard
            title="FORGE-Versionen"
            sub="Aktive Installationen der letzten 30 Tage"
            rows={versions.map((v) => [v.version === newest ? `${v.version} (neueste)` : v.version, `${plural(v.installs, "Installation", "Installationen")}, ${percent(v.installs, versionInstalls)}`])}
          >
            <Bars
              emphasize
              more={Math.max(0, versions.length - MAX_BARS)}
              bars={versions.slice(0, MAX_BARS).map((v) => ({
                key: v.version,
                label: v.version,
                tag: v.version === newest ? "neueste" : undefined,
                emphasis: v.version === newest,
                value: v.installs,
                valueText: formatCount(v.installs),
                detail: `${percent(v.installs, versionInstalls)} der aktiven Installationen`,
              }))}
            />
          </ChartCard>
        </div>
      </section>
    </>
  );
}

const CARDS = [
  { section: "Letzte 30 Tage", cards: ["Tokens pro Tag", "Aktive Installationen pro Tag"], kind: "columns" },
  { section: "Modelle", cards: ["Tokens nach Modell"], kind: "bars" },
  { section: "Abos und Versionen", cards: ["Claude-Abos", "FORGE-Versionen"], kind: "bars" },
] as const;

/** Placeholder in the shape of the charts: same titles, columns and bars at the same heights. */
export function ChartsSkeleton() {
  return (
    <>
      {CARDS.map((s) => (
        <section key={s.section} aria-busy>
          <SectionTitle>{s.section}</SectionTitle>
          <div className="charts">
            {s.cards.map((title, c) => (
              <section key={title} className={s.cards.length === 1 ? "chart-card chart-card-wide" : "chart-card"} aria-label={title}>
                <div className="chart-head">
                  <div className="chart-titles">
                    <h3>{title}</h3>
                    <p>
                      <Skeleton width={`${50 + c * 15}%`} />
                    </p>
                  </div>
                  <span className="icon-btn" aria-hidden>
                    <Table2 />
                  </span>
                </div>
                {s.kind === "columns" ? (
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
        </section>
      ))}
    </>
  );
}

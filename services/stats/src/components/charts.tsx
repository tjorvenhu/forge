"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Box, Check, ChevronDown, Coins, MessagesSquare, Monitor } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Platform, Totals } from "@/lib/db";
import type { HistoryDay } from "@/lib/history";
import { groupModels } from "@/lib/models";
import { Skeleton } from "./blocks";
import { useI18n } from "./locale";
import { Reveal } from "./motion";

// The four cards of the live stats after the owner's mockup: tokens per day as columns, active
// installations as an area, the top models as share bars and the platforms as a ring.

/** Height of the plot area; the x-axis band comes below. */
const PLOT_H = 116;
/** Periods of the two day charts; the totals carry 30 days. */
const RANGES = [7, 14, 30] as const;
type Range = (typeof RANGES)[number];
/** Models with their own row; the rest is one row "Andere". */
const TOP_MODELS = 3;
/** Legend order of the platforms; all four are always listed. */
const PLATFORMS: Platform[] = ["windows", "macos", "linux", "other"];

/** Clean 1-2-5 steps for an axis up to `max`, at most four steps. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const steps = Array.from({ length: 13 }, (_, i) => [1, 2, 5].map((s) => s * 10 ** i)).flat();
  const step = steps.find((s) => max / s <= 3) ?? steps[steps.length - 1]!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

function ChartCard({ icon: Icon, title, sub, action, children }: { icon: LucideIcon; title: string; sub: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="chart-card" aria-label={title}>
      <div className="chart-head">
        <Icon className="chart-icon" aria-hidden />
        <div className="chart-title">
          <h3>{title}</h3>
          <p>{sub}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** "Letzte 30 Tage" with a small menu of the periods; closes on a click outside and on Escape. */
function RangeSelect({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const { t } = useI18n();
  const m = t.stats.charts;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="range" ref={root}>
      <button
        type="button"
        className="range-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${m.range}: ${m.lastDays(value)}`}
        onClick={() => setOpen((o) => !o)}
      >
        {m.lastDays(value)}
        <ChevronDown aria-hidden />
      </button>
      {open && (
        <div id={menuId} role="menu" className="range-menu" aria-label={m.range}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={r === value}
              className="range-item"
              onClick={() => {
                onChange(r);
                setOpen(false);
              }}
            >
              {m.lastDays(r)}
              {r === value && <Check aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Point {
  key: string;
  value: number;
  /** tooltip: the value first, then what it belongs to */
  tip: [value: string, label: string];
  /** x-axis label at this day; null leaves it out */
  axis: string | null;
}

/** Axis frame with gridlines both ways and a tooltip; inside either columns or a line with the area below it. */
function DayPlot({ points, kind, label }: { points: Point[]; kind: "columns" | "area"; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const { t, f } = useI18n();
  const n = points.length;
  const max = Math.max(0, ...points.map((p) => p.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1]! || 1;
  const y = (v: number) => PLOT_H - (v / top) * PLOT_H;
  const x = (i: number) => ((i + 0.5) / n) * 100;
  const tip = hover !== null ? points[hover] : null;
  const align = hover === null ? "" : hover < n * 0.15 ? " tip-start" : hover >= n * 0.85 ? " tip-end" : "";
  // The area follows the pointer over the whole plot; the columns are their own targets.
  const onAreaMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    setHover(Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - box.left) / box.width) * n))));
  };
  return (
    <div className="day-plot">
      <div className="y-axis" style={{ height: PLOT_H }} aria-hidden>
        {ticks.map((v) => (
          <span key={v} style={{ top: y(v) }}>
            {f.axis(v)}
          </span>
        ))}
      </div>
      <div className="plot-wrap">
        <div
          className="plot"
          style={{ height: PLOT_H }}
          onPointerMove={kind === "area" && max > 0 ? onAreaMove : undefined}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <div key={v} className="gridline" style={{ top: y(v) }} aria-hidden />
          ))}
          {points.map((p, i) => p.axis && <div key={p.key} className="gridline-v" style={{ left: `${x(i)}%` }} aria-hidden />)}
          {max === 0 ? (
            <p className="chart-empty plot-empty">{t.stats.charts.empty}</p>
          ) : kind === "columns" ? (
            <div className="bars">
              {points.map((p, i) => (
                <div
                  key={p.key}
                  className={`col${hover === i ? " col-hover" : ""}`}
                  tabIndex={0}
                  role="img"
                  aria-label={`${p.tip[1]}: ${p.tip[0]}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                >
                  <span className="col-bar" style={{ height: p.value > 0 ? Math.max(2, (p.value / top) * PLOT_H) : 0, "--i": i } as CSSProperties} />
                </div>
              ))}
            </div>
          ) : (
            <>
              <svg className="area" viewBox={`0 0 100 ${PLOT_H}`} preserveAspectRatio="none" role="img" aria-label={label}>
                <defs>
                  <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" className="area-stop" stopOpacity="0.42" />
                    <stop offset="1" className="area-stop" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path
                  className="area-fill"
                  d={`M${x(0)},${PLOT_H} ${points.map((p, i) => `L${x(i)},${y(p.value)}`).join(" ")} L${x(n - 1)},${PLOT_H} Z`}
                  fill="url(#area-fill)"
                />
                <path className="area-line" d={points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ")} vectorEffect="non-scaling-stroke" />
              </svg>
              <span className="area-dot" style={{ left: `${x(n - 1)}%`, top: y(points[n - 1]!.value) }} aria-hidden />
              {hover !== null && hover !== n - 1 && <span className="area-dot area-dot-hover" style={{ left: `${x(hover)}%`, top: y(points[hover]!.value) }} aria-hidden />}
            </>
          )}
          {tip && hover !== null && (
            <div role="tooltip" className={`tooltip${align}`} style={{ left: `${x(hover)}%`, top: Math.max(0, y(tip.value) - 8) }}>
              <div className="tooltip-value">{tip.tip[0]}</div>
              <div className="tooltip-label">{tip.tip[1]}</div>
            </div>
          )}
        </div>
        <div className="x-axis" aria-hidden>
          {points.map(
            (p, i) =>
              p.axis && (
                <span key={p.key} style={{ left: `${x(i)}%` }}>
                  {p.axis}
                </span>
              ),
          )}
        </div>
      </div>
    </div>
  );
}

/** "Claude Opus 4.7" for the known families; anything else as it came. */
const modelName = (label: string) => (/^(Opus|Sonnet|Haiku|Fable) /.test(label) ? `Claude ${label}` : label);

function TopModels({ totals }: { totals: Totals }) {
  const { t, f } = useI18n();
  const m = t.stats.charts;
  const rows = groupModels(totals.models);
  const total = rows.reduce((n, r) => n + r.tokens, 0);
  if (!total) return <p className="chart-empty card-empty">{m.empty}</p>;
  const shown =
    rows.length > TOP_MODELS + 1
      ? [...rows.slice(0, TOP_MODELS).map((r) => ({ label: modelName(r.label), tokens: r.tokens })), { label: m.otherModels, tokens: rows.slice(TOP_MODELS).reduce((n, r) => n + r.tokens, 0) }]
      : rows.map((r) => ({ label: modelName(r.label), tokens: r.tokens }));
  return (
    <ul className="shares">
      {shown.map((r, i) => (
        <li key={r.label} className="share" title={m.tokens(f.count(r.tokens))}>
          <span className="share-label">{r.label}</span>
          <span className="share-track" aria-hidden>
            <span className="share-fill" style={{ width: `${Math.max(1, (r.tokens / total) * 100)}%`, "--i": i } as CSSProperties} />
          </span>
          <span className="share-value">{f.percent(r.tokens, total)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Radius of the ring in a 42 x 42 box, chosen so its circumference is 100 and dash lengths are percentages. */
const RING_R = 15.9155;

function Platforms({ totals }: { totals: Totals }) {
  const { t, f } = useI18n();
  const m = t.stats.charts;
  const count = (p: Platform) => totals.platforms.find((r) => r.platform === p)?.installs ?? 0;
  const total = PLATFORMS.reduce((n, p) => n + count(p), 0);
  const parts = PLATFORMS.map((p) => ({ platform: p, share: total ? (count(p) / total) * 100 : 0 })).filter((s) => s.share > 0);
  // A small gap between segments, none when one platform has it all.
  const gap = parts.length > 1 ? 0.8 : 0;
  let start = 0;
  return (
    <div className="platforms">
      <div className="ring">
        <svg viewBox="0 0 42 42" aria-hidden>
          <circle className="ring-track" cx="21" cy="21" r={RING_R} />
          {parts.map((s) => {
            const offset = 25 - start - gap / 2;
            start += s.share;
            return (
              <circle
                key={s.platform}
                className={`ring-seg seg-${s.platform}`}
                cx="21"
                cy="21"
                r={RING_R}
                strokeDasharray={`${Math.max(0, s.share - gap)} ${100 - Math.max(0, s.share - gap)}`}
                strokeDashoffset={offset}
              />
            );
          })}
        </svg>
        <div className="ring-center">
          <span className="ring-value">{f.count(total)}</span>
          <span className="ring-label">{m.platformTotal(total)}</span>
        </div>
      </div>
      <ul className="legend">
        {PLATFORMS.map((p) => (
          <li key={p}>
            <i className={`legend-dot seg-${p}`} aria-hidden />
            <span className="legend-label">{m.platformNames[p]}</span>
            <span className="legend-value">{f.percent(count(p), total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Every day for a week, every second day for two weeks, else every 7th day counted back from today. */
const axisStep = (days: number) => (days <= 7 ? 1 : days <= 14 ? 2 : 7);

export function StatsCharts({ totals }: { totals: Totals }) {
  const { t, f } = useI18n();
  const m = t.stats.charts;
  const [tokensRange, setTokensRange] = useState<Range>(30);
  const [installsRange, setInstallsRange] = useState<Range>(30);
  const history = totals.history;
  const today = history[history.length - 1]?.day;
  const dayName = (day: string) => (day === today ? m.today(f.dayLong(day)) : f.dayLong(day));
  const points = (range: Range, value: (d: HistoryDay) => number, tip: (d: HistoryDay) => Point["tip"]): Point[] => {
    const days = history.slice(-range);
    return days.map((d, i) => ({ key: d.day, value: value(d), tip: tip(d), axis: (days.length - 1 - i) % axisStep(range) === 0 ? f.dayShort(d.day) : null }));
  };

  return (
    <Reveal className="charts">
      <ChartCard icon={Coins} title={m.tokensPerDay} sub={m.tokensPerDaySub} action={<RangeSelect value={tokensRange} onChange={setTokensRange} />}>
        <DayPlot
          kind="columns"
          label={m.tokensPerDay}
          points={points(
            tokensRange,
            (d) => d.tokens,
            (d) => [m.tokens(f.count(d.tokens)), `${dayName(d.day)} · ${m.turns(d.claudeTurns, f.count(d.claudeTurns))}`],
          )}
        />
      </ChartCard>
      <ChartCard icon={MessagesSquare} title={m.activePerDay} sub={m.activePerDaySub} action={<RangeSelect value={installsRange} onChange={setInstallsRange} />}>
        <DayPlot
          kind="area"
          label={m.activePerDay}
          points={points(
            installsRange,
            (d) => d.activeInstalls,
            (d) => [m.installs(d.activeInstalls, f.count(d.activeInstalls)), dayName(d.day)],
          )}
        />
      </ChartCard>
      <ChartCard icon={Box} title={m.topModels} sub={m.topModelsSub}>
        <TopModels totals={totals} />
      </ChartCard>
      <ChartCard icon={Monitor} title={m.platforms} sub={m.platformsSub}>
        <Platforms totals={totals} />
      </ChartCard>
    </Reveal>
  );
}

/** Placeholder in the shape of the four cards: same icons and titles, columns, bars and the ring in gray. */
export function ChartsSkeleton() {
  const { t } = useI18n();
  const m = t.stats.charts;
  const head = (Icon: LucideIcon, title: string, range: boolean) => (
    <div className="chart-head">
      <Icon className="chart-icon" aria-hidden />
      <div className="chart-title">
        <h3>{title}</h3>
        <p>
          <Skeleton width="11rem" />
        </p>
      </div>
      {range && <Skeleton width="128px" style={{ height: 36, borderRadius: 6 }} />}
    </div>
  );
  const plot = (seed: number) => (
    <div className="day-plot">
      <div className="y-axis" style={{ height: PLOT_H }} />
      <div className="plot-wrap">
        <div className="plot" style={{ height: PLOT_H }}>
          <div className="bars">
            {Array.from({ length: 30 }, (_, i) => (
              <div key={i} className="col">
                <span className="col-bar skeleton-bar" style={{ height: `${12 + ((i * 37 + seed * 11) % 70)}%` }} />
              </div>
            ))}
          </div>
        </div>
        <div className="x-axis" />
      </div>
    </div>
  );
  return (
    <div className="charts" aria-busy>
      <section className="chart-card" aria-label={m.tokensPerDay}>
        {head(Coins, m.tokensPerDay, true)}
        {plot(0)}
      </section>
      <section className="chart-card" aria-label={m.activePerDay}>
        {head(MessagesSquare, m.activePerDay, true)}
        {plot(1)}
      </section>
      <section className="chart-card" aria-label={m.topModels}>
        {head(Box, m.topModels, false)}
        <ul className="shares">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="share">
              <span className="share-label">
                <Skeleton width={`${55 + ((i * 13) % 30)}%`} />
              </span>
              <span className="share-track">
                <span className="share-fill skeleton-bar" style={{ width: `${70 - i * 18}%` }} />
              </span>
              <span className="share-value">
                <Skeleton width="2rem" />
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="chart-card" aria-label={m.platforms}>
        {head(Monitor, m.platforms, false)}
        <div className="platforms">
          <div className="ring">
            <svg viewBox="0 0 42 42" aria-hidden>
              <circle className="ring-track skeleton-ring" cx="21" cy="21" r={RING_R} />
            </svg>
          </div>
          <ul className="legend">
            {PLATFORMS.map((p) => (
              <li key={p}>
                <i className="legend-dot" aria-hidden />
                <span className="legend-label">{m.platformNames[p]}</span>
                <span className="legend-value">
                  <Skeleton width="2rem" />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

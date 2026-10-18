import { useState, type ReactNode } from "react";
import { BarChart3, Copy, Table2 } from "lucide-react";
import { forgeUsageLabel, formatDuration, formatTokens, type DailyReportUsage } from "@forge/protocol";
import { contextItems, copyText } from "@/lib/context-menu";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { dayLabel, shortDay } from "./report-days";

const ICON = "h-3.5 w-3.5";
const MIN = 60_000;
/** Height of the plot area; the x-axis band comes on top. */
const PLOT_H = 132;

/** Clean steps for an axis up to `max`: 1-2-5 for counts, whole minutes and hours for durations. */
export function niceTicks(max: number, kind: "duration" | "count"): number[] {
  if (max <= 0) return [0];
  const steps =
    kind === "duration"
      ? [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720].map((m) => m * MIN)
      : Array.from({ length: 13 }, (_, i) => [1, 2, 5].map((s) => s * 10 ** i)).flat();
  const step = steps.find((s) => max / s <= 4) ?? steps[steps.length - 1]!;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

/** A chart with title, its table twin (toggle and right-click) and a way to copy its values. */
function ChartCard({ title, sub, actions, rows, children, className }: { title: string; sub?: ReactNode; actions?: ReactNode; rows: Array<[string, string]>; children: ReactNode; className?: string }) {
  const [table, setTable] = useState(false);
  const copy = () => copyText(rows.map((r) => r.join("\t")).join("\n"));
  return (
    <section
      aria-label={title}
      className={cn("flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4", className)}
      onContextMenu={contextItems(() => [
        { label: table ? "Als Diagramm anzeigen" : "Als Tabelle anzeigen", icon: table ? <BarChart3 className={ICON} /> : <Table2 className={ICON} />, onSelect: () => setTable(!table) },
        { label: "Werte kopieren", icon: <Copy className={ICON} />, onSelect: copy },
      ])}
    >
      <div className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-medium text-fg">{title}</h3>
          {sub && <p className="text-caption text-muted">{sub}</p>}
        </div>
        {actions}
        <Tooltip content={table ? "Als Diagramm" : "Als Tabelle"}>
          <Button size="icon-sm" variant="ghost" aria-label={table ? `${title} als Diagramm` : `${title} als Tabelle`} aria-pressed={table} onClick={() => setTable(!table)}>
            {table ? <BarChart3 className={ICON} /> : <Table2 className={ICON} />}
          </Button>
        </Tooltip>
      </div>
      {table ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-small">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} className="border-b border-border last:border-0">
                  <td className="py-1 pr-3 text-muted">{k}</td>
                  <td className="py-1 text-right tabular-nums text-fg">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  /** the column the chart is about (selected day); the others step back */
  emphasis?: boolean;
}

/**
 * Vertical columns from one baseline, at most 24px wide with a 2px gap, hairline grid, tooltip on hover
 * and focus. One series: no legend, the card title names it.
 */
function Columns({ columns, kind, emphasize, onSelect }: { columns: Column[]; kind: "duration" | "count"; emphasize?: boolean; onSelect?: (key: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const ticks = niceTicks(Math.max(...columns.map((c) => c.value)), kind);
  const top = ticks[ticks.length - 1]! || 1;
  const tickLabel = (v: number) => (kind === "duration" ? (v ? formatDuration(v) : "0") : formatTokens(v));
  const tip = hover !== null ? columns[hover] : null;
  return (
    <div className="flex gap-2">
      <div className="relative w-12 shrink-0 text-right text-2xs tabular-nums text-subtle" style={{ height: PLOT_H }} aria-hidden>
        {ticks.map((v) => (
          <span key={v} className="absolute right-0 -translate-y-1/2 whitespace-nowrap" style={{ top: PLOT_H - (v / top) * PLOT_H }}>
            {tickLabel(v)}
          </span>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="relative" style={{ height: PLOT_H }}>
          {ticks.map((v) => (
            <div key={v} className="absolute inset-x-0 h-px bg-border" style={{ top: PLOT_H - (v / top) * PLOT_H }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]" onPointerLeave={() => setHover(null)}>
            {columns.map((c, i) => {
              const h = c.value > 0 ? Math.max(2, (c.value / top) * PLOT_H) : 0;
              const Tag = onSelect ? "button" : "div";
              return (
                <Tag
                  key={c.key}
                  type={onSelect ? "button" : undefined}
                  tabIndex={0}
                  aria-label={`${c.tip[1]}: ${c.tip[0]}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  onClick={onSelect ? () => onSelect(c.key) : undefined}
                  className={cn("group flex h-full min-w-0 flex-1 items-end justify-center focus:outline-none", onSelect && "cursor-pointer")}
                >
                  <span
                    className={cn(
                      "block w-full max-w-6 rounded-t-[4px] transition-colors group-focus-visible:ring-2 group-focus-visible:ring-fg/40",
                      emphasize && !c.emphasis ? "bg-border-strong group-hover:bg-subtle" : "bg-accent-strong group-hover:bg-accent",
                      hover === i && (emphasize && !c.emphasis ? "bg-subtle" : "bg-accent"),
                    )}
                    style={{ height: h }}
                  />
                </Tag>
              );
            })}
          </div>
          {tip && hover !== null && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-border-strong bg-surface-3 px-2 py-1 shadow-lg"
              style={{ left: `${((hover + 0.5) / columns.length) * 100}%`, top: Math.max(0, PLOT_H - (tip.value / top) * PLOT_H - 6) }}
            >
              <div className="text-small font-semibold text-fg">{tip.tip[0]}</div>
              <div className="text-caption text-muted">{tip.tip[1]}</div>
            </div>
          )}
        </div>
        <div className="mt-1.5 flex gap-[2px] text-2xs tabular-nums text-subtle" aria-hidden>
          {columns.map((c) => (
            <span key={c.key} className={cn("min-w-0 flex-1 overflow-visible whitespace-nowrap text-center", c.emphasis && emphasize && "font-medium text-fg")}>
              {c.axis ?? ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-caption text-muted">{label}</div>
      <div className="text-title-lg font-semibold text-fg">{value}</div>
      <div className="truncate text-caption text-subtle">{sub}</div>
    </div>
  );
}

const SPLIT = [
  { key: "out", label: "Von Claude geschrieben", className: "bg-accent-strong" },
  { key: "in", label: "Neu gelesen", className: "bg-tile-blue" },
] as const;

/**
 * Working time as the hero figure. Tokens: the new ones (written and read for the first time) as the big
 * number; the context read from the cache again on every request stays apart, with its average per request.
 */
export function UsageHeadline({ u }: { u: DailyReportUsage }) {
  const parts = { out: u.outputTokens, in: u.inputTokens + u.cacheWriteTokens };
  const fresh = parts.out + parts.in;
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <section aria-label="Arbeitszeit von Claude" className="rounded-xl border border-border bg-surface p-4">
        <div className="text-caption text-muted">Claude hat gearbeitet</div>
        <div className="mt-0.5 text-[48px] font-semibold leading-none tracking-tight text-fg">{formatDuration(u.workMs)}</div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <Kpi label="Uhrzeit aktiv" value={formatDuration(u.activeMs)} sub={u.peakParallel > 1 ? `bis zu ${u.peakParallel} gleichzeitig` : "nacheinander"} />
          <Kpi label="Agenten" value={formatDuration(u.agentWorkMs)} sub={u.workMs ? `${Math.round((u.agentWorkMs / u.workMs) * 100)} % der Zeit` : "keine"} />
          <Kpi label="Durchläufe" value={String(u.turns)} sub={u.apiCalls ? `${u.apiCalls} Anfragen an Claude` : u.turns ? `je ${formatDuration(u.workMs / u.turns)}` : "keine"} />
        </div>
      </section>
      <section aria-label="Tokens" className="flex flex-col rounded-xl border border-border bg-surface p-4">
        <div className="text-caption text-muted">Neue Tokens</div>
        <div className="mt-0.5 text-[48px] font-semibold leading-none tracking-tight text-fg">{formatTokens(fresh)}</div>
        <div className="mt-3 flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-surface-2" role="img" aria-label={SPLIT.map((x) => `${x.label} ${formatTokens(parts[x.key])}`).join(", ")}>
          {fresh > 0 &&
            SPLIT.map((x) => (parts[x.key] > 0 ? <span key={x.key} className={cn("h-full first:rounded-l-full last:rounded-r-full", x.className)} style={{ width: `${(parts[x.key] / fresh) * 100}%`, minWidth: 3 }} /> : null))}
        </div>
        <div className="mt-2.5 grid grid-cols-3 gap-3">
          {SPLIT.map((x) => (
            <div key={x.key} className="min-w-0">
              <div className="flex items-center gap-1.5 truncate text-caption text-muted">
                <span className={cn("h-2 w-2 shrink-0 rounded-[2px]", x.className)} aria-hidden />
                {x.label}
              </div>
              <div className="text-ui font-semibold text-fg">{formatTokens(parts[x.key])}</div>
              <div className="text-caption text-subtle">{fresh ? `${Math.round((parts[x.key] / fresh) * 100)} %` : "0 %"}</div>
            </div>
          ))}
          <div className="min-w-0 border-l border-border pl-3">
            <div className="truncate text-caption text-muted">Kontext aus dem Cache</div>
            <div className="text-ui font-semibold text-fg">{formatTokens(u.cacheReadTokens)}</div>
            <div className="truncate text-caption text-subtle">{u.apiCalls ? `Ø ${formatTokens(u.cacheReadTokens / u.apiCalls)} je Anfrage` : "nicht in der Summe"}</div>
          </div>
        </div>
        {u.cacheReadTokens > 0 && (
          <p className="mt-3 text-caption text-subtle">
            Bei jeder Anfrage liest Claude den bisherigen Verlauf erneut aus dem Cache. Das steht rechts für sich und ist nicht in den neuen Tokens enthalten.
          </p>
        )}
        {u.forge.calls > 0 && (
          <p className="mt-auto pt-2 text-caption text-subtle">
            Davon durch FORGE selbst: {formatTokens(u.forge.tokens)}
            {fresh ? ` (${Math.round((u.forge.tokens / fresh) * 100)} %)` : ""}, siehe unten.
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * What FORGE itself had Claude do (commit messages, titles, phone, messages it sent into sessions ...),
 * one bar per purpose by new tokens, with calls and time.
 */
function ForgeCard({ u }: { u: DailyReportUsage }) {
  const f = u.forge;
  const fresh = u.inputTokens + u.outputTokens + u.cacheWriteTokens;
  const max = Math.max(1, ...f.parts.map((p) => p.tokens));
  const share = fresh ? Math.round((f.tokens / fresh) * 100) : 0;
  return (
    <ChartCard
      title="Durch FORGE"
      sub={`${formatTokens(f.tokens)} neue Tokens, ${share} % des Tages, ${f.calls} ${f.calls === 1 ? "Aufruf" : "Aufrufe"}, ${formatDuration(f.workMs)}`}
      rows={f.parts.map((p) => [forgeUsageLabel(p.purpose), `${formatTokens(p.tokens)} neue Tokens, ${p.calls} ${p.calls === 1 ? "Aufruf" : "Aufrufe"}, ${formatDuration(p.workMs)}`])}
    >
      <ul className="flex flex-col gap-2.5">
        {f.parts.map((p) => (
          <li key={p.purpose} className="min-w-0">
            <div className="mb-1 flex items-baseline gap-2 text-small">
              <span className="min-w-0 flex-1 truncate text-fg">{forgeUsageLabel(p.purpose)}</span>
              <span className="shrink-0 tabular-nums text-fg">{formatTokens(p.tokens)}</span>
              <span className="w-24 shrink-0 text-right tabular-nums text-subtle">
                {p.calls} {p.calls === 1 ? "Aufruf" : "Aufrufe"}
              </span>
            </div>
            <div className="h-2 w-full rounded-r-[4px] bg-surface-2">
              <div className="h-full rounded-r-[4px] bg-accent-strong" style={{ width: `${Math.max(1, (p.tokens / max) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      {f.cacheReadTokens > 0 && <p className="mt-3 text-caption text-subtle">Dazu {formatTokens(f.cacheReadTokens)} Tokens Kontext aus dem Cache.</p>}
    </ChartCard>
  );
}

function hourLabel(h: number) {
  return `${String(h).padStart(2, "0")}:00`;
}

/**
 * The charts of the report: working time over the day, the last 14 days and per project. `onPickDay`
 * opens the report of a day from the trend.
 */
export function UsageCharts({ u, date, today, showProjects, onPickDay }: { u: DailyReportUsage; date: string; today: string; showProjects: boolean; onPickDay: (date: string) => void }) {
  const [trendKind, setTrendKind] = useState<"time" | "tokens">("time");
  const busyHours = u.hours.filter((h) => h.workMs > 0);
  const peak = busyHours.reduce<(typeof u.hours)[number] | null>((a, h) => (!a || h.workMs > a.workMs ? h : a), null);
  const projects = showProjects ? u.projects : [];
  const maxProject = Math.max(1, ...projects.map((p) => p.workMs));
  const cards = 1 + (projects.length > 1 ? 1 : 0) + (u.forge.calls > 0 ? 1 : 0);
  const avg = u.days.slice(0, -1).filter((d) => d.workMs > 0);
  const avgMs = avg.length ? avg.reduce((n, d) => n + d.workMs, 0) / avg.length : 0;
  const avgTokens = avg.length ? avg.reduce((n, d) => n + d.tokens, 0) / avg.length : 0;

  return (
    <div className="flex flex-col gap-3">
      <ChartCard
        title="Über den Tag"
        sub={peak ? `Arbeitszeit je Stunde, am meisten ${hourLabel(peak.hour)} bis ${hourLabel((peak.hour + 1) % 24)} mit ${formatDuration(peak.workMs)}` : "Arbeitszeit je Stunde"}
        rows={u.hours.map((h) => [`${hourLabel(h.hour)} bis ${hourLabel((h.hour + 1) % 24)}`, `${formatDuration(h.workMs)}, ${h.turns} Durchl., ${formatTokens(h.tokens)} neue Tokens`])}
      >
        <Columns
          kind="duration"
          columns={u.hours.map((h) => ({
            key: String(h.hour),
            value: h.workMs,
            tip: [formatDuration(h.workMs), `${hourLabel(h.hour)} bis ${hourLabel((h.hour + 1) % 24)} · ${h.turns} ${h.turns === 1 ? "Durchlauf" : "Durchläufe"} · ${formatTokens(h.tokens)} neue Tokens`],
            axis: h.hour % 3 === 0 ? String(h.hour).padStart(2, "0") : null,
          }))}
        />
      </ChartCard>
      <div className={cn("grid gap-3", cards > 1 && "lg:grid-cols-2")}>
        <ChartCard
          title="Letzte 14 Tage"
          sub={avgMs ? `Schnitt der Tage davor mit Arbeit: ${trendKind === "time" ? formatDuration(avgMs) : `${formatTokens(avgTokens)} neue Tokens`}. Klick öffnet den Tag.` : "Klick öffnet den Tag."}
          rows={u.days.map((d) => [dayLabel(d.date, today), `${formatDuration(d.workMs)}, ${formatTokens(d.tokens)} neue Tokens`])}
          actions={
            <div className="flex items-center gap-0.5" role="group" aria-label="Messgröße">
              {(
                [
                  ["time", "Zeit"],
                  ["tokens", "Tokens"],
                ] as const
              ).map(([k, label]) => (
                <Button key={k} size="sm" variant="ghost" aria-pressed={trendKind === k} className="aria-pressed:bg-surface-2 aria-pressed:text-fg" onClick={() => setTrendKind(k)}>
                  {label}
                </Button>
              ))}
            </div>
          }
        >
          <Columns
            kind={trendKind === "time" ? "duration" : "count"}
            emphasize
            onSelect={onPickDay}
            columns={u.days.map((d, i) => {
              const value = trendKind === "time" ? d.workMs : d.tokens;
              return {
                key: d.date,
                value,
                emphasis: d.date === date,
                tip: [trendKind === "time" ? formatDuration(value) : `${formatTokens(value)} neue Tokens`, dayLabel(d.date, today)],
                axis: d.date === date || i === 0 || i % 3 === 0 ? shortDay(d.date) : null,
              };
            })}
          />
        </ChartCard>
        {projects.length > 1 && (
          <ChartCard title="Nach Projekt" sub="Arbeitszeit von Claude, Agenten beim Hauptprojekt" rows={projects.map((p) => [p.name, `${formatDuration(p.workMs)}, ${formatTokens(p.tokens)} neue Tokens`])}>
            <ul className="flex flex-col gap-2.5">
              {projects.slice(0, 6).map((p) => (
                <li key={p.rootId} className="min-w-0">
                  <div className="mb-1 flex items-baseline gap-2 text-small">
                    <span className="min-w-0 flex-1 truncate text-fg">{p.name}</span>
                    <span className="shrink-0 tabular-nums text-fg">{formatDuration(p.workMs)}</span>
                    <span className="w-24 shrink-0 text-right tabular-nums text-subtle">{formatTokens(p.tokens)} neu</span>
                  </div>
                  <div className="h-2 w-full rounded-r-[4px] bg-surface-2">
                    <div className="h-full rounded-r-[4px] bg-accent-strong" style={{ width: `${Math.max(1, (p.workMs / maxProject) * 100)}%` }} />
                  </div>
                </li>
              ))}
              {projects.length > 6 && <li className="text-caption text-subtle">und {projects.length - 6} weitere, siehe Tabelle</li>}
            </ul>
          </ChartCard>
        )}
        {u.forge.calls > 0 && <ForgeCard u={u} />}
      </div>
    </div>
  );
}

/** Placeholder in the shape of the statistics: two headline cards and the day chart. */
export function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {[0, 1].map((i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
            <Skeleton className="h-2.5 w-24" />
            <Skeleton className="h-12 w-40" />
            <div className="mt-2 grid grid-cols-3 gap-3">
              {[0, 1, 2].map((k) => (
                <div key={k} className="flex flex-col gap-1.5">
                  <Skeleton className="h-2.5 w-14" />
                  <Skeleton className="h-4 w-16" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-surface p-4">
        <Skeleton className="mb-3 h-3 w-28" />
        <div className="flex items-end gap-[2px] pl-14" style={{ height: PLOT_H }}>
          {Array.from({ length: 24 }, (_, i) => (
            <div key={i} className="flex flex-1 justify-center">
              <Skeleton className="w-full max-w-6 rounded-b-none rounded-t-[4px]" style={{ height: `${10 + ((i * 37) % 70)}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

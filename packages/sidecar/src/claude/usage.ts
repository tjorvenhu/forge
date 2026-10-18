import { localeOf, type PlanUsage, type RateLimitState, type UsageWindow } from "@forge/protocol";
import { language, tr } from "../i18n/index.js";

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** Only documented windows are shown; codenamed or undocumented keys are ignored on purpose. */
function known(): Array<[key: string, label: string]> {
  const t = tr().core.claude;
  return [
    ["five_hour", t.windowFiveHours],
    ["seven_day", t.windowWeek],
    ["seven_day_opus", t.windowWeekModel("Opus")],
    ["seven_day_sonnet", t.windowWeekModel("Sonnet")],
  ];
}

/** Converts the SDK's /usage payload into FORGE's stable shape. Tolerates missing fields. */
export function toPlanUsage(raw: unknown): PlanUsage {
  const r = (raw ?? {}) as { subscription_type?: unknown; rate_limits_available?: unknown; rate_limits?: unknown };
  const limits = (r.rate_limits ?? null) as Record<string, unknown> | null;
  const windows: UsageWindow[] = [];
  if (limits) {
    for (const [key, label] of known()) {
      const w = limits[key] as RawWindow | null | undefined;
      if (w && typeof w.utilization === "number") windows.push({ key, label, utilization: clamp(w.utilization), resetsAt: w.resets_at ?? null });
    }
    const scoped = Array.isArray(limits.model_scoped) ? (limits.model_scoped as Array<RawWindow & { display_name?: unknown }>) : [];
    for (const m of scoped) {
      if (typeof m.utilization !== "number" || typeof m.display_name !== "string") continue;
      windows.push({ key: `model:${m.display_name}`, label: tr().core.claude.windowWeekModel(m.display_name), utilization: clamp(m.utilization), resetsAt: m.resets_at ?? null });
    }
  }
  return {
    available: r.rate_limits_available === true && windows.length > 0,
    subscriptionType: typeof r.subscription_type === "string" ? r.subscription_type : null,
    windows,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

/** Usage as plain lines for Claude (FORGE tool usage_status). */
export function describeUsage(usage: PlanUsage, limit: RateLimitState, now = Date.now()): string {
  const u = settleUsage(usage, now);
  const at = (iso: string) => usageTime(iso, now);
  const t = tr().core.claude;
  const lines: string[] = [];
  if (limit.status === "reached") lines.push(t.limitReached(limit.resetsAt ? at(limit.resetsAt) : null));
  else if (limit.status === "warning") lines.push(t.limitWarning(limit.utilization !== null ? Math.round(limit.utilization) : null, limit.resetsAt ? at(limit.resetsAt) : null));
  if (!u.available || !u.windows.length) lines.push(t.usageUnavailableLine(u.error));
  for (const w of u.windows) lines.push(t.windowLine(w.label, w.utilization, w.resetsAt ? at(w.resetsAt) : null, forecastText(w, at)));
  if (u.windows.length && !u.windows.some((w) => w.forecast)) lines.push(t.noForecast);
  if (u.subscriptionType) lines.push(t.subscription(u.subscriptionType));
  return lines.join("\n");
}

/** "heute 14:05" ("today 2:05 PM"), or with the date when it is not today. */
function usageTime(iso: string, now: number): string {
  const d = new Date(iso);
  const locale = localeOf(language());
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date(now).toDateString() ? tr().core.claude.today(time) : `${d.toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "2-digit" })} ${time}`;
}

/** The forecast of a window as words, or null without one. `at` formats a time. */
export function forecastText(w: UsageWindow, at: (iso: string) => string): string | null {
  const f = w.forecast;
  if (!f) return null;
  if (f.outcome === "limit" && f.limitAt) return tr().core.claude.forecastLimit(at(f.limitAt));
  return tr().core.claude.forecastEnough;
}

/**
 * A notice before more work starts (parallel agents): which windows run full before their reset at
 * the current pace. Null when none does or there is no forecast.
 */
export function limitWarning(usage: PlanUsage, now = Date.now()): string | null {
  const full = settleUsage(usage, now).windows.filter((w) => w.forecast?.outcome === "limit" && w.forecast.limitAt);
  if (!full.length) return null;
  const t = tr().core.claude;
  const parts = full.map((w) => t.limitWarningPart(w.label, usageTime(w.forecast!.limitAt!, now), w.resetsAt ? usageTime(w.resetsAt, now) : null));
  return t.limitWarningText(parts.join(", "));
}

function clamp(n: number) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * A window whose reset time has passed starts again at 0 %. Cached numbers are from before the reset,
 * and Claude Code may still report the old window for a moment after it.
 */
export function settleUsage(usage: PlanUsage, now = Date.now()): PlanUsage {
  if (!usage.windows.some((w) => isOver(w, now) && w.utilization > 0)) return usage;
  return { ...usage, windows: usage.windows.map((w) => (isOver(w, now) ? { ...w, utilization: 0 } : w)) };
}

/** True when a window of this usage reset after `since` and by `now`: the numbers are from before it. */
export function resetSince(usage: PlanUsage, since: number, now = Date.now()): boolean {
  return usage.windows.some((w) => w.resetsAt !== null && Date.parse(w.resetsAt) > since && isOver(w, now));
}

function isOver(w: UsageWindow, now: number) {
  return w.resetsAt !== null && Date.parse(w.resetsAt) <= now;
}

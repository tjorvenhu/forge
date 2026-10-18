import type { PlanCount } from "./db";

const title = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Readable name of a plan the app reports: "max_20x" is "Max 20x", "pro" "Pro", null the given `unknown`. */
export function planLabel(plan: string | null, unknown = ""): string {
  if (!plan) return unknown;
  const max = /^max_(\d+)x$/.exec(plan);
  if (max) return `Max ${max[1]}x`;
  return plan.split("_").map(title).join(" ");
}

/** Known plans by count, the unknown ones (older app versions, no claude.ai login) last. */
export function sortPlans(plans: PlanCount[]): PlanCount[] {
  return [...plans].sort((a, b) => Number(a.plan === null) - Number(b.plan === null) || b.installs - a.installs || planLabel(a.plan).localeCompare(planLabel(b.plan)));
}

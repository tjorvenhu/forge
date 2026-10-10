import type { EffortLevel } from "@forge/protocol";
import { useRuntimeInfo } from "@/lib/queries";

/** "claude-opus-5-5" → "Opus 5.5"; used when Claude Code does not list the model. */
export function prettyModel(m: string): string {
  const core = m.replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/-(\d+)$/, " $1");
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/** Display name of a model value or alias ("opus" → "Opus 5.5") from Claude Code's own model list. */
export function modelLabel(value: string, models: Array<{ value: string; displayName: string }> = []): string {
  const hit = models.find((m) => m.value === value);
  if (hit?.displayName) return hit.displayName;
  return prettyModel(value);
}

export function useModelLabel(): (value: string) => string {
  const models = useRuntimeInfo().data?.models ?? [];
  return (value) => modelLabel(value, models);
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly EffortLevel[];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Niedrig",
  medium: "Mittel",
  high: "Hoch",
  xhigh: "Sehr hoch",
  max: "Maximal",
};

/** Model entry for a value, alias or resolved ID ("claude-opus-5-5" matches "Opus 5.5"). */
export function findModel<M extends { value: string; displayName: string }>(value: string | null, models: M[]): M | undefined {
  const v = value ?? "default";
  return models.find((m) => m.value === v) ?? models.find((m) => m.displayName === prettyModel(v));
}

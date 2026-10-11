import type { EffortLevel, ModelInfo } from "@forge/protocol";
import type { SelectOption } from "@/components/ui/select";
import { EFFORT_LEVELS } from "@/lib/models";

/** Select value for "no own choice" (Claude Code default or the inherited setting); stored as null. */
export const NO_CHOICE = "__default";

export function fromChoice<T extends string>(v: string): T | null {
  return v === NO_CHOICE ? null : (v as T);
}

export function toChoice(v: string | null | undefined): string {
  return v ?? NO_CHOICE;
}

/** Options for a model select: the "no own choice" entry first, then Claude Code's model list. */
export function modelOptions(models: ModelInfo[], noChoiceLabel: string, { descriptions = true }: { descriptions?: boolean } = {}): SelectOption<string>[] {
  return [
    { value: NO_CHOICE, label: noChoiceLabel },
    ...models
      .filter((m) => m.value !== "default")
      .map((m) => ({ value: m.value, label: m.displayName || m.value, description: descriptions ? m.description : undefined })),
  ];
}

/** Options for an effort select. Level names stay as Claude Code calls them (low … max). */
export function effortOptions(noChoiceLabel: string): SelectOption<string>[] {
  return [{ value: NO_CHOICE, label: noChoiceLabel }, ...EFFORT_LEVELS.map((l: EffortLevel) => ({ value: l, label: l }))];
}

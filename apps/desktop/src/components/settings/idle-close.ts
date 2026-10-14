import { IDLE_CLOSE_CHOICES } from "@forge/protocol";
import type { SelectOption } from "@/components/ui/select";

/** "Aus", "15 Minuten", "1 Stunde", "90 Minuten" … */
export function idleCloseLabel(minutes: number): string {
  if (minutes <= 0) return "Aus";
  if (minutes % 60 === 0) return minutes === 60 ? "1 Stunde" : `${minutes / 60} Stunden`;
  return `${minutes} Minuten`;
}

/** The fixed choices, plus the current value when it was set elsewhere (the phone takes any minutes). */
export function idleCloseOptions(current: number): SelectOption<string>[] {
  const values: number[] = [...IDLE_CLOSE_CHOICES];
  if (!values.includes(current)) values.push(current);
  return values.sort((a, b) => a - b).map((m) => ({ value: String(m), label: idleCloseLabel(m) }));
}

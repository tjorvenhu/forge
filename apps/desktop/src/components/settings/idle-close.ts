import { IDLE_CLOSE_CHOICES } from "@forge/protocol";
import type { SelectOption } from "@/components/ui/select";
import { t } from "@/i18n";

/** "Aus", "15 Minuten", "1 Stunde", "90 Minuten" … */
export function idleCloseLabel(minutes: number): string {
  if (minutes <= 0) return t.settings.idleClose.off;
  if (minutes % 60 === 0) return t.settings.idleClose.hours(minutes / 60);
  return t.settings.idleClose.minutes(minutes);
}

/** The fixed choices, plus the current value when it was set elsewhere (the phone takes any minutes). */
export function idleCloseOptions(current: number): SelectOption<string>[] {
  const values: number[] = [...IDLE_CLOSE_CHOICES];
  if (!values.includes(current)) values.push(current);
  return values.sort((a, b) => a - b).map((m) => ({ value: String(m), label: idleCloseLabel(m) }));
}

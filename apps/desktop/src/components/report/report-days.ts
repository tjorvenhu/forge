import type { SelectOption } from "@/components/ui/select";
import { locale, t } from "@/i18n";

/** Local day as JJJJ-MM-TT, as the sidecar reads it. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parse(day: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** The day `delta` days later (negative: earlier). */
export function shiftDay(day: string, delta: number): string {
  const d = parse(day);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta));
}

/** "Heute", "Gestern" or the weekday with the date, e.g. "Mi., 14.10.". */
export function dayLabel(day: string, today: string): string {
  if (day === today) return t.report.today;
  if (day === shiftDay(today, -1)) return t.report.yesterday;
  const d = parse(day);
  return d.toLocaleDateString(locale, { weekday: "short", day: "2-digit", month: "2-digit", ...(d.getFullYear() !== parse(today).getFullYear() ? { year: "numeric" } : {}) });
}

/** Short for a chart axis, e.g. "14.10.". */
export function shortDay(day: string): string {
  return parse(day).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

/** The day written out for the page subtitle, e.g. "Donnerstag, 16. Oktober 2026". */
export function dayLong(day: string): string {
  return parse(day).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/** The last `count` days for the day picker, newest first; a selected older day is added at the end. */
export function dayOptions(today: string, selected: string, count = 30): SelectOption<string>[] {
  const days = Array.from({ length: count }, (_, i) => shiftDay(today, -i));
  if (!days.includes(selected)) days.push(selected);
  return days.map((d) => ({ value: d, label: dayLabel(d, today) }));
}

const full = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("de-DE", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 1,
});
const oneDecimal = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });

/** "12.345" below a million, from there "1,2 Mio.", "3,4 Mrd.", "5 Bio.". */
export function formatCount(n: number): string {
  return Math.abs(n) < 1e6 ? full.format(n) : compact.format(n);
}

export function formatHours(ms: number): string {
  const hours = ms / 3_600_000;
  return hours < 10 ? oneDecimal.format(hours) : formatCount(Math.round(hours));
}

const dateTime = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

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

const usdSmall = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** US cents as dollars: "3,45 $" below ten dollars, "2.400 $", from a million "1,2 Mio. $". */
export function formatUsd(cents: number): string {
  const usd = cents / 100;
  return `${usd < 10 ? usdSmall.format(usd) : formatCount(Math.round(usd))} $`;
}

const eurCents = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Euro cents: "12,50 €", whole amounts without cents ("25 €"), from 1000 € rounded ("1.240 €"). */
export function formatEur(cents: number): string {
  const eur = cents / 100;
  const whole = Math.abs(eur - Math.round(eur)) < 0.005;
  return `${whole || eur >= 1000 ? formatCount(Math.round(eur)) : eurCents.format(eur)} €`;
}

const dayShort = new Intl.DateTimeFormat("de-DE", { day: "numeric", month: "numeric", timeZone: "UTC" });
const dayLong = new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "18.10." for the axis. */
export function formatDayShort(day: string): string {
  return dayShort.format(new Date(`${day}T00:00:00Z`));
}

/** "So., 18. Okt." for tooltips and tables. */
export function formatDayLong(day: string): string {
  return dayLong.format(new Date(`${day}T00:00:00Z`));
}

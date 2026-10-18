import { intlLocale, type Locale } from "./i18n";

export interface Formats {
  /** "12.345" / "12,345" below a million, from there "1,2 Mio." / "1.2M". */
  count: (n: number) => string;
  /** Milliseconds as hours, one decimal below ten. */
  hours: (ms: number) => string;
  /** US cents as dollars: "3,45 $" / "$3.45" below ten dollars, whole dollars above, compact from a million. */
  usd: (cents: number) => string;
  /** Euro cents: "12,50 €" / "€12.50", whole amounts without cents, from 1000 € rounded. */
  eur: (cents: number) => string;
  /** Date and time in Berlin time: "18.10.2026, 14:30" / "Oct 18, 2026, 2:30 PM GMT+2". */
  dateTime: (iso: string) => string;
  /** "18.10." / "10/18" for the axis. */
  dayShort: (day: string) => string;
  /** "So., 18. Okt." / "Sun, Oct 18" for tooltips and tables. */
  dayLong: (day: string) => string;
  /** Rounded share: "45 %" / "45%". */
  percent: (part: number, whole: number) => string;
}

function build(locale: Locale): Formats {
  const l = intlLocale(locale);
  const full = new Intl.NumberFormat(l, { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(l, { notation: "compact", compactDisplay: "short", maximumFractionDigits: 1 });
  const oneDecimal = new Intl.NumberFormat(l, { maximumFractionDigits: 1 });
  const count = (n: number) => (Math.abs(n) < 1e6 ? full.format(n) : compact.format(n));

  const money = (currency: string) => ({
    cents: new Intl.NumberFormat(l, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    whole: new Intl.NumberFormat(l, { style: "currency", currency, maximumFractionDigits: 0 }),
    compact: new Intl.NumberFormat(l, { style: "currency", currency, notation: "compact", compactDisplay: "short", maximumFractionDigits: 1 }),
  });
  const usd = money("USD");
  const eur = money("EUR");

  const dateTime = new Intl.DateTimeFormat(
    l,
    // The German page says "Uhr" after it and needs no zone; the English one names it.
    locale === "de"
      ? { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }
      : { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Europe/Berlin", timeZoneName: "short" },
  );
  const dayShort = new Intl.DateTimeFormat(l, { day: "numeric", month: "numeric", timeZone: "UTC" });
  const dayLong = new Intl.DateTimeFormat(l, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const pct = new Intl.NumberFormat(l, { style: "percent", maximumFractionDigits: 0 });
  const day = (d: string) => new Date(`${d}T00:00:00Z`);

  return {
    count,
    hours: (ms) => {
      const hours = ms / 3_600_000;
      return hours < 10 ? oneDecimal.format(hours) : count(Math.round(hours));
    },
    usd: (cents) => {
      const v = cents / 100;
      return v < 10 ? usd.cents.format(v) : Math.abs(v) < 1e6 ? usd.whole.format(Math.round(v)) : usd.compact.format(v);
    },
    eur: (cents) => {
      const v = cents / 100;
      const whole = Math.abs(v - Math.round(v)) < 0.005;
      if (Math.abs(v) >= 1e6) return eur.compact.format(v);
      return whole || v >= 1000 ? eur.whole.format(Math.round(v)) : eur.cents.format(v);
    },
    dateTime: (iso) => dateTime.format(new Date(iso)),
    dayShort: (d) => dayShort.format(day(d)),
    dayLong: (d) => dayLong.format(day(d)),
    percent: (part, whole) => pct.format(whole ? part / whole : 0),
  };
}

const cache = new Map<Locale, Formats>();

export function formats(locale: Locale): Formats {
  let f = cache.get(locale);
  if (!f) {
    f = build(locale);
    cache.set(locale, f);
  }
  return f;
}

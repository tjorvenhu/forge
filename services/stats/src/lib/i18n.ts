// Shared by server and client: no next/headers here (see locale-server.ts).

export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Holds the visitor's choice for a year; without it Accept-Language decides on every request. */
export const LOCALE_COOKIE = "lang";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
/** Set by proxy.ts for /de and /en pages: the language of the path, ahead of cookie and browser. */
export const LOCALE_HEADER = "x-forge-locale";

/** "" for pages without a language in the path, else "/de" or "/en". */
export type LocaleBase = "" | `/${Locale}`;

/** Path of a page under a base: ("/stats", "/de") is "/de/stats", ("/", "/de") is "/de". */
export function localePath(path: "/" | "/stats", base: LocaleBase): string {
  if (!base) return path;
  return path === "/" ? base : `${base}${path}`;
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** The Intl locale for numbers and dates. */
export function intlLocale(locale: Locale): string {
  return locale === "de" ? "de-DE" : "en-US";
}

/** First supported language of an Accept-Language header by weight ("de-AT,de;q=0.9,en;q=0.8" is de). */
export function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find(Boolean);
      return { lang: tag.trim().toLowerCase().split("-")[0], q: q === undefined ? 1 : Number(q), i };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked.map((r) => r.lang).find(isLocale) ?? null;
}

/** The cookie wins; without one the browser's languages; English otherwise. */
export function pickLocale(cookie: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookie)) return cookie;
  return fromAcceptLanguage(acceptLanguage) ?? DEFAULT_LOCALE;
}

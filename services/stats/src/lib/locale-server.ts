import { cookies, headers } from "next/headers";
import { isLocale, LOCALE_COOKIE, LOCALE_HEADER, pickLocale, type Locale, type LocaleBase } from "./i18n";

/** Language of the current request, for server components and metadata. */
export async function getLocale(): Promise<Locale> {
  return (await getRoute()).locale;
}

/** Language and path prefix: /de and /en pages (proxy.ts) fix the language, the others follow cookie and browser. */
export async function getRoute(): Promise<{ locale: Locale; base: LocaleBase }> {
  const [jar, head] = await Promise.all([cookies(), headers()]);
  const fixed = head.get(LOCALE_HEADER);
  if (isLocale(fixed)) return { locale: fixed, base: `/${fixed}` };
  return { locale: pickLocale(jar.get(LOCALE_COOKIE)?.value, head.get("accept-language")), base: "" };
}

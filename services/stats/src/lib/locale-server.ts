import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, pickLocale, type Locale } from "./i18n";

/** Language of the current request, for server components and metadata. */
export async function getLocale(): Promise<Locale> {
  const [jar, head] = await Promise.all([cookies(), headers()]);
  return pickLocale(jar.get(LOCALE_COOKIE)?.value, head.get("accept-language"));
}

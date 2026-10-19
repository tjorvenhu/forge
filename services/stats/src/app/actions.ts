"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, localePath } from "@/lib/i18n";

/** The language switch posts here (a plain form, so it works without JavaScript); Next renders the page again with the new cookie. */
export async function setLocale(form: FormData): Promise<void> {
  const locale = form.get("locale");
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" });
  // Sent from a page with the language in its path (/de/stats): that path fixes the language, so go to the other one.
  const page = form.get("page");
  if (page === "/" || page === "/stats") redirect(localePath(page, `/${locale}`));
}

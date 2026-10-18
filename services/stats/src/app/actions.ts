"use server";

import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from "@/lib/i18n";

/** The language switch posts here (a plain form, so it works without JavaScript); Next renders the page again with the new cookie. */
export async function setLocale(form: FormData): Promise<void> {
  const locale = form.get("locale");
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" });
}

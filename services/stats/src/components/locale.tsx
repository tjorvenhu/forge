"use client";

import { createContext, useContext, useId, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { setLocale } from "@/app/actions";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "@/lib/i18n";
import { i18n, LANGUAGE_NAMES } from "@/lib/messages";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

/** Set once in the root layout from the cookie (or Accept-Language), so client components render the language the server did. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  return i18n(useContext(LocaleContext));
}

/**
 * Flags in the top bar. A form with one submit button per language: it posts to the server action
 * even without JavaScript, and the server renders the page again in the chosen language.
 */
export function LanguageSwitch() {
  const { locale, t } = useI18n();
  return (
    <form action={setLocale} className="lang-switch" role="group" aria-label={t.language.label}>
      {LOCALES.map((l) => (
        <LanguageButton key={l} locale={l} current={locale} />
      ))}
    </form>
  );
}

function LanguageButton({ locale, current }: { locale: Locale; current: Locale }) {
  const { pending, data } = useFormStatus();
  // While the server renders, the clicked flag already shows as chosen.
  const chosen = pending && data ? data.get("locale") === locale : locale === current;
  return (
    <button
      type="submit"
      name="locale"
      value={locale}
      className={chosen ? "lang-btn lang-btn-on" : "lang-btn"}
      aria-pressed={chosen}
      aria-label={LANGUAGE_NAMES[locale]}
      title={LANGUAGE_NAMES[locale]}
      lang={locale}
    >
      <Flag locale={locale} />
      <span className="lang-code" aria-hidden>
        {locale.toUpperCase()}
      </span>
    </button>
  );
}

/** Flag of a language as SVG (no emoji: Windows draws flag emoji as two letters). Colours of the flags, not the theme. */
function Flag({ locale }: { locale: Locale }) {
  return <span className="flag">{locale === "de" ? <GermanFlag /> : <BritishFlag />}</span>;
}

function GermanFlag() {
  return (
    <svg viewBox="0 0 5 3" preserveAspectRatio="none" aria-hidden>
      <rect width="5" height="1" y="0" fill="#000000" />
      <rect width="5" height="1" y="1" fill="#DD0000" />
      <rect width="5" height="1" y="2" fill="#FFCE00" />
    </svg>
  );
}

function BritishFlag() {
  const id = useId();
  return (
    <svg viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <clipPath id={`${id}t`}>
        <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
      </clipPath>
      <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#FFFFFF" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" clipPath={`url(#${id}t)`} stroke="#C8102E" strokeWidth="4" />
      <path d="M30,0 v30 M0,15 h60" stroke="#FFFFFF" strokeWidth="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
    </svg>
  );
}

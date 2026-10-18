import { z } from "zod";

/** Language of FORGE's interface, the texts of the sidecar and what the phone speaks. */
export const Language = z.enum(["en", "de"]);
export type Language = z.infer<typeof Language>;

export const LANGUAGES: readonly Language[] = ["en", "de"];
export const DEFAULT_LANGUAGE: Language = "en";

/** Names in their own language: the switcher shows them so each one is readable for its speakers. */
export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", de: "Deutsch" };

export function localeOf(language: Language): string {
  return language === "de" ? "de-DE" : "en-US";
}

let current: Language = DEFAULT_LANGUAGE;

/**
 * Language of the texts this package makes (formatTokens, forgeUsageLabel …). Module state on purpose:
 * the UI and the sidecar each load their own copy and set it once they know the setting.
 */
export function setProtocolLanguage(language: Language): void {
  current = language;
}

export function protocolLanguage(): Language {
  return current;
}

/** Picks the text for the current language. */
export function pick<T>(texts: Record<Language, T>): T {
  return texts[current];
}

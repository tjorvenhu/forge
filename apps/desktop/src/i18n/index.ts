import { DEFAULT_LANGUAGE, Language, localeOf, setProtocolLanguage } from "@forge/protocol";
import { de } from "./de";
import { en } from "./en";

/** All texts of the interface; German is the source, the English files are typed against it. */
export type Messages = typeof de;

/**
 * The language is fixed per page load: every window reads it here before anything renders, so texts may
 * also be taken at module level. A change is saved, then the windows reload (applyLanguage).
 * localStorage mirrors the setting because the sidecar answers only after the first render.
 */
const STORAGE_KEY = "forge.language";

function storedLanguage(): Language {
  try {
    const parsed = Language.safeParse(localStorage.getItem(STORAGE_KEY));
    return parsed.success ? parsed.data : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export const language: Language = storedLanguage();
setProtocolLanguage(language);
if (typeof document !== "undefined") document.documentElement.lang = language;

export const t: Messages = language === "de" ? de : en;

/** For Intl and toLocaleString. */
export const locale = localeOf(language);

/** Takes over a language from the settings; reloads the window when it differs from the one on screen. */
export function applyLanguage(next: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    return;
  }
  if (next !== language) location.reload();
}

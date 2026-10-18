import { DEFAULT_LANGUAGE, setProtocolLanguage, type Language } from "@forge/protocol";
import { de } from "./de/index.js";
import { en } from "./en/index.js";

/** All texts of the sidecar; German is the source, the English files are typed against it. */
export type SidecarMessages = typeof de;

let current: Language = DEFAULT_LANGUAGE;

/** Set from the settings at start and on every change (app.ts). */
export function setLanguage(language: Language): void {
  current = language;
  setProtocolLanguage(language);
}

export function language(): Language {
  return current;
}

/** Texts in the current language. Call it where the text is made, not once at module level: the language can change while FORGE runs. */
export function tr(): SidecarMessages {
  return current === "de" ? de : en;
}

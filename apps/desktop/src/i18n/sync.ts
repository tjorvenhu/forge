import { useEffect } from "react";
import { useSettings } from "@/lib/queries";
import { applyLanguage } from "./index";

/** Follows the language setting: a change from settings, palette, phone or sync reloads this window in the new language. */
export function useLanguageSync(): void {
  const lang = useSettings().data?.language;
  useEffect(() => {
    if (lang) applyLanguage(lang);
  }, [lang]);
}

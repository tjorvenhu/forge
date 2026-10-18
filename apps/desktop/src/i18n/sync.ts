import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "@/lib/queries";
import { isTauri } from "@/lib/rpc";
import { applyLanguage } from "./index";

/** Follows the language setting: a change from settings, palette, phone or sync reloads this window in the new language. */
export function useLanguageSync(): void {
  const lang = useSettings().data?.language;
  useEffect(() => {
    if (!lang) return;
    // Rust keeps it for its own texts (errors, window titles), also for the next start before the UI.
    if (isTauri()) void invoke("set_language", { language: lang }).catch(() => {});
    applyLanguage(lang);
  }, [lang]);
}

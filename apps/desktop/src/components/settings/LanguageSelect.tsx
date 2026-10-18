import { useQueryClient } from "@tanstack/react-query";
import { LANGUAGE_NAMES, LANGUAGES, type Language } from "@forge/protocol";
import { call, keys, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { language, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { Flag } from "@/components/ui/flag";
import { Select } from "@/components/ui/select";

/** Saves the language; useLanguageSync then reloads the windows in it. */
export function useSetLanguage(): (next: Language) => Promise<void> {
  const qc = useQueryClient();
  return async (next) => {
    try {
      qc.setQueryData(keys.settings, await call("settings.update", { language: next }));
    } catch (e) {
      toast.error(t.settings.languageNotSaved, errorMessage(e));
    }
  };
}

export function LanguageSelect({ className }: { className?: string }) {
  const current = useSettings().data?.language ?? language;
  const setLanguage = useSetLanguage();
  return (
    <Select<Language>
      value={current}
      onChange={(v) => void setLanguage(v)}
      className={className}
      aria-label={t.settings.language}
      options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_NAMES[l], icon: <Flag language={l} /> }))}
    />
  );
}

/** Big choice for the first start: both names stay readable whatever language is on screen. */
export function LanguageChoice() {
  const current = useSettings().data?.language ?? language;
  const setLanguage = useSetLanguage();
  return (
    <div role="radiogroup" aria-label={t.setup.languageTitle} className="grid grid-cols-2 gap-3">
      {LANGUAGES.map((l) => {
        const checked = l === current;
        return (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => !checked && void setLanguage(l)}
            className={cn(
              "flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors duration-120",
              checked ? "border-accent bg-accent-soft" : "border-border bg-surface-2/40 hover:border-accent/60 hover:bg-accent-soft",
            )}
          >
            <Flag language={l} className="h-5 w-7" />
            <span className="text-body font-medium">{LANGUAGE_NAMES[l]}</span>
          </button>
        );
      })}
    </div>
  );
}

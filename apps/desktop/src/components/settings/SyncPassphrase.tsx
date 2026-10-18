import { useEffect, useState } from "react";
import { Field, Input } from "@/components/ui/input";
import { t } from "@/i18n";

export const MIN_PASSPHRASE = 12;

/**
 * The sync password. `existing`: data on GitHub is already encrypted with it, so it is entered once;
 * otherwise a new one is chosen and repeated. Reports the password once it is usable, else null.
 */
export function SyncPassphraseFields({ existing, onChange, autoFocus }: { existing: boolean; onChange: (passphrase: string | null) => void; autoFocus?: boolean }) {
  const [value, setValue] = useState("");
  const [repeat, setRepeat] = useState("");
  const short = value.length > 0 && value.length < MIN_PASSPHRASE;
  const mismatch = !existing && repeat.length > 0 && repeat !== value;
  const ok = existing ? value.length > 0 : value.length >= MIN_PASSPHRASE && repeat === value;
  useEffect(() => onChange(ok ? value : null), [ok, value, onChange]);
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field
        label={existing ? t.settings.passphrase.label : t.settings.passphrase.newLabel}
        hint={
          existing
            ? t.settings.passphrase.existingHint
            : short
              ? t.settings.passphrase.tooShort(MIN_PASSPHRASE)
              : t.settings.passphrase.newHint
        }
      >
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus={autoFocus} autoComplete="new-password" aria-label={existing ? t.settings.passphrase.label : t.settings.passphrase.newLabel} />
      </Field>
      {!existing && (
        <Field label={t.settings.passphrase.repeat} hint={mismatch ? t.settings.passphrase.mismatch : undefined}>
          <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" aria-label={t.settings.passphrase.repeatAria} />
        </Field>
      )}
    </div>
  );
}

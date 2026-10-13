import { useEffect, useState } from "react";
import { Field, Input } from "@/components/ui/input";

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
        label={existing ? "Sync-Passwort" : "Neues Sync-Passwort"}
        hint={
          existing
            ? "Das Passwort, mit dem du die Synchronisierung auf dem anderen PC eingerichtet hast."
            : short
              ? `Mindestens ${MIN_PASSPHRASE} Zeichen.`
              : "Verschlüsselt alles auf GitHub. Du brauchst es auf jedem PC. FORGE kann es nicht wiederherstellen."
        }
      >
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus={autoFocus} autoComplete="new-password" aria-label={existing ? "Sync-Passwort" : "Neues Sync-Passwort"} />
      </Field>
      {!existing && (
        <Field label="Wiederholen" hint={mismatch ? "Die beiden Eingaben sind verschieden." : undefined}>
          <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" aria-label="Sync-Passwort wiederholen" />
        </Field>
      )}
    </div>
  );
}

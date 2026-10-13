import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { PhoneNumberEntry } from "@forge/protocol";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LabelWithInfo } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";

/**
 * A list of phone numbers as single entries: switch, name, number, delete. Switched off, a number stays
 * in the list but does not count. Entries without a number are not saved (see toPatch).
 */
export function PhoneNumberList({
  label,
  hint,
  entries,
  onChange,
  addLabel,
  empty,
}: {
  label: string;
  hint?: string;
  entries: PhoneNumberEntry[];
  onChange: (next: PhoneNumberEntry[]) => void;
  addLabel: string;
  /** shown instead of the rows while the list is empty */
  empty: string;
}) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const numberRefs = useRef(new Map<string, HTMLInputElement>());
  useEffect(() => {
    if (!focusId) return;
    numberRefs.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  const update = (id: string, patch: Partial<PhoneNumberEntry>) => onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const add = () => {
    const id = crypto.randomUUID();
    onChange([...entries, { id, number: "", label: "", enabled: true }]);
    setFocusId(id);
  };

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <LabelWithInfo info={hint} className="h-4">
        <span className="text-xs font-medium text-muted">{label}</span>
      </LabelWithInfo>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {entries.length === 0 ? (
          <p className="px-3 py-2.5 text-xs text-subtle">{empty}</p>
        ) : (
          entries.map((e) => {
            const name = e.label.trim() || e.number.trim() || "neue Nummer";
            return (
              <div key={e.id} className="flex items-center gap-2 px-2.5 py-2">
                <Switch checked={e.enabled} onChange={(v) => update(e.id, { enabled: v })} label={`${name} ${e.enabled ? "ausschalten" : "einschalten"}`} />
                <Input
                  value={e.label}
                  onChange={(ev) => update(e.id, { label: ev.target.value })}
                  placeholder="Bezeichnung"
                  aria-label={`Bezeichnung von ${name}`}
                  maxLength={40}
                  className={cn("w-28 shrink-0 text-xs", !e.enabled && "text-subtle")}
                />
                <Input
                  ref={(el) => {
                    if (el) numberRefs.current.set(e.id, el);
                    else numberRefs.current.delete(e.id);
                  }}
                  value={e.number}
                  onChange={(ev) => update(e.id, { number: ev.target.value })}
                  placeholder="+49 170 1234567"
                  aria-label={`Nummer von ${name}`}
                  inputMode="tel"
                  maxLength={40}
                  className={cn("min-w-0 flex-1 font-mono text-xs", !e.enabled && "text-subtle line-through")}
                />
                <Button size="icon-sm" variant="danger-ghost" onClick={() => onChange(entries.filter((x) => x.id !== e.id))} aria-label={`${name} löschen`} title="Nummer löschen">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })
        )}
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" className="shrink-0" onClick={add}>
          <Plus className="h-3.5 w-3.5" /> {addLabel}
        </Button>
      </div>
    </div>
  );
}

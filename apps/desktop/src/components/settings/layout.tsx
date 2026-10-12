import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";

export interface SettingsSectionDef<Id extends string> {
  id: Id;
  label: string;
  hint: string;
  Icon: LucideIcon;
}

/** Settings page frame: section menu on the left, the chosen section on the right. Shared by the app and the project settings. */
export function SettingsLayout<Id extends string>({
  sections,
  current,
  onSelect,
  label,
  children,
}: {
  sections: ReadonlyArray<SettingsSectionDef<Id>>;
  current: Id;
  onSelect: (id: Id) => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-6xl gap-8">
      <nav className="sticky top-0 flex w-56 shrink-0 flex-col gap-1 self-start" aria-label={label}>
        {sections.map((x) => {
          const active = x.id === current;
          return (
            <button
              key={x.id}
              onClick={() => onSelect(x.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-[color,background-color,transform] duration-120 active:scale-[0.98]",
                active ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <x.Icon className={cn("mt-0.5 h-4 w-4 shrink-0", active && "text-accent")} />
              <span className="min-w-0">
                <span className="block text-body-lg">{x.label}</span>
                <span className="block truncate text-caption text-subtle">{x.hint}</span>
              </span>
            </button>
          );
        })}
      </nav>

      {/* Keyed per section: each switch fades the new section in. */}
      <div key={current} className="flex min-w-0 max-w-3xl flex-1 animate-view-in flex-col gap-6 pb-10">
        {children}
      </div>
    </div>
  );
}

/** A titled card of settings rows. */
export function Group({ title, description, action, danger, children }: { title: string; description?: ReactNode; action?: ReactNode; danger?: boolean; children: ReactNode }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-surface", danger ? "border-danger/30" : "border-border")}>
      <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-ui font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        {action}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/** One setting: what it is and what it does on the left, the control on the right (or below with `stacked`). */
export function Row({ label, description, children, stacked }: { label: ReactNode; description?: ReactNode; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={cn("px-4 py-3.5", stacked ? "flex flex-col gap-2.5" : "flex items-center justify-between gap-6")}>
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
      </div>
      {children}
    </div>
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Row label={label} description={description}>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </Row>
  );
}

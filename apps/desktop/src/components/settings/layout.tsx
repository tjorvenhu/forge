import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { LabelWithDescription } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";

export interface SettingsSectionDef<Id extends string> {
  id: Id;
  label: string;
  hint: string;
  Icon: LucideIcon;
  /** shown as a branch under this section, like in a file tree */
  parent?: Id;
  /** a small one-line entry below the others, set apart by a line */
  minor?: boolean;
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
  const minor = sections.filter((x) => x.minor);
  return (
    <div className="mx-auto flex max-w-6xl gap-8">
      <nav className="sticky top-0 flex w-56 shrink-0 flex-col gap-1 self-start" aria-label={label}>
        {sections
          .filter((x) => !x.parent && !x.minor)
          .map((x) => {
            const children = sections.filter((c) => c.parent === x.id);
            return (
              <div key={x.id} className="flex flex-col gap-1">
                <SectionButton section={x} active={x.id === current} onSelect={onSelect} />
                {children.length > 0 && (
                  // Tree lines from the parent's icon (20px in): a bend to each child, the trunk runs on to the next one.
                  <div className="ml-5 flex flex-col gap-1">
                    {children.map((c, i) => (
                      <div
                        key={c.id}
                        className={cn(
                          "relative pl-4 before:absolute before:left-0 before:-top-1 before:h-[calc(50%+0.25rem)] before:w-3 before:rounded-bl-md before:border-b before:border-l before:border-border-strong",
                          i < children.length - 1 && "after:absolute after:-bottom-1 after:left-0 after:top-1/2 after:border-l after:border-border-strong",
                        )}
                      >
                        <SectionButton section={c} active={c.id === current} onSelect={onSelect} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        {minor.length > 0 && (
          <div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
            {minor.map((x) => (
              <MinorButton key={x.id} section={x} active={x.id === current} onSelect={onSelect} />
            ))}
          </div>
        )}
      </nav>

      {/* Keyed per section: each switch fades the new section in. */}
      <div key={current} className="flex min-w-0 max-w-3xl flex-1 animate-view-in flex-col gap-6 pb-10">
        {children}
      </div>
    </div>
  );
}

function SectionButton<Id extends string>({ section: x, active, onSelect }: { section: SettingsSectionDef<Id>; active: boolean; onSelect: (id: Id) => void }) {
  return (
    <button
      onClick={() => onSelect(x.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-[color,background-color,transform] duration-120 active:scale-[0.98]",
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
}

function MinorButton<Id extends string>({ section: x, active, onSelect }: { section: SettingsSectionDef<Id>; active: boolean; onSelect: (id: Id) => void }) {
  return (
    <button
      onClick={() => onSelect(x.id)}
      aria-current={active ? "page" : undefined}
      title={x.hint}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-body transition-[color,background-color,transform] duration-120 active:scale-[0.98]",
        active ? "bg-accent-soft text-fg" : "text-subtle hover:bg-surface-2 hover:text-fg",
      )}
    >
      <x.Icon className={cn("h-3.5 w-3.5 shrink-0", active && "text-accent")} />
      {x.label}
    </button>
  );
}

/** A titled card of settings rows. */
export function Group({ title, description, action, danger, children }: { title: ReactNode; description?: ReactNode; action?: ReactNode; danger?: boolean; children: ReactNode }) {
  return (
    <section className={cn("overflow-hidden rounded-xl border bg-surface", danger ? "border-danger/30" : "border-border")}>
      <header className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <LabelWithDescription description={description}>
          <h2 className="text-ui font-semibold">{title}</h2>
        </LabelWithDescription>
        {action}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/** One setting: what it is and what it does on the left, the control on the right (or below with `stacked`). */
export function Row({ label, description, children, stacked }: { label: ReactNode; description?: ReactNode; children: ReactNode; stacked?: boolean }) {
  return (
    <div className={cn("px-4 py-3.5", stacked ? "flex flex-col gap-2.5" : "flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5")}>
      {/* A wide control moves below the label instead of squeezing the description into a narrow column.
          Stacked, the basis would be a height of 14rem: empty space above the control. */}
      <LabelWithDescription description={description} className={stacked ? undefined : "flex-[1_1_14rem]"}>
        <span className="text-body font-medium">{label}</span>
      </LabelWithDescription>
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

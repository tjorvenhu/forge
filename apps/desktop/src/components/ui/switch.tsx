import { cn } from "@/lib/utils";

/** On/off switch for settings rows. A button with role="switch", so Space and Enter toggle it. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 ease-snappy disabled:opacity-50",
        checked ? "border-accent bg-accent" : "border-border-strong bg-surface-3",
      )}
    >
      <span
        aria-hidden
        className={cn("h-3.5 w-3.5 rounded-full bg-fg shadow transition-transform duration-150 ease-snappy", checked ? "translate-x-4.5 bg-accent-fg" : "translate-x-0.5")}
      />
    </button>
  );
}

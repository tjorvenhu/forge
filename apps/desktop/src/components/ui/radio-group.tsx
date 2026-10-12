import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface RadioGroupProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: RadioOption<T>[];
  "aria-label": string;
  className?: string;
}

/** Small set of mutually exclusive choices. Arrow keys move and select, like native radio buttons. */
export function RadioGroup<T extends string>({ value, onChange, options, className, ...rest }: RadioGroupProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step || !enabled.length) return;
    e.preventDefault();
    const pos = enabled.indexOf(index);
    const next = enabled[(pos + step + enabled.length) % enabled.length]!;
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={rest["aria-label"]} className={cn("flex items-center gap-4", className)}>
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={o.disabled}
            tabIndex={checked || (!options.some((x) => x.value === value) && i === enabled[0]) ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className="flex items-center gap-2 rounded-md text-body text-fg disabled:opacity-50"
          >
            <span
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-surface-2",
                checked ? "border-accent" : "border-border-strong",
              )}
              aria-hidden
            >
              {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
            </span>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

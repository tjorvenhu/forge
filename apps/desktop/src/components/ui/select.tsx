import { useRef } from "react";
import * as S from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

interface SelectProps<T extends string> {
  value: T | undefined;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  size?: "sm" | "md";
}

export function Select<T extends string>({ value, onChange, options, placeholder, className, disabled, size = "md", ...rest }: SelectProps<T>) {
  const open = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <S.Root
      value={value}
      onOpenChange={(o) => {
        open.current = o;
      }}
      onValueChange={(v) => {
        // Radix can emit a change on its own when the option list is replaced (seen when the model
        // list loads). Only accept changes made through the open list or keyboard typeahead.
        const userAction = open.current || document.activeElement === trigger.current;
        if (!userAction || !v || v === value) return;
        onChange(v as T);
      }}
      disabled={disabled}
    >
      <S.Trigger
        ref={trigger}
        aria-label={rest["aria-label"]}
        className={cn(
          "inline-flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-2.5 text-[13px] text-fg hover:border-border-strong focus:outline-none focus-visible:border-accent disabled:opacity-50",
          size === "sm" ? "h-7 text-xs" : "h-8",
          className,
        )}
      >
        <S.Value placeholder={<span className="text-subtle">{placeholder ?? "Auswählen"}</span>} />
        <S.Icon>
          <ChevronDown className="h-3.5 w-3.5 text-muted" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className="z-50 max-h-80 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl">
          <S.Viewport className="p-1">
            {options.map((o) => (
              <S.Item
                key={o.value}
                value={o.value}
                disabled={o.disabled}
                className="relative flex cursor-default select-none flex-col rounded-md py-1.5 pl-7 pr-3 text-[13px] text-fg outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3"
              >
                <S.ItemIndicator className="absolute left-2 top-2">
                  <Check className="h-3.5 w-3.5 text-accent" />
                </S.ItemIndicator>
                <S.ItemText>{o.label}</S.ItemText>
                {o.description && <span className="text-xs text-muted">{o.description}</span>}
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

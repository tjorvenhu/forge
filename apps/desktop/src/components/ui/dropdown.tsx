import type { ReactNode } from "react";
import * as M from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { POPPER_MOTION } from "@/lib/motion";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

export function DropdownMenu({ trigger, items, align = "end", header }: { trigger: ReactNode; items: MenuItem[]; align?: "start" | "end"; header?: ReactNode }) {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content align={align} sideOffset={4} className={cn("z-50 min-w-48 max-w-80 rounded-lg border border-border bg-surface-2 p-1 shadow-xl", POPPER_MOTION)}>
          {header && <div className="px-2 py-1.5 text-xs text-subtle">{header}</div>}
          {items.map((it, i) => (
            <M.Item
              key={i}
              disabled={it.disabled}
              onSelect={it.onSelect}
              className={cn(
                "flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-body outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-surface-3",
                it.danger ? "text-danger" : "text-fg",
              )}
            >
              {it.icon}
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-xs text-subtle">{it.hint}</span>}
            </M.Item>
          ))}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

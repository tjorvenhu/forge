import type { ReactNode } from "react";
import * as T from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export interface TabDef<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
}

export function TabBar<V extends string>({
  value,
  onChange,
  tabs,
  className,
  children,
}: {
  value: V;
  onChange: (v: V) => void;
  tabs: TabDef<V>[];
  className?: string;
  children?: ReactNode;
}) {
  return (
    <T.Root value={value} onValueChange={(v) => onChange(v as V)} className="contents">
      <T.List className={cn("flex items-center gap-1", className)}>
        {tabs.map((t) => (
          <T.Trigger
            key={t.value}
            value={t.value}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-[13px] text-muted outline-none hover:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent focus-visible:ring-2 focus-visible:ring-accent"
          >
            {t.icon}
            {t.label}
            {t.badge}
          </T.Trigger>
        ))}
        {children}
      </T.List>
    </T.Root>
  );
}

import { Fragment, type ReactNode } from "react";
import * as T from "@radix-ui/react-tabs";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabDef<V extends string> {
  value: V;
  label: string;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Shows a close button next to the tab. It is a sibling of the trigger, so it never selects the tab. */
  onClose?: () => void;
  closeLabel?: string;
}

export function TabBar<V extends string>({
  value,
  onChange,
  tabs,
  className,
  children,
  size = "md",
}: {
  value: V;
  onChange: (v: V) => void;
  tabs: TabDef<V>[];
  className?: string;
  children?: ReactNode;
  /** lg: the main tabs of the workspace and its side panel */
  size?: "md" | "lg";
}) {
  return (
    <T.Root value={value} onValueChange={(v) => onChange(v as V)} className="contents">
      <T.List className={cn("flex items-center gap-1", className)}>
        {tabs.map((t) => (
          <Fragment key={t.value}>
            <T.Trigger
              value={t.value}
              className={cn(
                "relative inline-flex items-center rounded-md text-muted outline-none hover:text-fg data-[state=active]:text-fg data-[state=active]:after:absolute data-[state=active]:after:-bottom-px data-[state=active]:after:rounded-full data-[state=active]:after:bg-accent focus-visible:ring-2 focus-visible:ring-accent",
                size === "lg"
                  ? "h-12 gap-2 px-3.5 text-ui data-[state=active]:font-medium data-[state=active]:after:inset-x-1 data-[state=active]:after:h-0.75"
                  : "h-9 gap-1.5 px-3 text-body data-[state=active]:after:inset-x-2 data-[state=active]:after:h-0.5",
                t.onClose && "pr-1",
              )}
            >
              {t.icon}
              {t.label}
              {t.badge}
            </T.Trigger>
            {t.onClose && (
              <button
                type="button"
                onClick={t.onClose}
                aria-label={t.closeLabel ?? `${t.label} schließen`}
                title={t.closeLabel ?? `${t.label} schließen`}
                className="-ml-1 mr-1 inline-flex h-5 w-5 items-center justify-center rounded text-subtle outline-none hover:bg-surface-3 hover:text-fg focus-visible:ring-2 focus-visible:ring-accent"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </Fragment>
        ))}
        {children}
      </T.List>
    </T.Root>
  );
}

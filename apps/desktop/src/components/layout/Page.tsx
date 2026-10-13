import type { ReactNode } from "react";
import { AlwaysOnTopButton } from "./AlwaysOnTopButton";
import { PhoneButton } from "./PhoneButton";

/** Thin vertical line between groups of header controls. */
export function HeaderDivider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />;
}

export function Page({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <h1 className="text-display font-semibold">{title}</h1>
          {subtitle && <div className="text-body text-muted">{subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          {actions && <HeaderDivider />}
          <AlwaysOnTopButton />
          <PhoneButton />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
    </div>
  );
}

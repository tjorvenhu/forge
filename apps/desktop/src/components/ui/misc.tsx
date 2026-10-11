import type { ReactNode } from "react";
import * as C from "@radix-ui/react-checkbox";
import * as T from "@radix-ui/react-tooltip";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-3 text-muted border-border",
  accent: "bg-accent-soft text-accent border-accent/30",
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  danger: "bg-danger-soft text-danger border-danger/30",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[11px] font-medium", toneClass[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-muted", className)} aria-label="Lädt" />;
}

/** Loading placeholder for a section: centred spinner with a short text and room around it. */
export function Loading({ label = "Lädt …", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 py-6 text-xs text-muted", className)} role="status">
      <Spinner className="h-3.5 w-3.5" /> {label}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <C.Root
      checked={checked}
      onCheckedChange={(v) => onChange(v === true)}
      disabled={disabled}
      aria-label={label}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border-strong bg-surface-2 data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <C.Indicator>
        <Check className="h-3 w-3 text-accent-fg" strokeWidth={3} />
      </C.Indicator>
    </C.Root>
  );
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <T.Root delayDuration={400}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className="z-50 max-w-xs rounded-md border border-border bg-surface-3 px-2 py-1 text-xs text-fg shadow-lg">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon && <div className="text-subtle">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-md text-[13px] text-muted">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorBanner({ title = "Fehler", children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px]">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-danger">{title}</div>
        <div className="break-words text-fg/90">{children}</div>
      </div>
      {action}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-subtle">{children}</h2>
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-surface-3 px-1 font-mono text-[10px] text-muted">{children}</kbd>;
}

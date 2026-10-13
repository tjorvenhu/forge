import { isValidElement, type ReactNode } from "react";
import * as C from "@radix-ui/react-checkbox";
import * as T from "@radix-ui/react-tooltip";
import { AlertTriangle, Check, Info, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { POPPER_MOTION } from "@/lib/motion";
import { TipText } from "./title-tooltips";

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
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-caption font-medium", toneClass[tone], className)}>
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

/** Checkbox with a label and an optional explanation (below it, or behind an info icon when long); the whole row is clickable. */
export function ToggleRow({
  checked,
  onChange,
  label,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
  /** explanation of the option, see LabelWithDescription */
  children?: ReactNode;
}) {
  return (
    <label className={cn("flex items-start gap-2.5", disabled && "opacity-60")}>
      <span className="mt-0.5">
        <Checkbox checked={checked} onChange={onChange} label={label} disabled={disabled} />
      </span>
      <LabelWithDescription description={children}>
        <span className="text-body">{label}</span>
      </LabelWithDescription>
    </label>
  );
}

export function Tooltip({
  content,
  children,
  open,
  onOpenChange,
  delay = 400,
}: {
  content: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  delay?: number;
}) {
  return (
    <T.Root delayDuration={delay} open={open} onOpenChange={onOpenChange}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className={cn("z-50 max-w-xs rounded-md border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-fg shadow-lg", POPPER_MOTION)}>
          {typeof content === "string" ? <TipText text={content} /> : content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

/** Small "i" after a label: the explanation shows on hover or keyboard focus instead of taking up lines. */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip content={children} delay={100}>
      <button
        type="button"
        aria-label="Info"
        // Keeps the tip open on click (Radix skips its close handler) and, inside a <label>, the checkbox or field untouched.
        onClick={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
        className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full text-subtle transition-colors duration-120 hover:text-fg focus-visible:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <Info className="h-3.5 w-3.5" />
      </button>
    </Tooltip>
  );
}

/** A label followed by an InfoTip with its explanation; without one just the label. */
export function LabelWithInfo({ info, children, className }: { info?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      {children}
      {info ? <InfoTip>{info}</InfoTip> : null}
    </span>
  );
}

/** Up to this many characters an explanation stays visible; a single i per row would leave short sections looking empty. */
const SHORT_INFO_MAX = 120;

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** Whether an explanation is short enough to show as a line of text instead of behind an InfoTip. */
export function isShortInfo(info: ReactNode): boolean {
  return textOf(info).length <= SHORT_INFO_MAX;
}

/** A label with its explanation: a short one as a muted line below, a long one behind an InfoTip. */
export function LabelWithDescription({ description, children, className }: { description?: ReactNode; children: ReactNode; className?: string }) {
  if (!description || !isShortInfo(description)) {
    return (
      <LabelWithInfo info={description} className={className}>
        {children}
      </LabelWithInfo>
    );
  }
  return (
    <span className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      {children}
      <span className="text-xs text-muted">{description}</span>
    </span>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {icon && <div className="text-subtle">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {children && <div className="max-w-md text-body text-muted">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorBanner({ title = "Fehler", children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-body">
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
  return <kbd className="rounded border border-border bg-surface-3 px-1 font-mono text-2xs text-muted">{children}</kbd>;
}

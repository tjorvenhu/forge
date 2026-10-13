import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { LabelWithInfo } from "./misc";

const base =
  "w-full rounded-md border border-border bg-surface-2 px-2.5 text-body text-fg transition-[border-color] duration-120 placeholder:text-subtle focus:border-accent focus:outline-none disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(base, "h-8", className)} {...props} />
));
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(base, "resize-none py-2", className)} {...props} />
));
Textarea.displayName = "Textarea";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <LabelWithInfo info={hint} className="mb-1.5 flex h-4">
        <span className="text-xs font-medium text-muted">{label}</span>
      </LabelWithInfo>
      {children}
    </label>
  );
}

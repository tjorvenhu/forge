import type { ReactNode } from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DIALOG_MOTION, OVERLAY_MOTION } from "@/lib/motion";
import { t } from "@/i18n";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  /** Without content the body is left out, so title and buttons are not separated by an empty strip. */
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** extra classes for the body, e.g. to let the content scroll on its own */
  bodyClassName?: string;
  /** extra classes for the backdrop (it is blurred for every dialog) */
  overlayClassName?: string;
  /** Shows backdrop and dialog over this element (it needs `position: relative`) instead of the whole window. */
  container?: HTMLElement | null;
  /** false: no close button, Escape and clicks outside do nothing; it closes only when `open` turns false */
  dismissable?: boolean;
  /** Title and description only for screen readers; the children bring their own layout without body padding (the setup assistant). */
  hideHeader?: boolean;
}

export function Dialog({ open, onOpenChange, title, description, children, footer, className, bodyClassName, overlayClassName, container, dismissable = true, hideHeader = false }: DialogProps) {
  const keep = dismissable ? undefined : (e: Event) => e.preventDefault();
  const hasBody = children !== undefined && children !== null && children !== false;
  const local = !!container;
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal container={container ?? undefined}>
        <D.Overlay className={cn("fixed inset-0 z-40 bg-overlay backdrop-blur-sm", local && "absolute", OVERLAY_MOTION, overlayClassName)} />
        <D.Content
          onEscapeKeyDown={keep}
          onInteractOutside={keep}
          // Centered with margins, not translate: WebKit (macOS) drops the `translate` property while the pop-in
          // transform animation runs, so the dialog and its buttons landed off-center.
          className={cn(
            "fixed inset-0 z-50 m-auto flex h-fit max-h-[85vh] w-130 max-w-[92vw] flex-col rounded-xl border border-border bg-surface shadow-2xl outline-none",
            local && "absolute max-h-[85%] max-w-[92%]",
            hideHeader && "overflow-hidden",
            DIALOG_MOTION,
            className,
          )}
        >
          {hideHeader ? (
            <>
              <D.Title className="sr-only">{title}</D.Title>
              <D.Description className="sr-only">{description ?? title}</D.Description>
              {children}
            </>
          ) : (
            <>
              <div className={cn("flex items-start justify-between gap-4 px-5 py-4", hasBody && "border-b border-border")}>
                <div>
                  <D.Title className="text-title-sm font-semibold">{title}</D.Title>
                  {description ? (
                    <D.Description className="mt-1 text-body text-muted">{description}</D.Description>
                  ) : (
                    <D.Description className="sr-only">{title}</D.Description>
                  )}
                </div>
                {dismissable && (
                  <D.Close className="rounded-md p-1 text-muted hover:bg-surface-3 hover:text-fg" aria-label={t.ui.close}>
                    <X className="h-4 w-4" />
                  </D.Close>
                )}
              </div>
              {hasBody && <div className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", bodyClassName)}>{children}</div>}
            </>
          )}
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

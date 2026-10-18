import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { Input } from "./input";
import { t } from "@/i18n";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** if set, the user must type this exact text before confirming */
  requireText?: string;
  confirmDisabled?: boolean;
  /** Closes the dialog on success. On failure: show the error yourself, then rethrow to keep the dialog open. */
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel, danger, requireText, confirmDisabled, onConfirm }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = confirmDisabled === true || (requireText !== undefined && typed.trim() !== requireText);

  const close = (o: boolean) => {
    if (!o) setTyped("");
    onOpenChange(o);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={() => close(false)}>
            {t.ui.cancel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            disabled={blocked}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                close(false);
              } catch {
                // Contract: onConfirm shows its own error (toast) and rethrows, so the dialog stays open for another try.
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children || requireText !== undefined ? (
        <>
          {children}
          {requireText !== undefined && (
            <label className={cn("block text-body text-muted", children && "mt-3")}>
              {t.ui.confirmType.before} <span className="font-mono text-fg">{requireText}</span> {t.ui.confirmType.after}
              <Input className="mt-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
          )}
        </>
      ) : null}
    </Dialog>
  );
}

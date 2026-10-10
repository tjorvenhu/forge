import { useState, type ReactNode } from "react";
import { Button } from "./button";
import { Dialog } from "./dialog";
import { Input } from "./input";

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
  onConfirm: () => Promise<void> | void;
}

export function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel, danger, requireText, onConfirm }: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = requireText !== undefined && typed.trim() !== requireText;

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
            Abbrechen
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
      {children}
      {requireText !== undefined && (
        <label className="mt-3 block text-[13px] text-muted">
          Zur Bestätigung <span className="font-mono text-fg">{requireText}</span> eingeben
          <Input className="mt-1.5" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </label>
      )}
    </Dialog>
  );
}

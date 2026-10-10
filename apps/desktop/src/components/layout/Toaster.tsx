import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useToasts } from "@/stores/toast";
import { cn } from "@/lib/utils";

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-96 max-w-[90vw] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={cn(
            "pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface-2 px-3 py-2.5 shadow-xl",
            t.tone === "error" ? "border-danger/40" : t.tone === "success" ? "border-success/40" : "border-border",
          )}
        >
          {t.tone === "success" && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />}
          {t.tone === "error" && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
          {t.tone === "info" && <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{t.title}</div>
            {t.body && <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted">{t.body}</div>}
          </div>
          <button className="rounded p-0.5 text-subtle hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Meldung schließen">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

import { Copy, ExternalLink } from "lucide-react";
import { openExternal } from "@/lib/native";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";

/** One-time code of the GitHub device flow, with copy, open and an optional cancel. */
export function DeviceCode({ code, url, prompt, onCancel, compact = false }: { code: string; url: string; prompt: string; onCancel?: () => void; compact?: boolean }) {
  const copy = () =>
    navigator.clipboard.writeText(code).then(
      () => toast.success("Code kopiert"),
      () => toast.error("Code nicht kopiert", "Die Zwischenablage ist nicht erreichbar. Bitte den Code abtippen."),
    );
  return (
    <div className={cn("flex flex-col items-start", compact ? "gap-2" : "gap-3")}>
      <p className={cn("text-muted", compact ? "text-xs" : "text-body")}>{prompt}</p>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "border border-accent/40 bg-accent-soft font-mono tracking-widest",
            compact ? "rounded-md px-3 py-1 text-base" : "rounded-lg px-4 py-2 text-2xl",
          )}
          aria-label="Einmal-Code"
        >
          {code}
        </span>
        <Button size={compact ? "icon-sm" : "icon"} variant="ghost" aria-label="Code kopieren" onClick={() => void copy()}>
          <Copy className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button size={compact ? "sm" : "md"} variant={compact ? "secondary" : "primary"} onClick={() => void openExternal(url)}>
          <ExternalLink className="h-3.5 w-3.5" /> GitHub öffnen
        </Button>
        {onCancel && (
          <Button size={compact ? "sm" : "md"} variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
        )}
        <span className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3.5 w-3.5" /> Warte auf Bestätigung
        </span>
      </div>
    </div>
  );
}

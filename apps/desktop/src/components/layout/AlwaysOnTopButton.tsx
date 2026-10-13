import { useQueryClient } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { useSettings } from "@/lib/queries";
import { setAlwaysOnTop } from "@/lib/window-options";
import { cn } from "@/lib/utils";

/** Header toggle for the setting "Im Vordergrund bleiben", which holds for every FORGE window. */
export function AlwaysOnTopButton() {
  const qc = useQueryClient();
  const on = useSettings().data?.alwaysOnTop;
  if (on === undefined) return null;
  return (
    <button
      onClick={() => void setAlwaysOnTop(qc, !on)}
      aria-pressed={on}
      aria-label="Im Vordergrund bleiben"
      title={on ? "FORGE bleibt im Vordergrund. Klicken zum Ausschalten" : "FORGE über anderen Fenstern halten"}
      className={cn("flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-body hover:bg-surface-3 hover:text-fg", on ? "text-accent" : "text-muted")}
    >
      <Pin className={cn("h-3.5 w-3.5", on && "fill-current")} />
      <span className="hidden lg:inline">Vordergrund</span>
    </button>
  );
}

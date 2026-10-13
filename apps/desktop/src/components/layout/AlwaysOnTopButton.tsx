import { useQueryClient } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { useSettings } from "@/lib/queries";
import { setAlwaysOnTop } from "@/lib/window-options";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";

/**
 * Header toggle for the setting "Im Vordergrund bleiben", which holds for every FORGE window. Icon
 * only, like the phone next to it: an on/off switch whose state the filled pin already shows.
 */
export function AlwaysOnTopButton() {
  const qc = useQueryClient();
  const on = useSettings().data?.alwaysOnTop;
  if (on === undefined) return null;
  return (
    <Tooltip content={on ? "FORGE bleibt im Vordergrund. Klicken zum Ausschalten" : "FORGE über anderen Fenstern halten"}>
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void setAlwaysOnTop(qc, !on)}
        aria-pressed={on}
        aria-label="Im Vordergrund bleiben"
        className={cn("h-9 w-9 rounded-lg", on && "text-accent hover:text-accent")}
      >
        <Pin className={cn("h-4 w-4", on && "fill-current")} />
      </Button>
    </Tooltip>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { refreshUsage, useUsage } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { UsageWindows, UsageWindowsSkeleton, usageItems, usageUnavailableText } from "@/components/usage/UsageWindows";
import { contextItems } from "@/lib/context-menu";
import { Group } from "./layout";

/** Plan usage per window with the limit forecast (Settings → Claude Code). */
export function UsageSettings() {
  const qc = useQueryClient();
  const usage = useUsage();
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    await refreshUsage(qc);
    setBusy(false);
  };
  return (
    <Group
      title="Nutzung und Prognose"
      description="Die Prognose rechnet mit dem Tempo der letzten Messwerte, neuere zählen mehr. FORGE misst alle fünf Minuten, solange es offen ist."
      action={
        <Button size="sm" variant="ghost" loading={busy} onClick={() => void refresh()}>
          <RefreshCw className="h-3.5 w-3.5" /> Aktualisieren
        </Button>
      }
    >
      <div className="p-4" onContextMenu={contextItems(() => usageItems(qc))}>
        {!usage.data ? (
          <UsageWindowsSkeleton windows={3} />
        ) : usage.data.available ? (
          <UsageWindows usage={usage.data} />
        ) : (
          <div className="text-body text-muted">{usageUnavailableText(usage.data)}</div>
        )}
      </div>
    </Group>
  );
}

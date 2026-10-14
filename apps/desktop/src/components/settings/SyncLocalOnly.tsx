import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudOff, CloudUpload, RotateCcw } from "lucide-react";
import type { SyncLocalOnly } from "@forge/protocol";
import { call, keys, useSyncStatus } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export const LOCAL_ONLY_HINT = "Auf einem anderen PC entfernt. Hier ist es noch da, wird aber nicht mehr über GitHub abgeglichen.";

/** The project's entry when another computer removed it from the sync. */
export function useLocalOnlyProject(projectId: string): SyncLocalOnly | null {
  return useSyncStatus().data?.localOnly.find((x) => x.projectId === projectId) ?? null;
}

function useSyncActions() {
  const qc = useQueryClient();
  const keep = async (item: SyncLocalOnly) => {
    try {
      qc.setQueryData(keys.sync, await call("sync.keep", { key: item.key }));
      toast.success(`${item.label} wird wieder abgeglichen`);
    } catch (e) {
      toast.error("Nicht wieder abgeglichen", errorMessage(e));
    }
  };
  const force = async (item: SyncLocalOnly) => {
    try {
      qc.setQueryData(keys.sync, await call("sync.forceLocal", { key: item.key }));
      await qc.invalidateQueries();
      toast.success(`${item.label} ist auf dem Stand von GitHub`, "Der Stand davor ist als Backup gesichert.");
    } catch (e) {
      toast.error("Nicht zurückgesetzt", errorMessage(e));
      throw e;
    }
  };
  return { keep, force };
}

/** What setting an item hard to GitHub means here: removing it. */
function forceText(item: SyncLocalOnly): string {
  if (item.kind === "project") return `${item.label} wird auf diesem PC aus FORGE entfernt, wie auf dem anderen PC. Der Ordner mit den Dateien bleibt, die Session-Historie in FORGE ist danach weg.`;
  if (item.kind === "claude") return `${item.label} wird auf diesem PC gelöscht.`;
  return `${item.label} wird auf diesem PC entfernt.`;
}

/** Small cloud on the project card. */
export function LocalOnlyBadge({ projectId }: { projectId: string }) {
  const item = useLocalOnlyProject(projectId);
  const openSettings = useUi((u) => u.openSettings);
  if (!item) return null;
  return (
    <button
      type="button"
      className="shrink-0 text-warning"
      title={`Nur auf diesem PC\n${LOCAL_ONLY_HINT}\n\nKlicken, um unter Einstellungen, GitHub zu entscheiden.`}
      onClick={(e) => {
        e.stopPropagation();
        openSettings("github");
      }}
    >
      <CloudOff className="h-3.5 w-3.5" aria-label="Nur auf diesem PC" />
    </button>
  );
}

/** Notice in the project with both choices. */
export function LocalOnlyBanner({ projectId }: { projectId: string }) {
  const item = useLocalOnlyProject(projectId);
  if (!item) return null;
  return (
    <div className="px-4 pt-3">
      <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-2.5">
        <CloudOff className="h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium">Nur auf diesem PC</div>
          <div className="text-xs text-muted">{LOCAL_ONLY_HINT}</div>
        </div>
        <LocalOnlyActions item={item} />
      </div>
    </div>
  );
}

function LocalOnlyActions({ item }: { item: SyncLocalOnly }) {
  const { keep, force } = useSyncActions();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        size="sm"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await keep(item);
          setBusy(false);
        }}
      >
        <CloudUpload className="h-3.5 w-3.5" /> Wieder abgleichen
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
        <RotateCcw className="h-3.5 w-3.5" /> Auf GitHub-Stand setzen
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`${item.label} auf den Stand von GitHub setzen?`}
        description={`${forceText(item)} Vorher legt FORGE ein Backup an.`}
        confirmLabel="Auf GitHub-Stand setzen"
        danger
        onConfirm={() => force(item)}
      />
    </div>
  );
}

/** Everything that is only here, for the sync settings. */
export function LocalOnlyList({ items }: { items: SyncLocalOnly[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-3 px-3 py-2">
          <CloudOff className="h-3.5 w-3.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 truncate text-body">{item.label}</div>
          <LocalOnlyActions item={item} />
        </li>
      ))}
    </ul>
  );
}

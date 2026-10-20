import { GitBranch, Settings2, Undo2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { call, keys, useSettings } from "@/lib/queries";
import { contextItems } from "@/lib/context-menu";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { t } from "@/i18n";

/** Dark red bar between logo and search while FORGE takes its updates from the dev branch; nothing on stable. */
export function DevChannelBadge() {
  const qc = useQueryClient();
  const openSettings = useUi((s) => s.openSettings);
  if (!useDevChannelOn()) return null;
  const b = t.layout.devBadge;
  const toStable = () =>
    call("settings.update", { updateChannel: "stable" })
      .then((next) => qc.setQueryData(keys.settings, next))
      .catch((e: unknown) => toast.error(t.layout.actions.channelFailed, errorMessage(e)));
  return (
    <button
      type="button"
      title={b.title}
      onClick={() => openSettings("about")}
      onContextMenu={contextItems(() => [
        { label: b.openSettings, icon: <Settings2 className="h-3.5 w-3.5" />, onSelect: () => openSettings("about") },
        { label: b.toStable, icon: <Undo2 className="h-3.5 w-3.5" />, onSelect: () => void toStable() },
      ])}
      className="mx-3 mb-3 flex h-7 items-center justify-center gap-1.5 rounded-md border border-dev-border bg-dev font-mono text-caption font-bold uppercase tracking-widest text-dev-fg shadow-sm hover:brightness-125"
    >
      <GitBranch className="h-3.5 w-3.5" />
      {b.label}
    </button>
  );
}

/** Whether FORGE takes its updates from the dev branch. */
export function useDevChannelOn(): boolean {
  return useSettings().data?.updateChannel === "dev";
}

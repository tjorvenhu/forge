import { useState } from "react";
import { FileText, ImageIcon, Smartphone, Undo2 } from "lucide-react";
import type { RewindResult } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { clockTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ChatItem } from "./chat-items";

/** A prompt of the user, with rewinding the files to the state before it. */
export function UserMessage({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId: string }) {
  const [preview, setPreview] = useState<RewindResult | null>(null);
  const [loading, setLoading] = useState(false);
  const check = async () => {
    if (!item.uuid) return;
    setLoading(true);
    try {
      const r = await call("sessions.rewind", { sessionId, messageUuid: item.uuid, dryRun: true });
      if (!r.canRewind) toast.info("Nichts zurückzusetzen", r.error ?? "Seit dieser Nachricht hat Claude keine Dateien geändert.");
      else setPreview(r);
    } catch (e) {
      toast.error("Prüfung fehlgeschlagen", errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="group relative flex gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent-soft text-small font-semibold text-accent">Du</div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3">
        {item.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.attachments.map((a, i) => (
              <span key={i} className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-caption text-muted">
                {a.mediaType.startsWith("image/") ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                {a.name}
              </span>
            ))}
          </div>
        )}
        <div className="flex min-w-0 items-start gap-4">
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ui leading-relaxed">{item.text}</div>
          <div className="flex shrink-0 items-center gap-1 pt-0.5 text-caption-lg text-subtle">
            {item.remote && (
              <span className="flex items-center gap-0.5" title="In der Claude-App geschrieben">
                <Smartphone className="h-3 w-3" /> App
              </span>
            )}
            {clockTime(item.ts)}
          </div>
        </div>
      </div>
      {item.uuid && (
        <Tooltip content="Dateien auf den Stand vor dieser Nachricht zurücksetzen">
          <Button size="icon-sm" variant="ghost" className="absolute -right-9 top-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void check()} loading={loading} aria-label="Dateien auf diesen Stand zurücksetzen">
            {!loading && <Undo2 className="h-3.5 w-3.5" />}
          </Button>
        </Tooltip>
      )}
      <ConfirmDialog
        open={!!preview}
        onOpenChange={(o) => !o && setPreview(null)}
        title="Dateien zurücksetzen?"
        description="Alle Dateiänderungen, die Claude seit dieser Nachricht gemacht hat, werden rückgängig gemacht. Der Chatverlauf bleibt erhalten."
        confirmLabel="Zurücksetzen"
        danger
        onConfirm={async () => {
          if (!item.uuid) return;
          try {
            const r = await call("sessions.rewind", { sessionId, messageUuid: item.uuid, dryRun: false });
            if (r.canRewind) toast.success("Zurückgesetzt", `${r.filesChanged.length} Datei(en)`);
            else toast.error("Nicht zurückgesetzt", r.error ?? "");
          } catch (e) {
            toast.error("Nicht zurückgesetzt", errorMessage(e));
            throw e;
          }
        }}
      >
        <div className="text-xs text-muted">
          +{preview?.insertions ?? 0} / -{preview?.deletions ?? 0} Zeilen
        </div>
        <ul className="mt-2 max-h-48 overflow-y-auto font-mono text-xs">
          {preview?.filesChanged.map((f) => (
            <li key={f} className="truncate py-0.5">
              {f}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

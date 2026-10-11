import { useState } from "react";
import { FileText, ImageIcon, Smartphone, TimerReset, Undo2 } from "lucide-react";
import type { RewindResult } from "@forge/protocol";
import { call, useGitHubAccount } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { clockTime, cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ChatItem } from "./chat-items";
import { ChatRow, HoverTime } from "./ChatRow";

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
  const hasMeta = item.attachments.length > 0 || item.remote || item.auto;
  return (
    <div className="group -mx-3 rounded-md bg-surface-2 px-3 py-2.5">
      <ChatRow className="text-ui leading-[1.65]" marker={<UserAvatar />}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 max-w-[90ch] flex-1">
            <div className="whitespace-pre-wrap break-words">{item.text}</div>
            {hasMeta && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption leading-normal text-subtle">
                {item.attachments.map((a, i) => (
                  <span key={i} className="flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-muted">
                    {a.mediaType.startsWith("image/") ? <ImageIcon className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                    {a.name}
                  </span>
                ))}
                {item.remote && (
                  <span className="flex items-center gap-1" title="In der Claude-App geschrieben">
                    <Smartphone className="h-3 w-3" /> App
                  </span>
                )}
                {item.auto && (
                  <span className="flex items-center gap-1" title="Von FORGE gesendet, nachdem das Nutzungslimit zurückgesetzt war">
                    <TimerReset className="h-3 w-3" /> Automatisch
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="ml-auto flex h-[1lh] shrink-0 items-center gap-1">
            <HoverTime time={clockTime(item.ts)} />
            {item.uuid && (
              <Tooltip content="Dateien auf den Stand vor dieser Nachricht zurücksetzen">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className={cn("opacity-0 group-hover:opacity-100 focus-visible:opacity-100", loading && "opacity-100")}
                  onClick={() => void check()}
                  loading={loading}
                  aria-label="Dateien auf diesen Stand zurücksetzen"
                >
                  {!loading && <Undo2 className="h-3.5 w-3.5" />}
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      </ChatRow>
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

/** Your GitHub picture when gh is signed in, otherwise a "Du" badge. */
function UserAvatar() {
  const avatarUrl = useGitHubAccount().data?.avatarUrl;
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return <img src={avatarUrl} alt="Du" width={22} height={22} className="h-5.5 w-5.5 shrink-0 rounded-full border border-border" onError={() => setFailed(true)} />;
  }
  return (
    <span aria-label="Du" role="img" className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent-soft text-3xs font-semibold text-accent">
      Du
    </span>
  );
}

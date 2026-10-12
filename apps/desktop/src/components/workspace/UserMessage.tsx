import { useState } from "react";
import { FileText, GitBranch, ImageIcon, Smartphone, TimerReset, Undo2 } from "lucide-react";
import type { RewindResult } from "@forge/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { call, keys, useGitHubAccount, useSession } from "@/lib/queries";
import { draftKey, useDrafts } from "@/stores/drafts";
import { useUi } from "@/stores/ui";
import { errorMessage } from "@/lib/rpc";
import { clockTime, cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ToggleRow, Tooltip } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { ChatItem } from "./chat-items";
import { ChatRow, HoverTime } from "./ChatRow";
import { MessageImages, useMessageImages } from "./MessageImages";

/** A prompt of the user, with rewinding the files to the state before it and branching the conversation there. */
export function UserMessage({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId: string }) {
  const [preview, setPreview] = useState<RewindResult | null>(null);
  const [forkOpen, setForkOpen] = useState(false);
  const [forkFiles, setForkFiles] = useState(false);
  const projectId = useSession(sessionId).data?.projectId ?? null;
  const qc = useQueryClient();
  const fork = async () => {
    if (!projectId) return;
    try {
      const r = await call("sessions.fork", { sessionId, beforeSeq: item.seq, rewindFiles: forkFiles });
      const target = r.session?.id ?? null;
      if (r.session) qc.setQueryData(keys.session(r.session.id), r.session);
      void qc.invalidateQueries({ queryKey: keys.sessions(projectId) });
      // The prompt waits in the composer of the branch, to be changed and sent again.
      useDrafts.getState().setText(draftKey(projectId, target), r.prompt ?? "");
      useUi.getState().setActiveSession(projectId, target);
      toast.success(
        r.session ? "Zweig erstellt" : "Neu begonnen",
        [r.session ? "Der Verlauf bis vor dieser Nachricht ist übernommen, das Original bleibt." : "Vor der ersten Nachricht gibt es keinen Verlauf: neue Session.", r.filesChanged ? `${r.filesChanged.length} Datei(en) zurückgesetzt.` : ""]
          .filter(Boolean)
          .join(" "),
      );
    } catch (e) {
      toast.error("Nicht verzweigt", errorMessage(e));
      throw e;
    }
  };
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
  const imageNames = item.attachments.filter((a) => a.mediaType.startsWith("image/")).map((a) => a.name);
  const images = useMessageImages(sessionId, item.seq, imageNames.length > 0);
  // Without the transcript (e.g. after /clear) the images fall back to their name chips.
  const showImages = imageNames.length > 0 && !images.isError && (images.data?.length ?? 1) > 0;
  const chips = showImages ? item.attachments.filter((a) => !a.mediaType.startsWith("image/")) : item.attachments;
  const hasMeta = chips.length > 0 || item.remote || item.auto;
  return (
    <div className="group -mx-3 rounded-md bg-surface-2 px-3 py-2.5">
      <ChatRow className="text-ui leading-[1.65]" marker={<UserAvatar />}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 max-w-[90ch] flex-1">
            <div className="whitespace-pre-wrap break-words">{item.text}</div>
            {showImages && <MessageImages images={images.data} names={imageNames} />}
            {hasMeta && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption leading-normal text-subtle">
                {chips.map((a, i) => (
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
              <Tooltip content="Ab hier verzweigen: neuer Versuch mit dieser Nachricht, das Original bleibt">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => setForkOpen(true)}
                  aria-label="Ab hier verzweigen"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
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
        open={forkOpen}
        onOpenChange={(o) => {
          setForkOpen(o);
          if (!o) setForkFiles(false);
        }}
        title="Ab hier verzweigen?"
        description="FORGE legt eine neue Session mit dem Verlauf bis vor dieser Nachricht an. Die Nachricht steht im Eingabefeld, du kannst sie ändern und neu senden. Die bisherige Session bleibt unverändert."
        confirmLabel="Verzweigen"
        onConfirm={fork}
      >
        <ToggleRow checked={forkFiles} onChange={setForkFiles} label="Dateien auch zurücksetzen">
          Macht die Dateiänderungen rückgängig, die Claude seit dieser Nachricht gemacht hat. Gilt für den Projektordner, also auch für die bisherige Session.
        </ToggleRow>
      </ConfirmDialog>
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
export function UserAvatar() {
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

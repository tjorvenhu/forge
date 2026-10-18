import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { closeChatWindows } from "@/lib/chat-windows";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { useDrafts } from "@/stores/drafts";
import { useSessionEvents } from "@/stores/session-events";
import { toast } from "@/stores/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox } from "@/components/ui/misc";
import { t } from "@/i18n";

/** Confirms and deletes every session in FORGE, optionally together with the Claude Code transcripts. */
export function DeleteAllSessionsDialog({ open, liveCount, onClose }: { open: boolean; liveCount: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [withTranscript, setWithTranscript] = useState(true);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t.workspace.deleteSession.allTitle}
      description={t.workspace.deleteSession.allDescription(liveCount)}
      confirmLabel={t.workspace.deleteSession.deleteAll}
      danger
      requireText={t.workspace.deleteSession.confirmWord}
      onConfirm={async () => {
        let result;
        try {
          result = await call("sessions.deleteAll", { deleteTranscript: withTranscript });
        } catch (e) {
          toast.error(t.workspace.deleteSession.allNotDeleted, errorMessage(e));
          throw e;
        }
        const deleted = new Set(result.deleted);
        closeChatWindows(deleted);
        useUi.getState().forgetSessions(deleted);
        for (const id of deleted) {
          useDrafts.getState().clear(id);
          useSessionEvents.getState().drop(id);
          qc.removeQueries({ queryKey: keys.session(id) });
        }
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        void qc.invalidateQueries({ queryKey: ["allSessions"] });
        void qc.invalidateQueries({ queryKey: keys.liveSessions });
        if (result.failed > 0) {
          toast.error(t.workspace.deleteSession.someNotDeleted(result.failed), result.error ?? undefined);
          throw new Error(result.error ?? "");
        }
        toast.success(t.workspace.deleteSession.deletedCount(deleted.size));
      }}
    >
      <label className="flex items-start gap-2.5 text-body">
        <span className="mt-0.5">
          <Checkbox checked={withTranscript} onChange={setWithTranscript} label={t.workspace.deleteSession.alsoClaude} />
        </span>
        <span>
          <span className="block">{t.workspace.deleteSession.alsoClaude}</span>
          <span className="block text-xs text-muted">
            {t.workspace.deleteSession.alsoClaudeAllHint}
          </span>
        </span>
      </label>
    </ConfirmDialog>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@forge/protocol";
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

type SessionRef = Pick<Session, "id" | "projectId" | "title" | "claudeSessionId" | "live">;

/** Confirms and deletes a session from FORGE, optionally together with the Claude Code transcript. */
export function DeleteSessionDialog({ session, onClose }: { session: SessionRef | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [withTranscript, setWithTranscript] = useState(true);
  const s = session;

  return (
    <ConfirmDialog
      open={!!s}
      onOpenChange={(o) => !o && onClose()}
      title={t.workspace.deleteSession.title}
      description={t.workspace.deleteSession.description(s?.title ?? t.workspace.deleteSession.untitled, !!s?.live)}
      confirmLabel={t.workspace.deleteSession.delete}
      danger
      onConfirm={async () => {
        if (!s) return;
        try {
          await call("sessions.delete", { sessionId: s.id, deleteTranscript: withTranscript });
          closeChatWindows([s.id]);
          useUi.getState().forgetSessions([s.id]);
          useDrafts.getState().clear(s.id);
          useSessionEvents.getState().drop(s.id);
          qc.removeQueries({ queryKey: keys.session(s.id) });
          void qc.invalidateQueries({ queryKey: keys.sessions(s.projectId) });
          void qc.invalidateQueries({ queryKey: ["allSessions"] });
          void qc.invalidateQueries({ queryKey: keys.liveSessions });
          toast.success(t.workspace.deleteSession.deleted);
        } catch (e) {
          toast.error(t.workspace.deleteSession.notDeleted, errorMessage(e));
          throw e;
        }
      }}
    >
      {s?.claudeSessionId && (
        <label className="flex items-start gap-2.5 text-body">
          <span className="mt-0.5">
            <Checkbox checked={withTranscript} onChange={setWithTranscript} label={t.workspace.deleteSession.alsoClaude} />
          </span>
          <span>
            <span className="block">{t.workspace.deleteSession.alsoClaude}</span>
            <span className="block text-xs text-muted">
              {t.workspace.deleteSession.alsoClaudeHint}
            </span>
          </span>
        </label>
      )}
    </ConfirmDialog>
  );
}

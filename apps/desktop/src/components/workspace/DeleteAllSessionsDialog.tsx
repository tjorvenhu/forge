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

/** Confirms and deletes every session in FORGE, optionally together with the Claude Code transcripts. */
export function DeleteAllSessionsDialog({ open, liveCount, onClose }: { open: boolean; liveCount: number; onClose: () => void }) {
  const qc = useQueryClient();
  const [withTranscript, setWithTranscript] = useState(true);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Alle Sessions löschen?"
      description={`Alle Sessions aller Projekte werden mit ihrem Verlauf aus FORGE entfernt.${
        liveCount > 0 ? ` ${liveCount === 1 ? "Der laufende Claude-Prozess wird" : `Die ${liveCount} laufenden Claude-Prozesse werden`} beendet.` : ""
      } Dateien in den Projekten bleiben unverändert.`}
      confirmLabel="Alle löschen"
      danger
      requireText="LÖSCHEN"
      onConfirm={async () => {
        let result;
        try {
          result = await call("sessions.deleteAll", { deleteTranscript: withTranscript });
        } catch (e) {
          toast.error("Sessions nicht gelöscht", errorMessage(e));
          throw e;
        }
        const deleted = new Set(result.deleted);
        closeChatWindows(deleted);
        const ui = useUi.getState();
        for (const [projectId, sessionId] of Object.entries(ui.activeSession)) {
          if (sessionId && deleted.has(sessionId)) ui.setActiveSession(projectId, null);
        }
        for (const id of deleted) {
          useDrafts.getState().clear(id);
          useSessionEvents.getState().drop(id);
          qc.removeQueries({ queryKey: keys.session(id) });
        }
        void qc.invalidateQueries({ queryKey: ["sessions"] });
        void qc.invalidateQueries({ queryKey: ["allSessions"] });
        void qc.invalidateQueries({ queryKey: keys.liveSessions });
        if (result.failed > 0) {
          toast.error(`${result.failed} ${result.failed === 1 ? "Session" : "Sessions"} nicht gelöscht`, result.error ?? undefined);
          throw new Error(result.error ?? "");
        }
        toast.success(deleted.size === 1 ? "1 Session gelöscht" : `${deleted.size} Sessions gelöscht`);
      }}
    >
      <label className="flex items-start gap-2.5 text-body">
        <span className="mt-0.5">
          <Checkbox checked={withTranscript} onChange={setWithTranscript} label="Auch aus Claude Code löschen" />
        </span>
        <span>
          <span className="block">Auch aus Claude Code löschen</span>
          <span className="block text-xs text-muted">
            Entfernt die Transkripte, damit die Sessions nicht mehr in „claude --resume“ erscheinen. Ohne Haken tauchen sie in den Projekten wieder als Terminal-Sessions auf.
          </span>
        </span>
      </label>
    </ConfirmDialog>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Session } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { useDrafts } from "@/stores/drafts";
import { useSessionEvents } from "@/stores/session-events";
import { toast } from "@/stores/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox } from "@/components/ui/misc";

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
      title="Session löschen?"
      description={`„${s?.title ?? "Ohne Titel"}“ wird mit dem ganzen Verlauf aus FORGE entfernt.${s?.live ? " Der laufende Claude-Prozess wird beendet." : ""} Dateien im Projekt bleiben unverändert.`}
      confirmLabel="Löschen"
      danger
      onConfirm={async () => {
        if (!s) return;
        try {
          await call("sessions.delete", { sessionId: s.id, deleteTranscript: withTranscript });
          const ui = useUi.getState();
          if (ui.activeSession[s.projectId] === s.id) ui.setActiveSession(s.projectId, null);
          useDrafts.getState().clear(s.id);
          useSessionEvents.getState().drop(s.id);
          qc.removeQueries({ queryKey: keys.session(s.id) });
          void qc.invalidateQueries({ queryKey: keys.sessions(s.projectId) });
          void qc.invalidateQueries({ queryKey: ["allSessions"] });
          void qc.invalidateQueries({ queryKey: keys.liveSessions });
          toast.success("Session gelöscht");
        } catch (e) {
          toast.error("Session nicht gelöscht", errorMessage(e));
          throw e;
        }
      }}
    >
      {s?.claudeSessionId && (
        <label className="flex items-start gap-2.5 text-body">
          <span className="mt-0.5">
            <Checkbox checked={withTranscript} onChange={setWithTranscript} label="Auch aus Claude Code löschen" />
          </span>
          <span>
            <span className="block">Auch aus Claude Code löschen</span>
            <span className="block text-xs text-muted">
              Entfernt das Transkript, damit die Session nicht mehr in „claude --resume“ erscheint. Ohne Haken taucht sie im Projekt wieder als Terminal-Session auf.
            </span>
          </span>
        </label>
      )}
    </ConfirmDialog>
  );
}

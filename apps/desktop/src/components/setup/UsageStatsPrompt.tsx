import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { USAGE_STATS_URL } from "@forge/protocol";
import { call, keys, useSettings } from "@/lib/queries";
import { openExternal } from "@/lib/native";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * Asks once about the anonymous usage statistics, after the setup assistant and the sync question.
 * Unanswered they stay on; closing asks again on the next start.
 */
export function UsageStatsPrompt() {
  const s = useSettings().data;
  const wizard = useUi((u) => u.setupWizard);
  const [later, setLater] = useState(false);
  if (!s || !s.setupDone || !s.syncAsked || s.usageStatsAsked || wizard || later) return null;
  return <Prompt onLater={() => setLater(true)} />;
}

function Prompt({ onLater }: { onLater: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<boolean | null>(null);
  const answer = async (usageStats: boolean) => {
    setBusy(usageStats);
    try {
      qc.setQueryData(keys.settings, await call("settings.update", { usageStats, usageStatsAsked: true }));
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onLater()}
      title="Anonyme Nutzungsstatistik"
      description="Alle 5 Minuten schickt FORGE Summen an den Statistik-Dienst von FORGE. Daraus entstehen die öffentlichen Gesamtzahlen aller Nutzer."
      className="w-150"
      overlayClassName="backdrop-blur-sm"
      bodyClassName="flex flex-col gap-3 text-body"
      footer={
        <>
          <Button variant="ghost" onClick={() => void answer(false)} loading={busy === false} disabled={busy !== null}>
            Ausschalten
          </Button>
          <Button variant="primary" onClick={() => void answer(true)} loading={busy === true} disabled={busy !== null}>
            Einverstanden
          </Button>
        </>
      }
    >
      <div>
        <div className="mb-1 font-medium">Gesendet wird</div>
        <p className="text-muted">
          Eine zufällige Kennung dieser Installation, die FORGE-Version, die Windows-Version und Zählerstände: verbrauchte Tokens, Claude-Arbeitszeit, Sessions, angelegte
          Projekte, gestartete und zusammengeführte Agenten, Telefonate.
        </p>
      </div>
      <div>
        <div className="mb-1 font-medium">Nicht gesendet wird</div>
        <p className="text-muted">Keine Inhalte aus Chats oder Dateien, keine Projektnamen, keine Pfade, nichts über dein Claude- oder GitHub-Konto. Der Dienst speichert keine IP-Adressen.</p>
      </div>
      <p className="text-xs text-muted">
        Ohne Antwort bleibt die Statistik an. Ausschalten geht jederzeit unter Einstellungen, Über FORGE, Datenschutz; dann löscht FORGE die gesendeten Daten beim Dienst.{" "}
        <a
          href={USAGE_STATS_URL}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(USAGE_STATS_URL);
          }}
          className="underline hover:text-fg"
        >
          Gesamtzahlen ansehen
        </a>
      </p>
    </Dialog>
  );
}

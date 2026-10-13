import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Settings } from "@forge/protocol";
import { call, keys, useGitHubAccount, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { GitHubAccountCard, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { SyncOffer, useEnableSync, useNeedsPassphrase } from "./SyncOffer";

/**
 * Asks once, on the start after the sync came in, whether FORGE's data should go to a private
 * GitHub repository. New installations answer it in the setup assistant. Closing without an answer
 * asks again on the next start.
 */
export function SyncPrompt() {
  const s = useSettings().data;
  const wizard = useUi((u) => u.setupWizard);
  const [later, setLater] = useState(false);
  if (!s || !s.setupDone || s.syncAsked || wizard || later) return null;
  return <Prompt s={s} onLater={() => setLater(true)} />;
}

function Prompt({ s, onLater }: { s: Settings; onLater: () => void }) {
  const qc = useQueryClient();
  const account = useGitHubAccount();
  const openSettings = useUi((u) => u.openSettings);
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const needsPassphrase = useNeedsPassphrase();
  const enableSync = useEnableSync();
  useAutoOpenGitHub();

  const answer = async (syncEnabled: boolean) => {
    setBusy(true);
    try {
      if (syncEnabled) await enableSync(passphrase);
      else qc.setQueryData(keys.settings, await call("settings.update", { syncEnabled: false, syncAsked: true }));
      if (syncEnabled) {
        toast.success("Synchronisierung ist an", "Ein- und ausschalten unter Einstellungen, Synchronisierung.");
        openSettings("sync");
      }
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onLater()}
      title="FORGE-Daten über GitHub synchronisieren?"
      description="Dann hat FORGE auf jedem PC, auf dem du dich mit demselben GitHub-Konto anmeldest, dieselben Projekte und Einstellungen."
      className="w-150"
      overlayClassName="backdrop-blur-sm"
      bodyClassName="flex flex-col gap-4"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={onLater} disabled={busy}>
            Später
          </Button>
          <Button variant="ghost" onClick={() => void answer(false)} disabled={busy}>
            Nein, danke
          </Button>
          <Button variant="primary" loading={busy} disabled={!account.data || !on || (needsPassphrase && !passphrase)} onClick={() => void answer(true)}>
            Synchronisieren
          </Button>
        </>
      }
    >
      {!account.data && (
        <div className="rounded-lg border border-border p-4">
          <GitHubAccountCard />
        </div>
      )}
      <SyncOffer checked={on && !!account.data} onChange={setOn} onPassphrase={setPassphrase} />
      {s.syncEnabled && <p className="text-xs text-muted">Die Synchronisierung ist bereits an.</p>}
    </Dialog>
  );
}

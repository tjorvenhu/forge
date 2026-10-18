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
import { t } from "@/i18n";
import { SyncOffer, useEnableSync, useNeedsPassphrase } from "./SyncOffer";

const tp = t.setup.syncPrompt;

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
      if (!syncEnabled) {
        qc.setQueryData(keys.settings, await call("settings.update", { syncEnabled: false, syncAsked: true }));
        return;
      }
      const firstSync = await enableSync(passphrase);
      if (firstSync) toast.info(t.setup.syncOn, t.setup.firstSyncFailed(firstSync));
      else toast.success(t.setup.syncOn, tp.enabledDetail);
      openSettings("github");
    } catch (e) {
      toast.error(t.setup.notSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onLater()}
      title={tp.title}
      description={tp.description}
      className="w-150"
      bodyClassName="flex flex-col gap-4"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={onLater} disabled={busy}>
            {tp.later}
          </Button>
          <Button variant="ghost" onClick={() => void answer(false)} disabled={busy}>
            {tp.noThanks}
          </Button>
          <Button variant="primary" loading={busy} disabled={!account.data || !on || (needsPassphrase && !passphrase)} onClick={() => void answer(true)}>
            {tp.sync}
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
      {s.syncEnabled && <p className="text-xs text-muted">{tp.alreadyOn}</p>}
    </Dialog>
  );
}

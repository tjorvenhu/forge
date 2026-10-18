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
import { t } from "@/i18n";

const tu = t.setup.usageStats;

/**
 * Asks once about the anonymous usage statistics, after the setup assistant and the sync question.
 * Unanswered they stay off (DEFAULT_SETTINGS.usageStats); closing asks again on the next start.
 * Recommends switching on, without pressure: declining is a full button of its own.
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
      toast.error(tu.notSaved, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onLater()}
      title={tu.title}
      description={tu.description}
      className="w-150"
      bodyClassName="flex flex-col gap-3 text-body"
      footer={
        <>
          <Button variant="ghost" onClick={() => void answer(false)} loading={busy === false} disabled={busy !== null}>
            {tu.noThanks}
          </Button>
          <Button variant="primary" onClick={() => void answer(true)} loading={busy === true} disabled={busy !== null}>
            {tu.enable}
          </Button>
        </>
      }
    >
      <div>
        <div className="mb-1 font-medium">{tu.sentTitle}</div>
        <p className="text-muted">{tu.sent}</p>
      </div>
      <div>
        <div className="mb-1 font-medium">{tu.notSentTitle}</div>
        <p className="text-muted">{tu.notSent}</p>
      </div>
      <p>{tu.why}</p>
      <p className="text-xs text-muted">
        {tu.fineprint}{" "}
        <a
          href={USAGE_STATS_URL}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(USAGE_STATS_URL);
          }}
          className="underline hover:text-fg"
        >
          {tu.viewTotals}
        </a>
      </p>
    </Dialog>
  );
}

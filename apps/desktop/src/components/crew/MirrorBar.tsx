import { useState } from "react";
import { Download, Eye, Radio } from "lucide-react";
import type { Session } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

const m = t.crew;

/**
 * In place of the composer of a crew member's session shown here: whose it is, whether it is still
 * live, and the way to an own copy (takeover) or out of the live view.
 */
export function MirrorBar({ session }: { session: Session & { mirror: NonNullable<Session["mirror"]> } }) {
  const mi = session.mirror;
  const [busy, setBusy] = useState<"take" | "stop" | null>(null);
  const takeover = async () => {
    setBusy("take");
    try {
      await call("crew.shareAsk", { crewId: mi.crewId, memberId: mi.memberId, agentId: mi.remoteSessionId, mode: "takeover" });
      toast.info(m.shareAsked(mi.memberName), m.takeoverSessionHint);
    } catch (e) {
      toast.error(m.notAsked, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const stop = async () => {
    setBusy("stop");
    try {
      await call("crew.shareStop", { crewId: mi.crewId, requestId: mi.requestId });
      toast.success(m.mirrorStopped);
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="shrink-0 border-t border-border bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-2/60 px-3 py-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">{mi.live ? <Radio className="h-4 w-4 animate-soft-pulse" /> : <Eye className="h-4 w-4" />}</span>
        <div className="min-w-0 flex-1">
          <div className="text-small font-medium">{mi.live ? m.mirrorLive(mi.memberName) : m.mirrorEnded(mi.memberName, relativeTime(session.updatedAt))}</div>
          <div className="text-caption-lg text-muted">
            {m.mirrorReadOnly} · {m.takeoverSessionHint}
          </div>
        </div>
        {mi.live && (
          <Button size="sm" variant="ghost" loading={busy === "stop"} disabled={!!busy} onClick={() => void stop()}>
            {m.mirrorStop}
          </Button>
        )}
        <Button size="sm" variant="primary" loading={busy === "take"} disabled={!!busy} onClick={() => void takeover()}>
          <Download className="h-3.5 w-3.5" /> {m.mirrorTakeover}
        </Button>
      </div>
    </div>
  );
}

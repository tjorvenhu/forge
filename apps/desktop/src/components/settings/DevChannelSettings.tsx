import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { GitMerge, RefreshCw } from "lucide-react";
import type { Settings } from "@forge/protocol";
import { call, keys, useDevChannel } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Row } from "./layout";
import { t } from "@/i18n";

const dv = t.views.settings.devChannel;
/** commits listed in the confirmation; the rest as "and n more" */
const LISTED = 8;

/**
 * Updates from the dev branch (switch) and bringing dev into main. Dev can only be switched on by an account
 * that may push to the repository; the sidecar checks that again when the setting is saved.
 */
export function DevChannelSettings({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const qc = useQueryClient();
  const dev = useDevChannel();
  const [refreshing, setRefreshing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [release, setRelease] = useState(true);
  const st = dev.data;

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(keys.devChannel, await call("app.devChannel", { refresh: true }));
    } catch (e) {
      toast.error(dv.checking, errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };

  const promote = async () => {
    try {
      const r = await call("app.promoteDev", { release });
      if (r.mode === "none") toast.info(dv.nothing);
      else toast.success(dv.promoted, `${r.mode === "fast-forward" ? dv.promotedFastForward : dv.promotedMerge}${r.releaseStarted ? dv.releaseStarted : ""}`);
      void qc.invalidateQueries({ queryKey: keys.devChannel });
    } catch (e) {
      toast.error(dv.promoteFailed, errorMessage(e));
      throw e;
    }
  };

  const allowed = st?.allowed ?? false;
  const description = s.updateChannel === "dev" ? dv.devDescription(st?.repo ?? "vanturis/forge") : dv.stableDescription;
  const hint = st && !allowed ? (st.message ?? dv.membersOnly(st.repo)) : null;
  const ahead = st?.ahead ?? null;
  const commits = st?.commits ?? [];

  return (
    <>
      <Row
        label={dv.label}
        description={
          <>
            {description}
            {hint && <span className="mt-1 block text-warning">{hint}</span>}
          </>
        }
      >
        {dev.isPending ? (
          <SkeletonRegion label={dv.checking} className="flex items-center gap-4">
            <Skeleton className="h-5 w-9 rounded-full" />
            <Skeleton className="h-7 w-7" />
          </SkeletonRegion>
        ) : (
          <div className="flex items-center gap-3">
            <Switch
              checked={s.updateChannel === "dev"}
              onChange={(on) => void save({ updateChannel: on ? "dev" : "stable" })}
              label={dv.label}
              // Switching off always works, also after the access is gone.
              disabled={!allowed && s.updateChannel !== "dev"}
            />
            <Button size="icon-sm" variant="ghost" title={dv.refresh} aria-label={dv.refresh} loading={refreshing} onClick={() => void refresh()}>
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </Row>
      {allowed && st && s.updateChannel === "dev" && (
        <Row
          label={dv.promoteLabel}
          description={ahead === null ? (st.message ?? "") : ahead === 0 ? dv.even : `${dv.ahead(ahead)}${st.behind ? dv.behind(st.behind) : ""}`}
        >
          <Button size="sm" variant="outline" disabled={!ahead} onClick={() => setConfirm(true)}>
            <GitMerge className="h-3.5 w-3.5" /> {dv.promote}
          </Button>
        </Row>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={dv.confirmTitle}
        description={dv.confirmText(ahead ?? 0)}
        confirmLabel={dv.promote}
        onConfirm={promote}
      >
        <div className="flex flex-col gap-3">
          {commits.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-body text-muted">
              {commits.slice(0, LISTED).map((c, i) => (
                <li key={i} className="truncate">
                  {c}
                </li>
              ))}
              {(ahead ?? 0) > LISTED && <li className="list-none">{dv.more((ahead ?? 0) - LISTED)}</li>}
            </ul>
          )}
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-body font-medium">{dv.releaseLabel}</span>
              <span className="text-caption text-muted">{dv.releaseDescription}</span>
            </div>
            <Switch checked={release} onChange={setRelease} label={dv.releaseLabel} />
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}

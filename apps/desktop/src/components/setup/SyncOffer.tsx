import { useQueryClient } from "@tanstack/react-query";
import { CloudDownload } from "lucide-react";
import { call, keys, useGitHubAccount, useSyncProbe, useSyncStatus } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";
import { InfoTip } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SYNC_EXCLUDED, SYNC_INCLUDED } from "@/components/settings/SyncSettings";
import { SyncPassphraseFields } from "@/components/settings/SyncPassphrase";

/** Whether switching sync on here still needs the sync password (none stored on this computer yet). */
export function useNeedsPassphrase(): boolean {
  return !useSyncStatus().data?.hasKey;
}

/**
 * Switches sync on: stores the password first (it must open data that is already on GitHub), then
 * the setting, then waits for the first sync so what came from GitHub is there.
 */
export function useEnableSync() {
  const qc = useQueryClient();
  return async (passphrase: string | null) => {
    if (passphrase) qc.setQueryData(keys.sync, await call("sync.setPassphrase", { passphrase }));
    qc.setQueryData(keys.settings, await call("settings.update", { syncEnabled: true, syncAsked: true }));
    qc.setQueryData(keys.sync, await call("sync.now", {}));
  };
}

/**
 * The choice whether to sync over GitHub, with what the account's sync repository already holds and
 * the sync password. Shared by the setup assistant and the one-time question on start.
 */
export function SyncOffer({ checked, onChange, onPassphrase }: { checked: boolean; onChange: (v: boolean) => void; onPassphrase: (p: string | null) => void }) {
  const account = useGitHubAccount();
  const probe = useSyncProbe(!!account.data);
  const needsPassphrase = useNeedsPassphrase();
  const p = probe.data;
  return (
    <div className="flex flex-col gap-3">
      {account.data &&
        (probe.isLoading ? (
          <SkeletonRegion label="Sieht im Sync-Repository nach" className="flex items-center gap-3 rounded-lg border border-border p-3">
            <Skeleton className="h-4 w-4 rounded" />
            <Skeleton className="h-3 w-3/4" />
          </SkeletonRegion>
        ) : p?.found ? (
          <div className="flex items-start gap-3 rounded-lg border border-accent/30 bg-accent-soft p-3">
            <CloudDownload className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <p className="text-body">
              In {p.repo} liegen schon verschlüsselte FORGE-Daten von {p.device}
              {p.updatedAt ? `, Stand ${relativeTime(p.updatedAt)}` : ""}. Mit der Synchronisierung und ihrem Sync-Passwort übernimmt FORGE sie hier.
            </p>
          </div>
        ) : null)}
      <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-body font-medium">
              Daten über GitHub synchronisieren
              <InfoTip>{SYNC_EXCLUDED}</InfoTip>
            </div>
            <p className="mt-0.5 text-xs text-muted">{account.data ? `Verschlüsselt im privaten Repository ${account.data.login}/forge-data: ${SYNC_INCLUDED}` : "Dafür zuerst oben bei GitHub anmelden."}</p>
          </div>
          <Switch checked={checked} onChange={onChange} disabled={!account.data} label="Daten über GitHub synchronisieren" />
        </div>
        {checked && needsPassphrase && !probe.isLoading && <SyncPassphraseFields existing={!!p?.found} onChange={onPassphrase} />}
      </div>
    </div>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudDownload, ExternalLink, KeyRound, RefreshCw, RotateCcw, Upload } from "lucide-react";
import type { Settings, SyncStatus } from "@forge/protocol";
import { call, keys, useGitHubAccount, useSyncProbe, useSyncStatus } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { KeyValueSkeleton } from "@/components/ui/skeleton";
import { Group, Row, SwitchRow } from "./layout";
import { LocalOnlyList } from "./SyncLocalOnly";
import { SyncPassphraseFields } from "./SyncPassphrase";
import { t } from "@/i18n";

const ts = t.settings.sync;

export const SYNC_INCLUDED = ts.included;
export const SYNC_EXCLUDED = ts.excluded;

export function SyncSettings({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const account = useGitHubAccount();
  const status = useSyncStatus();
  const st = status.data;
  const signedIn = !!account.data;
  return (
    <>
      <Group
        title={ts.title}
        description={ts.description}
      >
        <SwitchRow
          label={ts.enable}
          description={signedIn ? SYNC_INCLUDED : ts.signInFirst}
          checked={s.syncEnabled}
          disabled={!signedIn && !s.syncEnabled}
          onChange={(v) => void save({ syncEnabled: v, syncAsked: true })}
        />
        {s.syncEnabled &&
          (st ? (
            st.phase !== "needs-passphrase" && <SyncState st={st} />
          ) : (
            <div className="px-4 py-3.5">
              <KeyValueSkeleton rows={1} label={ts.loading} />
            </div>
          ))}
      </Group>

      {s.syncEnabled && st?.phase === "needs-passphrase" && <PassphraseGroup st={st} />}

      {s.syncEnabled && st && st.localOnly.length > 0 && (
        <Group title={ts.localOnlyTitle} description={ts.localOnlyDescription}>
          <div className="p-4">
            <LocalOnlyList items={st.localOnly} />
          </div>
        </Group>
      )}

      {s.syncEnabled && st && st.available.length > 0 && (
        <Group title={ts.availableTitle} description={ts.availableDescription}>
          <div className="p-4">
            <SyncAvailableList st={st} projectDir={s.defaultProjectDir} />
          </div>
        </Group>
      )}

      <Group title={ts.whatTitle}>
        <div className="flex flex-col gap-2 px-4 py-3.5 text-body text-muted">
          <p>{SYNC_INCLUDED}</p>
          <p>{SYNC_EXCLUDED}</p>
          <p>{ts.whatCommits}</p>
        </div>
      </Group>

      {s.syncEnabled && st?.hasKey && st.phase !== "needs-passphrase" && <HardResetGroup st={st} />}
    </>
  );
}

function SyncState({ st }: { st: SyncStatus }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const now = async () => {
    setBusy(true);
    try {
      qc.setQueryData(keys.sync, await call("sync.now", {}));
      toast.success(ts.synced);
    } catch (e) {
      toast.error(ts.syncFailed, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const label =
    st.phase === "syncing" ? ts.syncing : st.phase === "no-github" ? ts.noGitHub : st.phase === "error" ? ts.failed : st.lastSyncAt ? ts.syncedAt(relativeTime(st.lastSyncAt)) : ts.notSynced;
  return (
    <>
      <Row label={ts.state} description={st.remote ? ts.lastWritten(st.remote.device, relativeTime(st.remote.updatedAt)) : ts.nothingOnGitHub}>
        <div className="flex items-center gap-2">
          <Badge tone={st.phase === "error" ? "danger" : st.phase === "idle" && st.lastSyncAt ? "success" : "neutral"}>{label}</Badge>
          {st.repo && (
            <Button size="sm" variant="ghost" onClick={() => void openExternal(`https://github.com/${st.repo}`)}>
              <ExternalLink className="h-3.5 w-3.5" /> {ts.repository}
            </Button>
          )}
          <Button size="sm" onClick={() => void now()} loading={busy || st.phase === "syncing"} disabled={st.phase === "no-github"}>
            <RefreshCw className="h-3.5 w-3.5" /> {ts.syncNow}
          </Button>
        </div>
      </Row>
      {st.phase === "error" && st.error && (
        <div className="px-4 pb-3.5">
          <ErrorBanner title={ts.errorTitle}>{st.error}</ErrorBanner>
        </div>
      )}
    </>
  );
}

/** Asks for the sync password: the one of the data on GitHub, or a new one when there is none yet. */
function PassphraseGroup({ st }: { st: SyncStatus }) {
  const qc = useQueryClient();
  const probe = useSyncProbe(true);
  const [passphrase, setPassphrase] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(false);
  const existing = !!probe.data?.found;
  const submit = async () => {
    if (!passphrase) return;
    setBusy(true);
    try {
      qc.setQueryData(keys.sync, await call("sync.setPassphrase", { passphrase }));
      void qc.invalidateQueries({ queryKey: keys.syncProbe });
      toast.success(ts.passphraseSaved);
    } catch (e) {
      toast.error(ts.passphraseNotSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group
      title={ts.passphraseTitle}
      description={existing ? ts.passphraseExisting(probe.data?.device ?? ts.anotherPc) : ts.passphraseNew}
    >
      <div className="flex flex-col gap-3 p-4">
        {st.error && existing && <p className="text-xs text-warning">{st.error}</p>}
        {probe.isLoading ? <KeyValueSkeleton rows={1} label={ts.probing} /> : <SyncPassphraseFields existing={existing} onChange={setPassphrase} />}
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={!passphrase} loading={busy} onClick={() => void submit()}>
            <KeyRound className="h-3.5 w-3.5" /> {existing ? ts.unlock : ts.set}
          </Button>
          {existing && (
            <Button variant="ghost" onClick={() => setReset(true)}>
              {ts.forgot}
            </Button>
          )}
        </div>
      </div>
      {reset && <ResetRemoteDialog onClose={() => setReset(false)} forgotten />}
    </Group>
  );
}

/** Starts the repository anew with this computer's data under a new password. */
function ResetRemoteDialog({ onClose, forgotten }: { onClose: () => void; forgotten?: boolean }) {
  const qc = useQueryClient();
  const [passphrase, setPassphrase] = useState<string | null>(null);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={ts.resetTitle}
      description={`${forgotten ? ts.resetForgotten : ""}${ts.resetDescription}`}
      confirmLabel={ts.overwrite}
      danger
      confirmDisabled={!passphrase}
      onConfirm={async () => {
        try {
          qc.setQueryData(keys.sync, await call("sync.resetRemote", { passphrase: passphrase! }));
          void qc.invalidateQueries({ queryKey: keys.syncProbe });
          toast.success(ts.overwritten);
        } catch (e) {
          toast.error(ts.notOverwritten, errorMessage(e));
          throw e;
        }
      }}
    >
      <SyncPassphraseFields existing={false} onChange={setPassphrase} autoFocus />
    </ConfirmDialog>
  );
}

function HardResetGroup({ st }: { st: SyncStatus }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [reset, setReset] = useState(false);
  const removes = st.localOnly.map((x) => x.label);
  return (
    <Group title={ts.hardTitle} danger>
      <Row label={ts.forceLabel} description={ts.forceDescription}>
        <Button variant="danger-ghost" onClick={() => setConfirm(true)}>
          <RotateCcw className="h-3.5 w-3.5" /> {ts.setToGitHub}
        </Button>
      </Row>
      <Row label={ts.overwriteLabel} description={ts.overwriteDescription}>
        <Button variant="danger-ghost" onClick={() => setReset(true)}>
          <Upload className="h-3.5 w-3.5" /> {ts.overwrite}
        </Button>
      </Row>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={ts.forceTitle}
        description={ts.forceConfirm(removes)}
        confirmLabel={ts.setToGitHub}
        danger
        onConfirm={async () => {
          try {
            qc.setQueryData(keys.sync, await call("sync.forceLocal", {}));
            await qc.invalidateQueries();
            toast.success(ts.forced, ts.forcedDetail);
          } catch (e) {
            toast.error(ts.notReset, errorMessage(e));
            throw e;
          }
        }}
      />
      {reset && <ResetRemoteDialog onClose={() => setReset(false)} />}
    </Group>
  );
}

/** Projects other computers synced that are not here yet; each can be cloned into the folder for new projects. */
export function SyncAvailableList({ st, projectDir }: { st: SyncStatus; projectDir: string | null }) {
  const qc = useQueryClient();
  const openSettings = useUi((u) => u.openSettings);
  const [busy, setBusy] = useState<string | null>(null);
  const fetch = async (key: string, name: string) => {
    setBusy(key);
    try {
      await call("sync.cloneProject", { key });
      void qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(ts.fetched(name), projectDir ?? undefined);
    } catch (e) {
      toast.error(ts.notFetched, errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {!projectDir && (
        <p className="text-xs text-warning">
          {ts.needsFolder}{" "}
          <button className="underline" onClick={() => openSettings("general")}>
            {ts.setUnderGeneral}
          </button>
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {st.available.map((p) => (
          <li key={p.key} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-body">{p.name}</div>
              <div className="truncate font-mono text-xs text-subtle">{p.cloneUrl ?? ts.noRemote}</div>
            </div>
            <Button size="sm" disabled={!p.cloneUrl || !projectDir || (busy !== null && busy !== p.key)} loading={busy === p.key} onClick={() => void fetch(p.key, p.name)}>
              <CloudDownload className="h-3.5 w-3.5" /> {ts.fetch}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

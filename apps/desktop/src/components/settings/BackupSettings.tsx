import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, CloudAlert, CloudCheck, CloudOff, CloudUpload, Download, FileUp, History, Save } from "lucide-react";
import { BackupPart, type BackupInfo, type SyncVersion } from "@forge/protocol";
import { call, keys, useBackups, useSettings, useSyncStatus, useSyncVersions } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { pickBackupFile, pickSaveFile } from "@/lib/native";
import { cn, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, EmptyState, ErrorBanner, InfoTip, LabelWithInfo, ToggleRow } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { locale, t } from "@/i18n";

const tb = t.settings.backup;

const REASON: Record<BackupInfo["reason"], string> = tb.reason;

const PART_LABEL: Record<BackupPart, string> = tb.parts;

const PART_HINT: Record<BackupPart, string> = tb.partHints;

export function formatBackupDate(iso: string): string {
  return new Date(iso).toLocaleString(locale, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fileName(iso: string) {
  return `forge-backup-${iso.slice(0, 10)}.json`;
}

/** Backups of FORGE's configuration: automatic ones from each start, by hand, download and restore. */
export function BackupSettings() {
  const backups = useBackups();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [restore, setRestore] = useState<{ info: BackupInfo; path: string | null } | null>(null);

  const create = async () => {
    setCreating(true);
    try {
      await call("backup.create", {});
      void qc.invalidateQueries({ queryKey: keys.backups });
      toast.success(tb.created);
    } catch (e) {
      toast.error(tb.notCreated, errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const download = async (b?: BackupInfo) => {
    try {
      const target = await pickSaveFile(tb.saveDialogTitle, fileName(b?.createdAt ?? new Date().toISOString()));
      if (!target) return;
      const r = await call("backup.export", { path: target, ...(b?.id ? { id: b.id } : {}) });
      toast.success(tb.saved, r.path);
    } catch (e) {
      toast.error(tb.notSaved, errorMessage(e));
    }
  };

  const importFile = async () => {
    try {
      const path = await pickBackupFile(tb.pickFile);
      if (!path) return;
      setRestore({ info: await call("backup.inspect", { path }), path });
    } catch (e) {
      toast.error(tb.fileUnreadable, errorMessage(e));
    }
  };

  const list = backups.data ?? [];
  return (
    <div className="flex flex-col gap-5">
      <GitHubBackupStatus />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void create()} loading={creating}>
          <Save className="h-3.5 w-3.5" /> {tb.backUpNow}
        </Button>
        <Button variant="outline" onClick={() => void download()}>
          <Download className="h-3.5 w-3.5" /> {tb.download}
        </Button>
        <Button variant="outline" onClick={() => void importFile()}>
          <FileUp className="h-3.5 w-3.5" /> {tb.restoreFromFile}
        </Button>
        <InfoTip>
          {tb.fileInfo}
        </InfoTip>
      </div>

      <div>
        <LabelWithInfo info={tb.listInfo} className="mb-2 flex">
          <h3 className="text-body font-medium">{tb.listTitle}</h3>
        </LabelWithInfo>
        {backups.isLoading && (
          <SkeletonRegion label={tb.loading} className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex h-5 items-center gap-2">
                    <Skeleton className="h-3 w-36" />
                    <Skeleton className="h-2.5 w-16" />
                    <Skeleton className="h-5 w-20 rounded" />
                  </div>
                  <div className="flex h-4 items-center">
                    <Skeleton className="h-2.5 w-3/5" />
                  </div>
                </div>
                <Skeleton className="h-7 w-7" />
                <Skeleton className="h-7 w-28" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {backups.isError && <ErrorBanner>{errorMessage(backups.error)}</ErrorBanner>}
        {backups.data && !list.length && (
          <div className="rounded-lg border border-dashed border-border">
            <EmptyState icon={<History className="h-6 w-6" />} title={tb.emptyTitle}>
              {tb.emptyBody}
            </EmptyState>
          </div>
        )}
        {list.length > 0 && (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {list.map((b, i) => (
              <div key={b.id} className="flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-120 hover:bg-surface-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-body">
                    <span className="tabular-nums">{formatBackupDate(b.createdAt)}</span>
                    <span className="text-caption text-subtle">{relativeTime(b.createdAt)}</span>
                    <Badge tone={b.reason === "before-restore" ? "warning" : b.reason === "manual" ? "accent" : "neutral"}>{REASON[b.reason]}</Badge>
                    {i === 0 && <Badge tone="success">{tb.newest}</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted">{b.parts.map((p) => p.label).join(" · ")}</div>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={tb.download} title={tb.download} onClick={() => void download(b)}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRestore({ info: b, path: null })}>
                  <ArchiveRestore className="h-3.5 w-3.5" /> {tb.reset}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {restore && <RestoreDialog key={restore.info.id ?? restore.path} target={restore} onClose={() => setRestore(null)} />}
    </div>
  );
}

/** Whether the backups also land on GitHub: with the sync on, every sync is a state there. */
function GitHubBackupStatus() {
  const settings = useSettings().data;
  const st = useSyncStatus().data;
  const openSettings = useUi((u) => u.openSettings);
  if (!settings || !st) return null;
  const on = settings.syncEnabled && st.hasKey && st.phase !== "needs-passphrase";
  const ok = on && st.phase === "idle" && !!st.lastSyncAt && !st.pending;
  const text = !on
    ? settings.syncEnabled
      ? tb.github.waitingPassphrase
      : tb.github.localOnly
    : st.phase === "error"
      ? tb.github.failed(st.error ?? tb.github.unknownError)
      : st.phase === "syncing" || st.pending
        ? tb.github.pushing
        : st.lastSyncAt
          ? tb.github.synced(relativeTime(st.lastSyncAt))
          : tb.github.nothingYet;
  const Icon = !on ? CloudOff : st.phase === "error" ? CloudAlert : ok ? CloudCheck : CloudUpload;
  return (
    <div className={cn("flex items-center gap-3 rounded-lg border px-3.5 py-2.5", ok ? "border-graph-blue/30 bg-graph-blue/10" : st.phase === "error" && on ? "border-danger/30 bg-danger-soft" : "border-border bg-surface-2")}>
      <Icon className={cn("h-4 w-4 shrink-0", ok || (on && st.phase !== "error") ? "text-graph-blue" : on ? "text-danger" : "text-subtle")} />
      <p className="min-w-0 flex-1 text-body">{text}</p>
      <Button size="sm" variant="ghost" onClick={() => openSettings("github")}>
        {on ? tb.github.versions : tb.github.setUp}
      </Button>
    </div>
  );
}

/** With the sync on, every state on GitHub is a version to go back to, across computers. */
export function GitHubVersions() {
  const settings = useSettings().data;
  const status = useSyncStatus().data;
  const on = !!settings?.syncEnabled && !!status?.hasKey;
  const versions = useSyncVersions(on);
  const [restore, setRestore] = useState<SyncVersion | null>(null);
  if (!on) return <p className="text-xs text-muted">{tb.versions.hidden}</p>;
  const list = versions.data ?? [];
  return (
    <div>
      {versions.isLoading && (
        <SkeletonRegion label={tb.versions.loading} className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
              <div className="flex h-5 min-w-0 flex-1 items-center gap-2">
                <Skeleton className="h-3 w-36" />
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-5 w-20 rounded" />
              </div>
              <Skeleton className="h-7 w-28" />
            </div>
          ))}
        </SkeletonRegion>
      )}
      {versions.isError && <ErrorBanner>{errorMessage(versions.error)}</ErrorBanner>}
      {versions.data && !list.length && <p className="text-xs text-muted">{tb.versions.empty}</p>}
      {list.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {list.slice(0, 20).map((v, i) => (
            <div key={v.sha} className="flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-120 hover:bg-surface-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-body">
                <span className="tabular-nums">{formatBackupDate(v.date)}</span>
                <span className="text-caption text-subtle">{relativeTime(v.date)}</span>
                {v.device && <Badge tone="neutral">{v.device}</Badge>}
                {i === 0 && <Badge tone="success">{tb.versions.current}</Badge>}
              </div>
              <Button size="sm" variant="outline" disabled={i === 0} onClick={() => setRestore(v)}>
                <ArchiveRestore className="h-3.5 w-3.5" /> {tb.versions.restore}
              </Button>
            </div>
          ))}
        </div>
      )}
      {restore && <VersionRestoreDialog key={restore.sha} version={restore} onClose={() => setRestore(null)} />}
    </div>
  );
}

function VersionRestoreDialog({ version, onClose }: { version: SyncVersion; onClose: () => void }) {
  const qc = useQueryClient();
  const all = BackupPart.options;
  const [parts, setParts] = useState<BackupPart[]>(all.filter((p) => p !== "phone"));
  const toggle = (p: BackupPart, on: boolean) => setParts((cur) => (on ? [...cur, p] : cur.filter((x) => x !== p)));
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={tb.versions.dialogTitle(formatBackupDate(version.date))}
      description={tb.versions.dialogDescription}
      confirmLabel={tb.versions.restore}
      confirmDisabled={!parts.length}
      onConfirm={async () => {
        try {
          const r = await call("sync.restoreVersion", { sha: version.sha, parts });
          await qc.invalidateQueries();
          toast.success(tb.versions.restored, [tb.restoredParts(r.restored.map((p) => PART_LABEL[p]).join(", ") || tb.versions.nothing), ...r.notes].join(" "));
        } catch (e) {
          toast.error(tb.versions.notRestored, errorMessage(e));
          throw e;
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs font-medium text-muted">{tb.versions.question}</div>
        {all.map((p) => (
          <ToggleRow key={p} checked={parts.includes(p)} onChange={(v) => toggle(p, v)} label={PART_LABEL[p]}>
            {p === "projects" ? tb.versions.projectsHint : PART_HINT[p]}
          </ToggleRow>
        ))}
      </div>
    </ConfirmDialog>
  );
}

function RestoreDialog({ target, onClose }: { target: { info: BackupInfo; path: string | null }; onClose: () => void }) {
  const qc = useQueryClient();
  const available = target.info.parts.map((p) => p.part);
  const [parts, setParts] = useState<BackupPart[]>(available);
  const toggle = (p: BackupPart, on: boolean) => setParts((cur) => (on ? [...cur, p] : cur.filter((x) => x !== p)));
  const labels = new Map(target.info.parts.map((p) => [p.part, p.label]));

  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={tb.restore.dialogTitle(formatBackupDate(target.info.createdAt))}
      description={tb.restore.dialogDescription}
      confirmLabel={tb.restore.confirm}
      confirmDisabled={!parts.length}
      onConfirm={async () => {
        try {
          const params = target.path ? { path: target.path, parts } : { id: target.info.id ?? undefined, parts };
          const r = await call("backup.restore", params);
          // Settings, projects, phone and Claude configuration all may have changed.
          await qc.invalidateQueries();
          toast.success(tb.restore.restored, [tb.restoredParts(r.restored.map((p) => PART_LABEL[p]).join(", ")), ...r.notes].join(" "));
        } catch (e) {
          toast.error(tb.restore.notRestored, errorMessage(e));
          throw e;
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs font-medium text-muted">{tb.restore.question}</div>
        {available.map((p) => (
          <ToggleRow key={p} checked={parts.includes(p)} onChange={(v) => toggle(p, v)} label={PART_LABEL[p]}>
            {p === "settings" || p === "projects" || p === "claude" ? `${labels.get(p)?.replace(/^Claude Code: /, "")}. ` : ""}
            {PART_HINT[p]}
          </ToggleRow>
        ))}
      </div>
    </ConfirmDialog>
  );
}

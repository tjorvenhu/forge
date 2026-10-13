import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Download, FileUp, History, Save } from "lucide-react";
import { BackupPart, type BackupInfo, type SyncVersion } from "@forge/protocol";
import { call, keys, useBackups, useSettings, useSyncStatus, useSyncVersions } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { pickBackupFile, pickSaveFile } from "@/lib/native";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, EmptyState, ErrorBanner, InfoTip, LabelWithInfo, ToggleRow } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";

const REASON: Record<BackupInfo["reason"], string> = {
  start: "Beim Start",
  manual: "Von Hand",
  "before-restore": "Vor Wiederherstellung",
  import: "Importiert",
};

const PART_LABEL: Record<BackupPart, string> = {
  settings: "Einstellungen",
  projects: "Projekte",
  phone: "Telefon",
  claude: "Claude-Code-Konfiguration",
  git: "Git-Name und E-Mail",
};

const PART_HINT: Record<BackupPart, string> = {
  settings: "Modell, Aufwand, Profil, Töne, Updates und alle anderen Einstellungen von FORGE.",
  projects: "Projektliste mit Favoriten, Tags, Profil, Modell und Befehlen. Seitdem hinzugefügte Projekte bleiben.",
  phone: "Anlage, Gesprächspartner, Anrufer, PIN und Tischtelefon. Das Telefon startet danach neu.",
  claude: "CLAUDE.md, settings.json mit Hooks, Agenten, Befehle, Skills und MCP-Server. Seitdem neu angelegte bleiben.",
  git: "Name und E-Mail für Commits.",
};

export function formatBackupDate(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
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
      toast.success("Backup angelegt");
    } catch (e) {
      toast.error("Backup nicht angelegt", errorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const download = async (b?: BackupInfo) => {
    try {
      const target = await pickSaveFile("Backup speichern", fileName(b?.createdAt ?? new Date().toISOString()));
      if (!target) return;
      const r = await call("backup.export", { path: target, ...(b?.id ? { id: b.id } : {}) });
      toast.success("Backup gespeichert", r.path);
    } catch (e) {
      toast.error("Backup nicht gespeichert", errorMessage(e));
    }
  };

  const importFile = async () => {
    try {
      const path = await pickBackupFile("Backup-Datei wählen");
      if (!path) return;
      setRestore({ info: await call("backup.inspect", { path }), path });
    } catch (e) {
      toast.error("Datei nicht lesbar", errorMessage(e));
    }
  };

  const list = backups.data ?? [];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void create()} loading={creating}>
          <Save className="h-3.5 w-3.5" /> Jetzt sichern
        </Button>
        <Button variant="outline" onClick={() => void download()}>
          <Download className="h-3.5 w-3.5" /> Als Datei herunterladen
        </Button>
        <Button variant="outline" onClick={() => void importFile()}>
          <FileUp className="h-3.5 w-3.5" /> Aus Datei wiederherstellen
        </Button>
        <InfoTip>
          Die Datei enthält deine Konfiguration im Klartext, auch API-Keys, die in MCP-Servern oder Hooks stehen. Bewahre sie auf wie ein Passwort. Die Zugangsdaten des Telefons
          bleiben verschlüsselt und funktionieren nur unter deinem Windows-Konto.
        </InfoTip>
      </div>

      <div>
        <LabelWithInfo info="Beim Start sichert FORGE automatisch, wenn sich seit dem letzten Backup etwas geändert hat. Die letzten 40 bleiben." className="mb-2 flex">
          <h3 className="text-body font-medium">Gespeicherte Backups</h3>
        </LabelWithInfo>
        {backups.isLoading && (
          <SkeletonRegion label="Lädt Backups" className="divide-y divide-border overflow-hidden rounded-lg border border-border">
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
            <EmptyState icon={<History className="h-6 w-6" />} title="Noch kein Backup">
              Das erste legt FORGE beim nächsten Start an. Oder jetzt von Hand sichern.
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
                    {i === 0 && <Badge tone="success">neuestes</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted">{b.parts.map((p) => p.label).join(" · ")}</div>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label="Als Datei herunterladen" title="Als Datei herunterladen" onClick={() => void download(b)}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRestore({ info: b, path: null })}>
                  <ArchiveRestore className="h-3.5 w-3.5" /> Zurücksetzen
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <GitHubVersions />

      {restore && <RestoreDialog key={restore.info.id ?? restore.path} target={restore} onClose={() => setRestore(null)} />}
    </div>
  );
}

/** With the sync on, every state on GitHub is a version to go back to, across computers. */
function GitHubVersions() {
  const settings = useSettings().data;
  const status = useSyncStatus().data;
  const on = !!settings?.syncEnabled && !!status?.hasKey;
  const versions = useSyncVersions(on);
  const [restore, setRestore] = useState<SyncVersion | null>(null);
  if (!on) return null;
  const list = versions.data ?? [];
  return (
    <div>
      <LabelWithInfo
        info="Jeder Abgleich über GitHub ist ein Commit im Repository forge-data. Ein früherer Stand gilt nach dem Zurückholen auch für deine anderen PCs. Das Telefon, die Hooks und alles andere, was nur hier liegt, bleibt in den lokalen Backups oben."
        className="mb-2 flex"
      >
        <h3 className="text-body font-medium">Versionen auf GitHub</h3>
      </LabelWithInfo>
      {versions.isLoading && (
        <SkeletonRegion label="Lädt Versionen auf GitHub" className="divide-y divide-border overflow-hidden rounded-lg border border-border">
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
      {versions.data && !list.length && <p className="text-xs text-muted">Noch kein Stand auf GitHub.</p>}
      {list.length > 0 && (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {list.slice(0, 20).map((v, i) => (
            <div key={v.sha} className="flex items-center gap-3 px-3.5 py-2.5 transition-colors duration-120 hover:bg-surface-2">
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-body">
                <span className="tabular-nums">{formatBackupDate(v.date)}</span>
                <span className="text-caption text-subtle">{relativeTime(v.date)}</span>
                {v.device && <Badge tone="neutral">{v.device}</Badge>}
                {i === 0 && <Badge tone="success">aktuell</Badge>}
              </div>
              <Button size="sm" variant="outline" disabled={i === 0} onClick={() => setRestore(v)}>
                <ArchiveRestore className="h-3.5 w-3.5" /> Zurückholen
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
      title={`Stand vom ${formatBackupDate(version.date)} zurückholen`}
      description="Vorher sichert FORGE den aktuellen Stand lokal. Deine anderen PCs bekommen den zurückgeholten Stand mit dem nächsten Abgleich."
      confirmLabel="Zurückholen"
      confirmDisabled={!parts.length}
      onConfirm={async () => {
        try {
          const r = await call("sync.restoreVersion", { sha: version.sha, parts });
          await qc.invalidateQueries();
          toast.success("Stand zurückgeholt", [`Zurückgesetzt: ${r.restored.map((p) => PART_LABEL[p]).join(", ") || "nichts"}.`, ...r.notes].join(" "));
        } catch (e) {
          toast.error("Nicht zurückgeholt", errorMessage(e));
          throw e;
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs font-medium text-muted">Was soll zurückgeholt werden?</div>
        {all.map((p) => (
          <ToggleRow key={p} checked={parts.includes(p)} onChange={(v) => toggle(p, v)} label={PART_LABEL[p]}>
            {p === "projects" ? "Einstellungen und Dev-Tools der Projekte. Projekte, die hier fehlen, lassen sich unter Synchronisierung holen." : PART_HINT[p]}
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
      title={`Backup vom ${formatBackupDate(target.info.createdAt)} wiederherstellen`}
      description="Vorher sichert FORGE den aktuellen Stand. Du kannst also jederzeit zurück."
      confirmLabel="Wiederherstellen"
      confirmDisabled={!parts.length}
      onConfirm={async () => {
        try {
          const params = target.path ? { path: target.path, parts } : { id: target.info.id ?? undefined, parts };
          const r = await call("backup.restore", params);
          // Settings, projects, phone and Claude configuration all may have changed.
          await qc.invalidateQueries();
          toast.success("Backup wiederhergestellt", [`Zurückgesetzt: ${r.restored.map((p) => PART_LABEL[p]).join(", ")}.`, ...r.notes].join(" "));
        } catch (e) {
          toast.error("Nicht wiederhergestellt", errorMessage(e));
          throw e;
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="text-xs font-medium text-muted">Was soll zurückgesetzt werden?</div>
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

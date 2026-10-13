import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CloudDownload, ExternalLink, KeyRound, RefreshCw, RotateCcw, Upload } from "lucide-react";
import type { Settings, SyncStatus } from "@forge/protocol";
import { call, keys, useDiagnostics, useGitHubAccount, useSyncProbe, useSyncStatus } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { KeyValueSkeleton } from "@/components/ui/skeleton";
import { GitHubAccountCard, useAutoOpenGitHub } from "@/components/github/GitHubPanel";
import { Group, Row, SwitchRow } from "./layout";
import { LocalOnlyList } from "./SyncLocalOnly";
import { SyncPassphraseFields } from "./SyncPassphrase";

export const SYNC_INCLUDED =
  "Einstellungen, Projekte mit ihren Einstellungen und Dev-Tools, das Telefon mit Passwörtern und Keys, Git-Name und E-Mail und Claude Code: CLAUDE.md, settings.json, Agents, Commands, Skills und MCP-Server.";
export const SYNC_EXCLUDED =
  "Alles außer dem Namen des PCs ist mit deinem Sync-Passwort verschlüsselt, GitHub sieht nur unlesbare Daten. Nicht dabei sind Chatverläufe, Anrufprotokolle und Projektdateien. Pfade dieses PCs bleiben hier, ebenso, ob Telefon und Tischtelefon auf diesem PC laufen.";

export function SyncSettings({ s, save }: { s: Settings; save: (patch: Partial<Settings>) => Promise<void> }) {
  const account = useGitHubAccount();
  const status = useSyncStatus();
  const gh = useDiagnostics().data?.gh;
  useAutoOpenGitHub();
  const st = status.data;
  const signedIn = !!account.data;
  return (
    <>
      <Group
        title="Synchronisierung über GitHub"
        description="FORGE legt dafür in deinem GitHub-Konto das private Repository forge-data an. Meldest du dich auf einem anderen PC mit demselben Konto an, hat FORGE dort dieselben Daten."
      >
        <div className="p-4">
          {gh && !gh.found ? <p className="text-body text-danger">Die GitHub-Anbindung fehlt in dieser Installation. Bitte FORGE neu installieren.</p> : <GitHubAccountCard />}
        </div>
        <SwitchRow
          label="Daten über GitHub synchronisieren"
          description={signedIn ? SYNC_INCLUDED : "Dafür musst du oben bei GitHub angemeldet sein."}
          checked={s.syncEnabled}
          disabled={!signedIn && !s.syncEnabled}
          onChange={(v) => void save({ syncEnabled: v, syncAsked: true })}
        />
        {s.syncEnabled &&
          (st ? (
            st.phase !== "needs-passphrase" && <SyncState st={st} />
          ) : (
            <div className="px-4 py-3.5">
              <KeyValueSkeleton rows={1} label="Lädt Stand der Synchronisierung" />
            </div>
          ))}
      </Group>

      {s.syncEnabled && st?.phase === "needs-passphrase" && <PassphraseGroup st={st} />}

      {s.syncEnabled && st && st.localOnly.length > 0 && (
        <Group title="Nur auf diesem PC" description="Auf einem anderen PC entfernt. Hier ist es noch da, wird aber nicht mehr abgeglichen, bis du dich entscheidest.">
          <div className="p-4">
            <LocalOnlyList items={st.localOnly} />
          </div>
        </Group>
      )}

      {s.syncEnabled && st && st.available.length > 0 && (
        <Group title="Projekte von anderen PCs" description="Stehen im Sync-Repository, liegen aber noch nicht auf diesem PC.">
          <div className="p-4">
            <SyncAvailableList st={st} projectDir={s.defaultProjectDir} />
          </div>
        </Group>
      )}

      <Group title="Was abgeglichen wird">
        <div className="flex flex-col gap-2 px-4 py-3.5 text-body text-muted">
          <p>{SYNC_INCLUDED}</p>
          <p>{SYNC_EXCLUDED}</p>
          <p>Jeder Abgleich ist ein Commit. Frühere Stände holst du unter Backup zurück. Ausschalten lässt das Repository auf GitHub stehen.</p>
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
      toast.success("Synchronisiert");
    } catch (e) {
      toast.error("Synchronisieren fehlgeschlagen", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const label =
    st.phase === "syncing" ? "Wird abgeglichen …" : st.phase === "no-github" ? "Nicht bei GitHub angemeldet" : st.phase === "error" ? "Fehlgeschlagen" : st.lastSyncAt ? `Abgeglichen ${relativeTime(st.lastSyncAt)}` : "Noch nicht abgeglichen";
  return (
    <>
      <Row label="Stand" description={st.remote ? `Zuletzt geschrieben von ${st.remote.device}, ${relativeTime(st.remote.updatedAt)}.` : "Noch nichts auf GitHub."}>
        <div className="flex items-center gap-2">
          <Badge tone={st.phase === "error" ? "danger" : st.phase === "idle" && st.lastSyncAt ? "success" : "neutral"}>{label}</Badge>
          {st.repo && (
            <Button size="sm" variant="ghost" onClick={() => void openExternal(`https://github.com/${st.repo}`)}>
              <ExternalLink className="h-3.5 w-3.5" /> Repository
            </Button>
          )}
          <Button size="sm" onClick={() => void now()} loading={busy || st.phase === "syncing"} disabled={st.phase === "no-github"}>
            <RefreshCw className="h-3.5 w-3.5" /> Jetzt abgleichen
          </Button>
        </div>
      </Row>
      {st.phase === "error" && st.error && (
        <div className="px-4 pb-3.5">
          <ErrorBanner title="Abgleich fehlgeschlagen">{st.error}</ErrorBanner>
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
      toast.success("Sync-Passwort gespeichert");
    } catch (e) {
      toast.error("Sync-Passwort nicht gespeichert", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group
      title="Sync-Passwort"
      description={existing ? `Auf GitHub liegen verschlüsselte Daten von ${probe.data?.device ?? "einem anderen PC"}. Gib das Passwort ein, mit dem sie verschlüsselt sind.` : "Lege das Passwort fest, mit dem FORGE alles auf GitHub verschlüsselt."}
    >
      <div className="flex flex-col gap-3 p-4">
        {st.error && existing && <p className="text-xs text-warning">{st.error}</p>}
        {probe.isLoading ? <KeyValueSkeleton rows={1} label="Sieht im Sync-Repository nach" /> : <SyncPassphraseFields existing={existing} onChange={setPassphrase} />}
        <div className="flex items-center gap-2">
          <Button variant="primary" disabled={!passphrase} loading={busy} onClick={() => void submit()}>
            <KeyRound className="h-3.5 w-3.5" /> {existing ? "Entsperren" : "Festlegen"}
          </Button>
          {existing && (
            <Button variant="ghost" onClick={() => setReset(true)}>
              Passwort vergessen
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
      title="GitHub mit diesem PC überschreiben?"
      description={`${forgotten ? "Ohne das alte Passwort lassen sich die Daten auf GitHub nicht mehr öffnen. " : ""}FORGE schreibt den Stand dieses PCs mit einem neuen Passwort nach GitHub. Deine anderen PCs brauchen danach das neue Passwort und bekommen den Stand dieses PCs.`}
      confirmLabel="Überschreiben"
      danger
      confirmDisabled={!passphrase}
      onConfirm={async () => {
        try {
          qc.setQueryData(keys.sync, await call("sync.resetRemote", { passphrase: passphrase! }));
          void qc.invalidateQueries({ queryKey: keys.syncProbe });
          toast.success("GitHub hat jetzt den Stand dieses PCs");
        } catch (e) {
          toast.error("Nicht überschrieben", errorMessage(e));
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
    <Group title="Hart abgleichen" danger>
      <Row label="Diesen PC auf den Stand von GitHub setzen" description="Übernimmt alle Werte von GitHub, auch wo du hier etwas anderes eingestellt hast. Was auf GitHub fehlt, wird hier entfernt.">
        <Button variant="danger-ghost" onClick={() => setConfirm(true)}>
          <RotateCcw className="h-3.5 w-3.5" /> Auf GitHub-Stand setzen
        </Button>
      </Row>
      <Row label="GitHub mit diesem PC überschreiben" description="Schreibt den Stand dieses PCs mit einem neuen Sync-Passwort nach GitHub. Für einen Neuanfang oder ein vergessenes Passwort.">
        <Button variant="danger-ghost" onClick={() => setReset(true)}>
          <Upload className="h-3.5 w-3.5" /> Überschreiben
        </Button>
      </Row>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Diesen PC auf den Stand von GitHub setzen?"
        description={`Alle Einstellungen, Projekte und Dateien bekommen den Stand von GitHub. ${removes.length ? `Hier entfernt wird: ${removes.join(", ")}. Projekte nur aus FORGE, ihre Ordner bleiben.` : "Entfernt wird nichts."} Was du hier neu angelegt und noch nicht abgeglichen hast, bleibt. Vorher legt FORGE ein Backup an.`}
        confirmLabel="Auf GitHub-Stand setzen"
        danger
        onConfirm={async () => {
          try {
            qc.setQueryData(keys.sync, await call("sync.forceLocal", {}));
            await qc.invalidateQueries();
            toast.success("Dieser PC hat den Stand von GitHub", "Der Stand davor ist als Backup gesichert.");
          } catch (e) {
            toast.error("Nicht zurückgesetzt", errorMessage(e));
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
      toast.success(`${name} geholt`, projectDir ?? undefined);
    } catch (e) {
      toast.error("Projekt nicht geholt", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {!projectDir && (
        <p className="text-xs text-warning">
          Zum Holen braucht FORGE einen Ordner für neue Projekte.{" "}
          <button className="underline" onClick={() => openSettings("general")}>
            Unter Allgemein festlegen
          </button>
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {st.available.map((p) => (
          <li key={p.key} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-body">{p.name}</div>
              <div className="truncate font-mono text-xs text-subtle">{p.cloneUrl ?? "ohne Git-Remote, lässt sich nicht holen"}</div>
            </div>
            <Button size="sm" disabled={!p.cloneUrl || !projectDir || (busy !== null && busy !== p.key)} loading={busy === p.key} onClick={() => void fetch(p.key, p.name)}>
              <CloudDownload className="h-3.5 w-3.5" /> Holen
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

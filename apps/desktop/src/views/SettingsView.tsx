import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveRestore,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  FileText,
  FolderOpen,
  Info,
  Phone,
  Cloud,
  RefreshCw,
  ShieldAlert,
  ShieldBan,
  SlidersHorizontal,
  SquareTerminal,
  Volume2,
  XCircle,
} from "lucide-react";
import type { Diagnostics, ProfileId, Settings, ToolCheck, EffortLevel } from "@forge/protocol";
import { call, keys, useDiagnostics, useRuntimeInfo, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { pickFolder } from "@/lib/native";
import { playSound } from "@/lib/sounds";
import { toast } from "@/stores/toast";
import { useUi, type SettingsSection } from "@/stores/ui";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, ErrorBanner } from "@/components/ui/misc";
import { FormSkeleton, Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Group, Row, SettingsLayout, SwitchRow, type SettingsSectionDef } from "@/components/settings/layout";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { ClaudeSetupCard } from "@/components/settings/ClaudeSetupCard";
import { MemoryEditor } from "@/components/settings/MemoryEditor";
import { effortOptions, fromChoice, modelOptions, toChoice } from "@/components/settings/model-options";
import { idleCloseOptions } from "@/components/settings/idle-close";
import { PhoneSettings } from "@/components/settings/PhoneSettings";
import { BackupSettings } from "@/components/settings/BackupSettings";
import { SyncSettings } from "@/components/settings/SyncSettings";
import { GitHubVersions } from "@/components/settings/BackupSettings";
import { PolicySettings } from "@/components/settings/PolicySettings";
import { GitHubSettings } from "@/components/settings/GitHubSettings";
import { AppUpdateSettings } from "@/components/layout/AppUpdate";
import { cn, planLabel } from "@/lib/utils";

type Save = (patch: Partial<Settings>) => Promise<void>;

export const SECTIONS: ReadonlyArray<SettingsSectionDef<SettingsSection>> = [
  { id: "general", label: "Allgemein", hint: "Modell, Profil, Bedienung", Icon: SlidersHorizontal },
  { id: "claude", label: "Claude Code", hint: "Installation, Anmeldung, Limits", Icon: SquareTerminal },
  { id: "policy", label: "Sperrliste", hint: "Was FORGE immer blockiert", Icon: ShieldBan },
  { id: "phone", label: "Telefon", hint: "Anrufe, Sprache, Tischtelefon", Icon: Phone },
  { id: "github", label: "GitHub", hint: "Konto, Synchronisierung, Versionen", Icon: Cloud },
  { id: "backup", label: "Backup", hint: "Sichern und zurücksetzen", Icon: ArchiveRestore },
  { id: "rules", label: "Globale Regeln", hint: "CLAUDE.md für alle Projekte", Icon: FileText },
  { id: "about", label: "Über FORGE", hint: "Updates, Datenschutz, Diagnose", Icon: Info },
];

export function SettingsView() {
  const settings = useSettings();
  const section = useUi((s) => s.settingsSection);
  const openSettings = useUi((s) => s.openSettings);
  const qc = useQueryClient();

  const save: Save = async (patch) => {
    try {
      const next = await call("settings.update", patch);
      qc.setQueryData(keys.settings, next);
      void qc.invalidateQueries({ queryKey: keys.diagnostics });
      toast.saved();
    } catch (e) {
      toast.error("Einstellung nicht gespeichert", errorMessage(e));
    }
  };

  const s = settings.data;
  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0]!;
  return (
    <Page title="Einstellungen" subtitle="Änderungen gelten sofort. Ein Backup davon legt FORGE bei jedem Start an.">
      <SettingsLayout sections={SECTIONS} current={current.id} onSelect={openSettings} label="Bereiche der Einstellungen">
        {!s ? (
          <FormSkeleton groups={2} label="Lädt Einstellungen" />
        ) : current.id === "general" ? (
          <GeneralSection s={s} save={save} />
        ) : current.id === "claude" ? (
          <ClaudeSection s={s} save={save} />
        ) : current.id === "policy" ? (
          <PolicySettings s={s} save={save} />
        ) : current.id === "phone" ? (
          <PhoneSection />
        ) : current.id === "github" ? (
          <GitHubSection s={s} save={save} />
        ) : current.id === "backup" ? (
          <Group
            title="Backup"
            description="Ein Backup enthält deine Einstellungen, die Projektliste, das Telefon, die Claude-Code-Konfiguration und deinen Git-Namen. Nicht enthalten sind Chatverläufe, Projektdateien und die Anmeldungen bei Claude und GitHub."
          >
            <div className="p-4">
              <BackupSettings />
            </div>
          </Group>
        ) : current.id === "rules" ? (
          <Group title="Globale Regeln für Claude" description="Stehen in ~/.claude/CLAUDE.md und gelten in jedem Projekt, zusätzlich zur CLAUDE.md des Projekts. Auch Claude Code im Terminal liest sie.">
            <div className="p-4">
              <MemoryEditor scopes={["global"]} />
            </div>
          </Group>
        ) : (
          <AboutSection s={s} save={save} />
        )}
      </SettingsLayout>
    </Page>
  );
}

function GeneralSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Group title="Neue Sessions" description="Gilt, solange ein Projekt nichts anderes festlegt. Pro Session lässt sich alles im Chat umstellen.">
        <ModelSetting value={s.defaultModel} onChange={(v) => void save({ defaultModel: v })} />
        <Row label="Aufwand" description="Wie gründlich Claude nachdenkt. Höher ist genauer, aber langsamer und verbraucht mehr vom Abo.">
          <Select
            value={toChoice(s.defaultEffort)}
            onChange={(v) => void save({ defaultEffort: fromChoice<EffortLevel>(v) })}
            className="w-64"
            options={effortOptions("Claude-Code-Standard")}
          />
        </Row>
        <Row label="Profil für neue Projekte" description={PROFILE_INFO[s.defaultProfile].description}>
          <Select<ProfileId>
            value={s.defaultProfile}
            onChange={(v) => void save({ defaultProfile: v })}
            className="w-64"
            options={PROFILE_IDS.map((p) => ({ value: p, label: PROFILE_INFO[p].label, description: PROFILE_INFO[p].description }))}
          />
        </Row>
        {s.defaultProfile === "autonomous" && (
          <div className="flex items-start gap-3 bg-danger-soft/40 px-4 py-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <p className="text-xs text-muted">
              Autonomous fragt nicht vor Befehlen und Dateiänderungen. Befehle laufen mit deinen Benutzerrechten. Die Sperrliste von FORGE gilt weiterhin, ihre Regeln stellst du unter Sperrliste
              ein. Mit dem Tag sandbox-only nimmst du einzelne Projekte aus.
            </p>
          </div>
        )}
        <Row label="Ordner für neue Projekte" description="Hier legt FORGE neue und geklonte Projekte an." stacked>
          <div className="flex gap-2">
            <Input value={s.defaultProjectDir ?? ""} readOnly placeholder="nicht gesetzt" className="font-mono text-xs" />
            <Button
              onClick={async () => {
                try {
                  const p = await pickFolder("Ordner für neue Projekte wählen", s.defaultProjectDir);
                  if (p) void save({ defaultProjectDir: p });
                } catch (e) {
                  toast.error("Ordnerdialog fehlgeschlagen", errorMessage(e));
                }
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" /> Wählen
            </Button>
          </div>
        </Row>
      </Group>


      <Group title="Bedienung">
        <SwitchRow
          label="Enter sendet"
          description={s.enterToSend ? "Umschalt+Enter macht eine neue Zeile." : "Strg+Enter sendet, Enter macht eine neue Zeile."}
          checked={s.enterToSend}
          onChange={(v) => void save({ enterToSend: v })}
        />
        <SwitchRow
          label="Windows-Benachrichtigungen"
          description="Meldung von Windows, wenn Claude fertig ist, eine Freigabe oder Antwort braucht oder ein Fehler auftritt. Erscheint auch, wenn FORGE im Hintergrund ist. Ein Klick auf die eingeblendete Meldung öffnet die Session."
          checked={s.desktopNotifications}
          onChange={(v) => void save({ desktopNotifications: v })}
        />
        <SwitchRow
          label="Im Vordergrund bleiben"
          description="FORGE und seine Chat-Fenster bleiben über anderen Programmen. Auch über die Befehlspalette (Strg+K) und per Telefon umschaltbar."
          checked={s.alwaysOnTop}
          onChange={(v) => void save({ alwaysOnTop: v })}
        />
        <SwitchRow
          label="Druck-Taste für Screenshots"
          description="Solange FORGE läuft, öffnet die Druck-Taste das Snipping-Tool von FORGE statt dem von Windows. Der Screenshot landet in der Zwischenablage und als Anhang im Chat, den du zuletzt benutzt hast. Alt+Druck und Win+Druck bleiben bei Windows."
          checked={s.screenshotKey}
          onChange={(v) => void save({ screenshotKey: v })}
        />
        <Row label="Töne" description="Signal, wenn Claude fertig ist, eine Freigabe braucht oder ein Fehler auftritt.">
          <div className="flex items-center gap-1">
            {(["done", "approval", "error"] as const).map((k) => (
              <Button key={k} size="icon-sm" variant="ghost" onClick={() => playSound(k)} aria-label={`Ton ${SOUND_LABEL[k]} anhören`} title={`Ton ${SOUND_LABEL[k]} anhören`}>
                <Volume2 className="h-3.5 w-3.5" />
              </Button>
            ))}
            <span className="ml-2">
              <Switch checked={s.sounds} onChange={(v) => void save({ sounds: v })} label="Töne" />
            </span>
          </div>
        </Row>
      </Group>
    </>
  );
}

const SOUND_LABEL = { done: "Fertig", approval: "Freigabe", error: "Fehler" } as const;

export function ModelSetting({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const info = useRuntimeInfo();
  const models = info.data?.models ?? [];
  const hint = info.isLoading ? "Modellliste wird von Claude Code gelesen …" : models.length ? "Mit welchem Modell eine neue Session startet." : "Modellliste nicht verfügbar.";
  return (
    <Row label="Modell" description={hint}>
      <Select value={toChoice(value)} onChange={(v) => onChange(fromChoice(v))} className="w-64" options={modelOptions(models, "Claude-Code-Standard")} />
    </Row>
  );
}

function ClaudeSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Group
        title="Installation und Anmeldung"
        description="FORGE arbeitet mit Claude Code und deinem Claude-Abo. Fehlt Claude Code, installiert FORGE es beim Start selbst. Die Anmeldung teilt FORGE mit Claude Code im Terminal."
      >
        <div className="px-4 py-3.5">
          <ClaudeSetupCard />
        </div>
      </Group>

      <Group title="Verhalten">
        <SwitchRow
          label="Nach Nutzungslimit weitermachen"
          description="Stoppt das Limit eine Session, schickt FORGE nach dem Reset selbst eine Nachricht. Höchstens dreimal ohne deine Eingabe, nur solange FORGE läuft."
          checked={s.autoContinueAfterLimit}
          onChange={(v) => void save({ autoContinueAfterLimit: v })}
        />
        <SwitchRow
          label="Vorher-Nachher-Bilder bei UI-Änderungen"
          description="Ändert Claude Dateien wie .tsx oder .css, während der Dev-Server läuft, zeigt der Chat Screenshots der Web-App von vor und nach dem Durchlauf. Die Bilder gehen nicht an Claude und werden nach 14 Tagen gelöscht."
          checked={s.uiCompare}
          onChange={(v) => void save({ uiCompare: v })}
        />
        <Row label="Untätige Sessions schließen nach" description="Beendet nur den Claude-Prozess. Die Session bleibt mit Verlauf erhalten und läuft mit der nächsten Nachricht weiter.">
          <Select
            value={String(s.idleCloseMinutes)}
            onChange={(v) => void save({ idleCloseMinutes: Number(v) })}
            className="w-64"
            options={idleCloseOptions(s.idleCloseMinutes)}
            aria-label="Untätige Sessions schließen nach"
          />
        </Row>
        <SwitchRow
          label="ANTHROPIC_API_KEY ausblenden"
          description="Empfohlen. Ein gesetzter API-Key ersetzt die Abo-Anmeldung und wird extra abgerechnet. FORGE zeigt den Wert nie an."
          checked={s.stripApiKey}
          onChange={(v) => void save({ stripApiKey: v })}
        />
      </Group>

      <Group title="Erweitert">
        <Row label="Pfad zur Claude-CLI" description="Leer lassen: FORGE sucht Claude Code selbst." stacked>
          <ClaudePathInput value={s.claudePath} onSave={(v) => void save({ claudePath: v })} />
        </Row>
      </Group>
    </>
  );
}

/** Saved when the field is left or with Enter, so a half-typed path is never used. */
function ClaudePathInput({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  const commit = () => {
    if (draft.trim() !== (value ?? "")) onSave(draft.trim() || null);
  };
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
      placeholder="automatisch"
      className="font-mono text-xs"
      aria-label="Pfad zur Claude-CLI"
    />
  );
}

/** Everything with GitHub in one place: the account, the sync and the states it left on GitHub. */
function GitHubSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <GitHubSettings />
      <SyncSettings s={s} save={save} />
      {s.syncEnabled && (
        <Group title="Versionen auf GitHub" description="Jeder Abgleich ist ein Commit. Ein früherer Stand gilt nach dem Zurückholen auch für deine anderen PCs.">
          <div className="p-4">
            <GitHubVersions />
          </div>
        </Group>
      )}
    </>
  );
}

/** The phone settings come as their own cards, one per topic. */
function PhoneSection() {
  return <PhoneSettings />;
}

function AboutSection({ s, save }: { s: Settings; save: Save }) {
  return (
    <>
      <Group title="Updates">
        <div className="px-4 py-3.5">
          <AppUpdateSettings />
        </div>
        <SwitchRow
          label="Automatisch nach Updates suchen"
          description="Beim Start und alle 30 Minuten in den GitHub-Releases. Ein neues Update zeigt FORGE mit einer Zusammenfassung von Claude an. Braucht die GitHub-Anmeldung in FORGE."
          checked={s.updateChecks}
          onChange={(v) => void save({ updateChecks: v })}
        />
      </Group>

      <Group title="Datenschutz">
        <ul className="list-disc space-y-1.5 py-3.5 pl-9 pr-4 text-body text-muted">
          <li>Keine Telemetrie durch FORGE. Projektdaten bleiben auf deinem Rechner.</li>
          <li>Ist das Telefon eingeschaltet, geht Gesprächsaudio an Google (Gemini) oder OpenAI, je nach Einstellung unter Telefon.</li>
          <li>Tool-Ein- und Ausgaben prüft FORGE vor dem Speichern auf bekannte Secret-Muster und maskiert sie.</li>
          <li>FORGE liest keine Claude-Zugangsdaten. Die Anmeldung speichert Claude Code selbst.</li>
        </ul>
      </Group>

      <DiagnosticsPanel />
    </>
  );
}

function DiagnosticsPanel() {
  const diag = useDiagnostics();
  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(keys.diagnostics, await call("system.diagnostics", { refresh: true }));
    } catch (e) {
      toast.error("Diagnose fehlgeschlagen", errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };
  const d = diag.data;
  return (
    <Group
      title="Diagnose"
      description="Was FORGE auf diesem Rechner gefunden hat."
      action={
        <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={refreshing}>
          <RefreshCw className="h-3.5 w-3.5" /> Neu prüfen
        </Button>
      }
    >
      {diag.isLoading && <DiagnosticsSkeleton />}
      {diag.isError && (
        <div className="p-4">
          <ErrorBanner>{errorMessage(diag.error)}</ErrorBanner>
        </div>
      )}
      {d && (
        <>
          <div className="flex flex-col gap-1.5 px-4 py-3.5 text-body">
            <InfoRow label="System" value={d.platform} />
            <InfoRow label="Node.js (Sidecar)" value={d.nodeVersion} />
            <InfoRow label="Datenordner" value={<span className="block truncate font-mono text-xs" title={d.dataDir}>{d.dataDir}</span>} />
            <ToolRow label="Claude Code" t={d.claude} />
            <AuthRow d={d} />
            <InfoRow
              label="ANTHROPIC_API_KEY"
              value={
                !d.apiKeyEnvPresent ? (
                  <Badge tone="success">nicht gesetzt</Badge>
                ) : d.apiKeyStripped ? (
                  <Badge tone="warning">gesetzt, für Sessions ausgeblendet</Badge>
                ) : (
                  <Badge tone="danger">gesetzt und aktiv</Badge>
                )
              }
            />
            <ToolRow label="git" t={d.git} />
            <ToolRow label="GitHub CLI" t={d.gh} extra={d.gh.found ? (d.gh.authenticated ? <Badge tone="success">angemeldet</Badge> : <Badge tone="warning">nicht angemeldet</Badge>) : null} />
          </div>
          <div className="px-4 py-3.5">
            <div className="mb-2 text-xs font-medium text-muted">Funktionsübersicht (aktiver Adapter: Agent SDK)</div>
            <div className="divide-y divide-border rounded-lg border border-border">
              {d.capabilities.map((c) => (
                <div key={c.key} className="flex items-start gap-2 px-3 py-1.5 text-body">
                  {c.state === "supported" ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                  ) : c.state === "partial" ? (
                    <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  ) : (
                    <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                  )}
                  <span className="w-44 shrink-0">{c.label}</span>
                  <span className={cn("min-w-0 flex-1 pt-px text-xs", c.state === "unavailable" ? "text-subtle" : "text-muted")}>{c.note}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </Group>
  );
}

/** Same rows and boxes as the loaded diagnostics: eight info rows, then the capability list. */
function DiagnosticsSkeleton() {
  return (
    <SkeletonRegion label="Lädt Diagnose" className="divide-y divide-border">
      <div className="flex flex-col gap-1.5 px-4 py-3.5">
        {[45, 30, 70, 40, 35, 50, 30, 45].map((w, i) => (
          <div key={i} className="flex h-5 items-center gap-3">
            <div className="w-40 shrink-0">
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
      <div className="px-4 py-3.5">
        <Skeleton className="mb-2 h-3 w-64" />
        <div className="divide-y divide-border rounded-lg border border-border">
          {[55, 40, 65, 35, 50].map((w, i) => (
            <div key={i} className="flex h-8 items-center gap-2 px-3">
              <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-full" />
              <div className="w-44 shrink-0">
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-2.5" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-40 shrink-0 py-px text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  );
}

function ToolRow({ label, t, extra }: { label: string; t: ToolCheck; extra?: ReactNode }) {
  return (
    <InfoRow
      label={label}
      value={
        t.found ? (
          <span className="flex flex-wrap items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            {t.version ?? "gefunden"}
            {t.bundled ? <Badge tone="accent">mitgeliefert</Badge> : <Badge>System</Badge>}
            {extra}
          </span>
        ) : (
          <span className="flex items-center gap-2 text-danger">
            <XCircle className="h-3.5 w-3.5" /> nicht gefunden
          </span>
        )
      }
    />
  );
}

function AuthRow({ d }: { d: Diagnostics }) {
  if (!d.auth.checked) return <InfoRow label="Anmeldung" value={<span className="text-subtle">nicht geprüft</span>} />;
  if (d.auth.error) return <InfoRow label="Anmeldung" value={<span className="text-danger">{d.auth.error}</span>} />;
  return (
    <InfoRow
      label="Anmeldung"
      value={
        d.auth.loggedIn ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="success">angemeldet</Badge>
            <span className="text-muted">
              {d.auth.authMethod === "claude.ai" ? "Claude-Konto" : d.auth.authMethod}
              {d.auth.subscriptionType ? `, ${planLabel(d.auth)}` : ""}
            </span>
          </span>
        ) : (
          <span className="text-danger">nicht angemeldet. Die Anmeldung findest du unter Claude Code.</span>
        )
      }
    />
  );
}

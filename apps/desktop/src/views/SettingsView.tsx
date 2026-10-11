import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, CircleSlash, FolderOpen, RefreshCw, ShieldAlert, Volume2, XCircle } from "lucide-react";
import type { Diagnostics, ProfileId, Settings, ToolCheck, EffortLevel } from "@forge/protocol";
import { call, keys, useDiagnostics, useRuntimeInfo, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { pickFolder } from "@/lib/native";
import { playSound } from "@/lib/sounds";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge, ErrorBanner, SectionTitle, Loading, ToggleRow } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { ClaudeSetupCard } from "@/components/settings/ClaudeSetupCard";
import { MemoryEditor } from "@/components/settings/MemoryEditor";
import { effortOptions, fromChoice, modelOptions, toChoice } from "@/components/settings/model-options";
import { PhoneSettings } from "@/components/settings/PhoneSettings";
import { capitalize, cn } from "@/lib/utils";

export function SettingsView() {
  const settings = useSettings();
  const qc = useQueryClient();

  const save = async (patch: Partial<Settings>) => {
    try {
      const next = await call("settings.update", patch);
      qc.setQueryData(keys.settings, next);
      void qc.invalidateQueries({ queryKey: keys.diagnostics });
    } catch (e) {
      toast.error("Einstellung nicht gespeichert", errorMessage(e));
    }
  };

  const s = settings.data;
  return (
    <Page title="Einstellungen" subtitle="Einstellungen von FORGE. Die globalen Regeln unten stehen in ~/.claude/CLAUDE.md und gelten auch für Claude Code im Terminal.">
      {!s ? (
        <Loading />
      ) : (
        <div className="grid max-w-5xl gap-6 xl:grid-cols-2">
          <Card title="Allgemein">
            <div className="flex flex-col gap-4">
              <ModelSetting value={s.defaultModel} onChange={(v) => void save({ defaultModel: v })} />
              <Field label="Standard-Aufwand (Effort)" hint="Wie gründlich Claude nachdenkt. Höher ist genauer, aber langsamer und verbraucht mehr vom Abo.">
                <Select
                  value={toChoice(s.defaultEffort)}
                  onChange={(v) => void save({ defaultEffort: fromChoice<EffortLevel>(v) })}
                  className="w-full"
                  options={effortOptions("Claude-Code-Standard")}
                />
              </Field>
              <Field label="Standardprofil für neue Projekte">
                <Select<ProfileId>
                  value={s.defaultProfile}
                  onChange={(v) => void save({ defaultProfile: v })}
                  className="w-full"
                  options={PROFILE_IDS.map((p) => ({ value: p, label: PROFILE_INFO[p].label, description: PROFILE_INFO[p].description }))}
                />
              </Field>
              <Field label="Standardordner für neue Projekte">
                <div className="flex gap-2">
                  <Input value={s.defaultProjectDir ?? ""} readOnly placeholder="nicht gesetzt" className="font-mono text-xs" />
                  <Button
                    onClick={async () => {
                      try {
                        const p = await pickFolder("Standardordner wählen", s.defaultProjectDir);
                        if (p) void save({ defaultProjectDir: p });
                      } catch (e) {
                        toast.error("Ordnerdialog fehlgeschlagen", errorMessage(e));
                      }
                    }}
                  >
                    <FolderOpen className="h-3.5 w-3.5" /> Wählen
                  </Button>
                </div>
              </Field>
              <ToggleRow checked={s.enterToSend} onChange={(v) => void save({ enterToSend: v })} label="Enter sendet, Umschalt+Enter macht eine neue Zeile">
                Ausgeschaltet: Strg+Enter sendet, Enter macht eine neue Zeile.
              </ToggleRow>
              <div className="flex flex-col gap-1.5">
                <ToggleRow checked={s.sounds} onChange={(v) => void save({ sounds: v })} label="Töne abspielen">
                  Signal, wenn Claude fertig ist, eine Freigabe braucht oder ein Fehler auftritt.
                </ToggleRow>
                <div className="-ml-2 flex gap-1 pl-6">
                  {(["done", "approval", "error"] as const).map((k) => (
                    <Button key={k} size="sm" variant="ghost" onClick={() => playSound(k)} title="Ton anhören">
                      <Volume2 className="h-3.5 w-3.5" /> {k === "done" ? "Fertig" : k === "approval" ? "Freigabe" : "Fehler"}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Claude Code">
            <div className="flex flex-col gap-4">
              <ClaudeSetupCard />
              <Field label="Pfad zur Claude-CLI" hint="Leer lassen für automatische Suche im PATH.">
                <ClaudePathInput value={s.claudePath} onSave={(v) => void save({ claudePath: v })} />
              </Field>
              <ToggleRow checked={s.stripApiKey} onChange={(v) => void save({ stripApiKey: v })} label="ANTHROPIC_API_KEY für Sessions ausblenden">
                Empfohlen. Ein gesetzter API-Key überschreibt die Abo-Anmeldung und kann separat abgerechnet werden. Der Wert wird nie angezeigt.
              </ToggleRow>
              <ToggleRow checked={s.autoContinueAfterLimit} onChange={(v) => void save({ autoContinueAfterLimit: v })} label="Nach Nutzungslimit automatisch weitermachen">
                Stoppt das Nutzungslimit eine Session, schickt FORGE nach dem Reset selbst eine Nachricht, damit Claude weiterarbeitet. Nur für diese Session, mit ihrem Profil, höchstens dreimal ohne deine Eingabe. FORGE muss dafür laufen.
              </ToggleRow>
            </div>
          </Card>

          <div className="xl:col-span-2" id="telefon">
            <Card title="Telefon">
              <PhoneSettings />
            </Card>
          </div>

          <Card title="Sicherheit">
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
              <div className="flex-1 text-body">
                <div className="font-medium">Autonomous-Profil</div>
                <p className="mt-1 text-muted">
                  Autonomous startet Claude mit bypassPermissions: keine Rückfragen vor Befehlen und Dateiänderungen. Befehle laufen mit deinen Benutzerrechten. Die
                  FORGE-Sperrliste gilt weiterhin: kein Force-Push, kein reset --hard, keine Zugriffe auf ~/.ssh und andere Zugangsdaten, keine Schreibzugriffe außerhalb des
                  Projekts. Mit dem Tag sandbox-only schließt du einzelne Projekte aus.
                </p>
              </div>
            </div>
          </Card>

          <div className="xl:col-span-2">
            <Card title="Globale Regeln für Claude (~/.claude/CLAUDE.md)">
              <p className="mb-3 text-xs text-muted">Gilt in jedem Projekt, zusätzlich zur CLAUDE.md des Projekts.</p>
              <MemoryEditor scopes={["global"]} />
            </Card>
          </div>

          <Card title="Datenschutz">
            <ul className="list-disc space-y-1 pl-5 text-body text-muted">
              <li>Keine Telemetrie durch FORGE. Projektdaten bleiben lokal.</li>
              <li>Ausnahme Telefon: Ist es eingeschaltet, gehen Gesprächsaudio und vorgelesene Texte zur Spracherkennung und Sprachausgabe an OpenAI.</li>
              <li>Tool-Ein- und Ausgaben werden vor dem Speichern auf bekannte Secret-Muster geprüft und maskiert.</li>
              <li>FORGE liest keine Claude-Zugangsdaten. Die Anmeldung erledigt die Claude-CLI selbst.</li>
            </ul>
          </Card>

          <div className="xl:col-span-2">
            <DiagnosticsPanel />
          </div>
        </div>
      )}
    </Page>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <SectionTitle>{title}</SectionTitle>
      {children}
    </section>
  );
}

function ModelSetting({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const info = useRuntimeInfo();
  const models = info.data?.models ?? [];
  return (
    <Field label="Standardmodell" hint={info.isLoading ? "Modellliste wird von Claude Code gelesen …" : models.length ? undefined : "Modellliste nicht verfügbar"}>
      <Select value={toChoice(value)} onChange={(v) => onChange(fromChoice(v))} className="w-full" options={modelOptions(models, "Claude-Code-Standard")} />
    </Field>
  );
}

function ClaudePathInput({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  const dirty = draft !== (value ?? "");
  return (
    <div className="flex gap-2">
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="automatisch" className="font-mono text-xs" />
      <Button disabled={!dirty} onClick={() => onSave(draft.trim() || null)}>
        Speichern
      </Button>
    </div>
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
    <section className="rounded-xl border border-border bg-surface p-4">
      <SectionTitle
        action={
          <Button size="sm" variant="ghost" onClick={() => void refresh()} loading={refreshing}>
            <RefreshCw className="h-3.5 w-3.5" /> Neu prüfen
          </Button>
        }
      >
        Diagnose
      </SectionTitle>
      {diag.isLoading && <Loading label="Diagnose läuft …" />}
      {diag.isError && <ErrorBanner>{errorMessage(diag.error)}</ErrorBanner>}
      {d && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-1.5 text-body">
            <Row label="System" value={d.platform} />
            <Row label="Node.js (Sidecar)" value={d.nodeVersion} />
            <Row label="Datenordner" value={<span className="block truncate font-mono text-xs" title={d.dataDir}>{d.dataDir}</span>} />
            <ToolRow label="Claude Code" t={d.claude} />
            <AuthRow d={d} />
            <Row
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
          <div>
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
                  <span className={cn("min-w-0 flex-1 pt-px text-xs", c.state === "unavailable" ? "text-subtle" : "text-muted")}>
                    {c.note}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-40 shrink-0 py-px text-muted">{label}</span>
      <span className="min-w-0 flex-1 break-words">{value}</span>
    </div>
  );
}

function ToolRow({ label, t, extra }: { label: string; t: ToolCheck; extra?: ReactNode }) {
  return (
    <Row
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
  if (!d.auth.checked) return <Row label="Anmeldung" value={<span className="text-subtle">nicht geprüft</span>} />;
  if (d.auth.error) return <Row label="Anmeldung" value={<span className="text-danger">{d.auth.error}</span>} />;
  return (
    <Row
      label="Anmeldung"
      value={
        d.auth.loggedIn ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="success">angemeldet</Badge>
            <span className="text-muted">
              {d.auth.authMethod === "claude.ai" ? "Claude-Konto" : d.auth.authMethod}
              {d.auth.subscriptionType ? `, ${capitalize(d.auth.subscriptionType)} Abo` : ""}
            </span>
          </span>
        ) : (
          <span className="text-danger">nicht angemeldet. Die Anmeldung findest du oben in der Karte Claude Code.</span>
        )
      }
    />
  );
}

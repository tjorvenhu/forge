import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, MonitorSmartphone, PhoneIncoming, PhoneOutgoing, Power } from "lucide-react";
import { PHONE_GEMINI_VOICES, PHONE_VOICES, type ParamsOf, type PhoneConfig, type PhoneEngine, type PhoneState } from "@forge/protocol";
import { call, keys, usePhoneConfig, usePhoneState } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, ErrorBanner, Loading, SectionTitle, ToggleRow } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { PhoneStatusBadge } from "@/components/layout/PhoneButton";

const DEFAULT_PORT = "5060";

type Secret = "password" | "openAiKey" | "geminiKey" | "deskPassword" | "pin";

/** `port` and the desk numbers stay text while editing, so a field can be empty for a moment. */
type Draft = Omit<PhoneConfig, "enabled" | "hasPassword" | "hasOpenAiKey" | "hasGeminiKey" | "hasPin" | "port" | "desk"> & {
  port: string;
  password: string;
  openAiKey: string;
  geminiKey: string;
  pin: string;
  callers: string;
  desk: Omit<PhoneConfig["desk"], "hasWebPassword" | "provisioningUrl" | "httpPort" | "sessionKeys" | "clearKeys"> & {
    httpPort: string;
    sessionKeys: string;
    clearKeys: string;
    password: string;
  };
};

function toDraft(c: PhoneConfig): Draft {
  const { hasWebPassword: _h, provisioningUrl: _p, ...desk } = c.desk;
  return {
    ...c,
    port: String(c.port),
    password: "",
    openAiKey: "",
    geminiKey: "",
    pin: "",
    callers: c.allowedCallers.join("\n"),
    desk: { ...desk, httpPort: String(desk.httpPort), sessionKeys: desk.sessionKeys.join(", "), clearKeys: desk.clearKeys.join(", "), password: "" },
  };
}

function parsePort(text: string, min = 1): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= 65535 ? n : null;
}

function parseKeys(text: string, max = 10): number[] | null {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const keys = parts.map(Number);
  return keys.every((k) => Number.isInteger(k) && k >= 1 && k <= 30) && keys.length <= max ? keys : null;
}

const ENGINES: Array<{ value: PhoneEngine; label: string; description: string }> = [
  { value: "gemini-live", label: "Gemini Live", description: "Hört, denkt und spricht in einem Modell. Am natürlichsten, man kann jederzeit dazwischenreden." },
  { value: "claude", label: "Claude (Abo)", description: "Claude führt das Gespräch über dein Abo. Hören und Sprechen übernimmt OpenAI oder Gemini." },
];

/** Phone settings: SIP login of the user's PBX, who talks, who may call, when FORGE calls, PIN, desk phone. */
export function PhoneSettings() {
  const config = usePhoneConfig();
  const state = usePhoneState().data;
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (config.data && !draft) setDraft(toDraft(config.data));
  }, [config.data, draft]);

  if (config.isError) return <ErrorBanner>{errorMessage(config.error)}</ErrorBanner>;
  if (!config.data || !draft) return <Loading />;
  const c = config.data;
  const up = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const upDesk = (patch: Partial<Draft["desk"]>) => setDraft({ ...draft, desk: { ...draft.desk, ...patch } });
  const live = draft.engine === "gemini-live";
  const needsGemini = live || draft.speechProvider === "gemini";
  const needsOpenAi = !live && draft.speechProvider === "openai";

  const save = async () => {
    const port = parsePort(draft.port);
    const deskPort = parsePort(draft.desk.httpPort, 1024);
    const sessionKeys = parseKeys(draft.desk.sessionKeys);
    if (port === null) return toast.error("Nicht gespeichert", "Der Port muss eine Zahl von 1 bis 65535 sein.");
    if (deskPort === null) return toast.error("Nicht gespeichert", "Der Port fürs Tischtelefon muss eine Zahl von 1024 bis 65535 sein.");
    const clearKeys = parseKeys(draft.desk.clearKeys, 30);
    if (sessionKeys === null) return toast.error("Nicht gespeichert", "Session-Tasten: bis zu 10 Tastennummern von 1 bis 30, z. B. 1, 2, 3, 4.");
    if (clearKeys === null) return toast.error("Nicht gespeichert", "Tasten leeren: Tastennummern von 1 bis 30, z. B. 5, 6, 7, 8.");
    setSaving(true);
    try {
      const { password: deskPassword, ...desk } = draft.desk;
      const patch: ParamsOf<"phone.saveConfig"> = {
        server: draft.server,
        port,
        username: draft.username,
        authUsername: draft.authUsername?.trim() || null,
        domain: draft.domain?.trim() || null,
        displayName: draft.displayName,
        engine: draft.engine,
        liveModel: draft.liveModel,
        geminiVoice: draft.geminiVoice,
        speechProvider: draft.speechProvider,
        geminiSttModel: draft.geminiSttModel,
        geminiTtsModel: draft.geminiTtsModel,
        voice: draft.voice,
        sttModel: draft.sttModel,
        ttsModel: draft.ttsModel,
        allowedCallers: draft.callers.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
        notifyNumber: draft.notifyNumber?.trim() || null,
        notifyOn: draft.notifyOn,
        requirePin: draft.requirePin,
        desk: { ...desk, httpPort: deskPort, sessionKeys, clearKeys },
        ...(draft.password ? { password: draft.password } : {}),
        ...(draft.openAiKey ? { openAiKey: draft.openAiKey } : {}),
        ...(draft.geminiKey ? { geminiKey: draft.geminiKey } : {}),
        ...(deskPassword ? { deskPassword } : {}),
        ...(draft.pin ? { pin: draft.pin } : {}),
      };
      const next = await call("phone.saveConfig", patch);
      qc.setQueryData(keys.phoneConfig, next);
      setDraft(toDraft(next));
      toast.success(
        "Telefon-Einstellungen gespeichert",
        c.enabled ? "Geänderte Verbindungsdaten übernimmt FORGE sofort, während eines Gesprächs erst nach dem Auflegen." : undefined,
      );
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const removeSecret = async (what: Secret) => {
    try {
      qc.setQueryData(keys.phoneConfig, await call("phone.saveConfig", { [what]: "" }));
    } catch (e) {
      toast.error("Nicht entfernt", errorMessage(e));
    }
  };

  const toggle = async (enabled: boolean) => {
    try {
      qc.setQueryData(keys.phoneState, await call("phone.setEnabled", { enabled }));
      qc.setQueryData(keys.phoneConfig, await call("phone.config", {}));
    } catch (e) {
      toast.error(enabled ? "Telefon nicht eingeschaltet" : "Telefon nicht ausgeschaltet", errorMessage(e));
    }
  };

  const secret = (label: string, has: boolean, value: string, onChange: (v: string) => void, what: Secret, hint?: string, inputMode?: "numeric") => (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <Input
          type="password"
          value={value}
          inputMode={inputMode}
          autoComplete="new-password"
          onChange={(e) => onChange(e.target.value)}
          placeholder={has ? "gespeichert, zum Ändern neu eingeben" : "nicht gesetzt"}
        />
        {has && (
          <Button variant="ghost" onClick={() => void removeSecret(what)}>
            Entfernen
          </Button>
        )}
      </div>
    </Field>
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
        {state && <PhoneStatusBadge state={state} />}
        <span className="min-w-0 flex-1 text-body text-muted">
          {state?.registration === "failed" && state.message
            ? state.message
            : state?.registration === "registered"
              ? `Angemeldet als ${c.username} an ${c.server}.`
              : "Ein- und ausschalten auch über das Telefon-Symbol oben rechts."}
        </span>
        {state?.registration === "registered" && c.notifyNumber && (
          <Button size="sm" onClick={() => void call("phone.testCall", {}).then((s) => qc.setQueryData(keys.phoneState, s)).catch((e: unknown) => toast.error("Testanruf fehlgeschlagen", errorMessage(e)))}>
            <PhoneOutgoing className="h-3.5 w-3.5" /> Testanruf
          </Button>
        )}
        <Button size="sm" variant={c.enabled ? "outline" : "primary"} onClick={() => void toggle(!c.enabled)}>
          <Power className="h-3.5 w-3.5" /> {c.enabled ? "Ausschalten" : "Einschalten"}
        </Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <div className="flex flex-col gap-4">
          <SectionTitle>Anmeldung an der Telefonanlage (SIP)</SectionTitle>
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label="Server">
              <Input value={draft.server} onChange={(e) => up({ server: e.target.value })} placeholder="z. B. pbx.example.de oder 192.168.1.10" className="font-mono text-xs" />
            </Field>
            <Field label="Port">
              <Input
                value={draft.port}
                onChange={(e) => up({ port: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                onBlur={() => !draft.port && up({ port: DEFAULT_PORT })}
                inputMode="numeric"
                aria-invalid={parsePort(draft.port) === null || undefined}
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Benutzer / Nebenstelle" hint="Diese Nummer rufst du an, um FORGE zu erreichen.">
              <Input value={draft.username} onChange={(e) => up({ username: e.target.value })} className="font-mono text-xs" />
            </Field>
            <Field label="Anzeigename">
              <Input value={draft.displayName} onChange={(e) => up({ displayName: e.target.value })} />
            </Field>
          </div>
          {secret("Passwort", c.hasPassword, draft.password, (v) => up({ password: v }), "password")}
          <button className="flex items-center gap-1 self-start text-xs text-muted hover:text-fg" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
            <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", advanced && "rotate-90")} /> Erweitert
          </button>
          {advanced && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Anmeldename (falls abweichend)">
                <Input value={draft.authUsername ?? ""} onChange={(e) => up({ authUsername: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label="SIP-Domain (falls abweichend)">
                <Input value={draft.domain ?? ""} onChange={(e) => up({ domain: e.target.value })} placeholder={draft.server} className="font-mono text-xs" />
              </Field>
              <Field label="Modell Gemini Live">
                <Input value={draft.liveModel} onChange={(e) => up({ liveModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <div />
              <Field label="Gemini Spracherkennung">
                <Input value={draft.geminiSttModel} onChange={(e) => up({ geminiSttModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label="Gemini Sprachausgabe">
                <Input value={draft.geminiTtsModel} onChange={(e) => up({ geminiTtsModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label="OpenAI Spracherkennung">
                <Input value={draft.sttModel} onChange={(e) => up({ sttModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label="OpenAI Sprachausgabe">
                <Input value={draft.ttsModel} onChange={(e) => up({ ttsModel: e.target.value })} className="font-mono text-xs" />
              </Field>
            </div>
          )}
          <p className="text-xs text-subtle">
            FORGE meldet sich über UDP an. Audio läuft unverschlüsselt als G.711 (PCMA/PCMU). TLS und SRTP werden noch nicht unterstützt. Beim ersten Anruf
            fragt die Windows-Firewall, ob Node.js Verbindungen annehmen darf. Erlaube mindestens private Netzwerke, sonst kommt im Gespräch kein Ton an.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <SectionTitle>Gesprächspartner</SectionTitle>
          <Field label="Wer spricht mit dir">
            <Select<PhoneEngine> value={draft.engine} onChange={(v) => up({ engine: v })} options={ENGINES} className="w-full" />
          </Field>
          {!live && (
            <Field label="Hören und Sprechen über">
              <Select<"openai" | "gemini">
                value={draft.speechProvider}
                onChange={(v) => up({ speechProvider: v })}
                options={[
                  { value: "gemini", label: "Gemini" },
                  { value: "openai", label: "OpenAI" },
                ]}
                className="w-full"
              />
            </Field>
          )}
          {needsGemini &&
            secret(
              "Gemini-API-Key",
              c.hasGeminiKey,
              draft.geminiKey,
              (v) => up({ geminiKey: v }),
              "geminiKey",
              live ? "Für Gemini Live. Abgerechnet über dein Google-AI-Konto, nicht über das Claude-Abo." : "Für Spracherkennung und Sprachausgabe. Das Gespräch selbst führt Claude über dein Abo.",
            )}
          {needsOpenAi &&
            secret("OpenAI-API-Key", c.hasOpenAiKey, draft.openAiKey, (v) => up({ openAiKey: v }), "openAiKey", "Für Spracherkennung und Sprachausgabe. Das Gespräch selbst führt Claude über dein Abo.")}
          <Field label="Stimme">
            {needsGemini ? (
              <Select value={draft.geminiVoice} onChange={(v) => up({ geminiVoice: v })} options={PHONE_GEMINI_VOICES.map((v) => ({ value: v, label: v }))} className="w-full" />
            ) : (
              <Select value={draft.voice} onChange={(v) => up({ voice: v })} options={PHONE_VOICES.map((v) => ({ value: v, label: v }))} className="w-full" />
            )}
          </Field>
          <SectionTitle>Wer darf anrufen, wann ruft FORGE an</SectionTitle>
          <Field label="Erlaubte Anrufer" hint="Eine Nummer pro Zeile. Andere Anrufe weist FORGE ab. Ist die Liste leer, nimmt FORGE keine Anrufe an.">
            <Textarea value={draft.callers} onChange={(e) => up({ callers: e.target.value })} rows={3} className="font-mono text-xs" placeholder="+49 170 1234567" />
          </Field>
          <Field label="FORGE ruft diese Nummer an">
            <Input value={draft.notifyNumber ?? ""} onChange={(e) => up({ notifyNumber: e.target.value })} className="font-mono text-xs" placeholder="z. B. Handy oder Nebenstelle" />
          </Field>
          <div className="flex flex-col gap-2">
            {(
              [
                ["done", "Wenn eine Session fertig ist", "mit kurzer Zusammenfassung des Ergebnisses"],
                ["approval", "Wenn Claude eine Freigabe, Antwort oder Plan-Entscheidung braucht", "nach 15 Sekunden ohne Antwort am Rechner"],
                ["error", "Bei Fehlern", "abgebrochene Durchläufe und Fehlermeldungen"],
              ] as const
            ).map(([k, label, hint]) => (
              <ToggleRow key={k} checked={draft.notifyOn[k]} onChange={(v) => up({ notifyOn: { ...draft.notifyOn, [k]: v } })} label={label}>
                {hint}
              </ToggleRow>
            ))}
          </div>
          <SectionTitle>Steuern am Telefon</SectionTitle>
          {secret("PIN", c.hasPin, draft.pin, (v) => up({ pin: v.replace(/\D/g, "").slice(0, 8) }), "pin", "4 bis 8 Ziffern. Im Gespräch über die Telefontastatur eingeben und mit # bestätigen.", "numeric")}
          <ToggleRow checked={draft.requirePin} onChange={(v) => up({ requirePin: v })} label="PIN zum Steuern verlangen">
            Empfohlen. Ohne PIN darf jeder mit einer erlaubten Nummer Sessions starten, Anweisungen schicken und Freigaben erteilen. Anrufernummern lassen sich fälschen.
          </ToggleRow>
        </div>
      </div>

      <DeskSettings draft={draft} config={c} state={state} up={upDesk} secret={secret} />

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <p className="flex-1 text-xs text-subtle">
          Bei eingeschaltetem Telefon geht Gesprächsaudio an {live ? "Google (Gemini Live)" : draft.speechProvider === "gemini" ? "Google (Gemini)" : "OpenAI"}. Passwörter und
          API-Keys speichert FORGE verschlüsselt für dein Windows-Konto.
        </p>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={draft.pin.length > 0 && draft.pin.length < 4}>
          Speichern
        </Button>
      </div>

      <CallLog />
    </div>
  );
}

function DeskSettings({
  draft,
  config,
  state,
  up,
  secret,
}: {
  draft: Draft;
  config: PhoneConfig;
  state: PhoneState | undefined;
  up: (patch: Partial<Draft["desk"]>) => void;
  secret: (label: string, has: boolean, value: string, onChange: (v: string) => void, what: Secret, hint?: string) => ReactNode;
}) {
  const qc = useQueryClient();
  const d = draft.desk;
  const url = config.desk.provisioningUrl;
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast.success("Adresse kopiert"),
      () => toast.error("Nicht kopiert", "Die Zwischenablage ist nicht erreichbar."),
    );
  const test = () =>
    void call("phone.deskTest", {})
      .then((s) => {
        qc.setQueryData(keys.phoneState, s);
        toast.success("Testnachricht geschickt", "Auf dem Telefon sollte kurz „Verbindung steht.“ erscheinen.");
      })
      .catch((e: unknown) => toast.error("Tischtelefon nicht erreichbar", errorMessage(e)));
  const desk = state?.desk;

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <MonitorSmartphone className="h-4 w-4 text-muted" />
        <SectionTitle>Tischtelefon (Yealink)</SectionTitle>
        {desk && (
          <Badge tone={desk.reachable === true ? "success" : desk.reachable === false ? "danger" : "neutral"}>
            {desk.reachable === true ? "verbunden" : desk.reachable === false ? "nicht erreichbar" : "wartet"}
          </Badge>
        )}
        <span className="flex-1" />
        {desk && (
          <Button size="sm" onClick={test}>
            Test
          </Button>
        )}
      </div>
      <ToggleRow checked={d.enabled} onChange={(v) => up({ enabled: v })} label="Tischtelefon einbinden">
        Pro laufender Session eine Taste mit Namen und farbiger LED, Status auf dem Display, Freigaben als Menü. Abheben ruft FORGE an. Getestet mit Yealink T53W.
      </ToggleRow>
      {desk?.message && <p className="text-xs text-danger">{desk.message}</p>}
      {d.enabled && (
        <div className="grid gap-5 xl:grid-cols-2">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field label="IP des Telefons" hint="Am Telefon unter Menü → Status.">
                <Input value={d.phoneIp} onChange={(e) => up({ phoneIp: e.target.value })} placeholder="192.168.0.50" className="font-mono text-xs" />
              </Field>
              <Field label="Port FORGE">
                <Input
                  value={d.httpPort}
                  onChange={(e) => up({ httpPort: e.target.value.replace(/\D/g, "").slice(0, 5) })}
                  inputMode="numeric"
                  aria-invalid={parsePort(d.httpPort, 1024) === null || undefined}
                  className="font-mono text-xs"
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Web-Login Benutzer">
                <Input value={d.webUser} onChange={(e) => up({ webUser: e.target.value })} className="font-mono text-xs" />
              </Field>
              {secret("Web-Login Passwort", config.desk.hasWebPassword, d.password, (v) => up({ password: v }), "deskPassword")}
            </div>
            <Field label="Session-Tasten" hint="Leitungstasten für Sessions, in dieser Reihenfolge (S1 auf der ersten). Andere Tasten lässt FORGE in Ruhe.">
              <Input value={d.sessionKeys} onChange={(e) => up({ sessionKeys: e.target.value })} aria-invalid={parseKeys(d.sessionKeys) === null || undefined} className="font-mono text-xs" />
            </Field>
            <Field label="Tasten leeren" hint="Diese Tasten stellt FORGE auf „nicht belegt“, z. B. 5, 6, 7, 8 (Senden, Nochmal, Löschen, Stopp aus klaus_telefon).">
              <Input
                value={d.clearKeys}
                onChange={(e) => up({ clearKeys: e.target.value })}
                aria-invalid={parseKeys(d.clearKeys, 30) === null || undefined}
                placeholder="keine"
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <div className="flex flex-col gap-3">
            <ToggleRow checked={d.hotline} onChange={(v) => up({ hotline: v })} label="Abheben ruft FORGE an">
              Nach einer Sekunde wählt das Telefon die FORGE-Nebenstelle ({draft.username || "noch nicht eingetragen"}). Sofort eine Nummer tippen = normal telefonieren.
            </ToggleRow>
            <ToggleRow checked={d.leds} onChange={(v) => up({ leds: v })} label="LEDs der Session-Tasten steuern">
              Orange blinkt: arbeitet. Rot blinkt schnell: wartet auf dich. Grün blinkt: neues Ergebnis. Grün: bereit.
            </ToggleRow>
            <Field label="Status auf dem Display">
              <Select<"lines" | "statusline" | "off">
                value={d.display}
                onChange={(v) => up({ display: v })}
                options={[
                  { value: "lines", label: "Mehrere Zeilen", description: "Gewählte Session, Stand, offene Frage oder Kurzfassung" },
                  { value: "statusline", label: "Eine Zeile", description: "Kompakt, für Modelle mit nur einer Statuszeile" },
                  { value: "off", label: "Aus", description: "Nur Tasten und LEDs" },
                ]}
                className="w-full"
              />
            </Field>
          </div>
          <div className="xl:col-span-2">
            <Field label="Im Telefon eintragen: Einstellungen → Auto Provision → Server URL, dann „Autoprovision Now“">
              <div className="flex gap-2">
                <Input value={url ?? "erscheint nach dem Speichern bei eingeschaltetem Telefon"} readOnly className="font-mono text-xs" />
                {url && (
                  <Button variant="ghost" size="icon" aria-label="Adresse kopieren" onClick={() => void copy(url)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

function CallLog() {
  const calls = useQuery({ queryKey: keys.phoneCalls, queryFn: () => call("phone.calls", { limit: 20 }) });
  const [open, setOpen] = useState<string | null>(null);
  if (!calls.data?.length) return null;
  return (
    <div>
      <SectionTitle>Letzte Anrufe</SectionTitle>
      <div className="divide-y divide-border rounded-lg border border-border">
        {calls.data.map((c) => (
          <div key={c.id}>
            <button className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-body hover:bg-surface-2" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              {c.direction === "in" ? <PhoneIncoming className="h-3.5 w-3.5 text-muted" /> : <PhoneOutgoing className="h-3.5 w-3.5 text-muted" />}
              <span className="font-mono text-xs">{c.number || "unbekannt"}</span>
              <span className={cn("text-xs", c.result === "answered" ? "text-success" : c.result === "missed" ? "text-warning" : "text-danger")}>
                {c.result === "answered" ? "Gespräch" : c.result === "missed" ? "nicht erreicht" : c.result === "rejected" ? "abgewiesen" : "fehlgeschlagen"}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.reason ?? c.detail ?? ""}</span>
              <span className="text-caption text-subtle">{relativeTime(c.startedAt)}</span>
            </button>
            {open === c.id && (
              <div className="space-y-1 bg-surface-2 px-3 py-2 text-xs">
                {c.detail && <div className="text-muted">Ende: {c.detail}</div>}
                {c.transcript.length === 0 && <div className="text-subtle">Kein Gesprächsverlauf.</div>}
                {c.transcript.map((t, i) => (
                  <div key={i} className="flex gap-2">
                    <span className={cn("w-12 shrink-0", t.role === "caller" ? "text-accent" : "text-muted")}>{t.role === "caller" ? "Du" : "FORGE"}</span>
                    <span>{t.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

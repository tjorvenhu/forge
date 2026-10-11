import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, PhoneIncoming, PhoneOutgoing, Power } from "lucide-react";
import type { ParamsOf, PhoneConfig } from "@forge/protocol";
import { call, keys, usePhoneConfig, usePhoneState } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Checkbox, ErrorBanner, Loading, SectionTitle } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { PhoneStatusBadge } from "@/components/layout/PhoneButton";

const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

type Draft = Omit<PhoneConfig, "enabled" | "hasPassword" | "hasOpenAiKey" | "hasPin"> & { password: string; openAiKey: string; pin: string; callers: string };

function toDraft(c: PhoneConfig): Draft {
  return { ...c, password: "", openAiKey: "", pin: "", callers: c.allowedCallers.join("\n") };
}

/** Phone settings: SIP login of the user's PBX, voice, who may call, when FORGE calls, PIN. */
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

  const save = async () => {
    setSaving(true);
    try {
      const patch: ParamsOf<"phone.saveConfig"> = {
        server: draft.server,
        port: draft.port,
        username: draft.username,
        authUsername: draft.authUsername?.trim() || null,
        domain: draft.domain?.trim() || null,
        displayName: draft.displayName,
        voice: draft.voice,
        sttModel: draft.sttModel,
        ttsModel: draft.ttsModel,
        allowedCallers: draft.callers.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
        notifyNumber: draft.notifyNumber?.trim() || null,
        notifyOn: draft.notifyOn,
        requirePin: draft.requirePin,
        ...(draft.password ? { password: draft.password } : {}),
        ...(draft.openAiKey ? { openAiKey: draft.openAiKey } : {}),
        ...(draft.pin ? { pin: draft.pin } : {}),
      };
      const next = await call("phone.saveConfig", patch);
      qc.setQueryData(keys.phoneConfig, next);
      setDraft(toDraft(next));
      toast.success("Telefon-Einstellungen gespeichert", c.enabled ? "Die Verbindung zur Anlage wird bei Bedarf neu aufgebaut." : undefined);
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const removeSecret = async (what: "password" | "openAiKey" | "pin") => {
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

  const secret = (label: string, has: boolean, value: string, onChange: (v: string) => void, what: "password" | "openAiKey" | "pin", hint?: string, inputMode?: "numeric") => (
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
        <span className="min-w-0 flex-1 text-[13px] text-muted">
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
              <Input value={String(draft.port)} onChange={(e) => up({ port: Number(e.target.value.replace(/\D/g, "")) || 5060 })} inputMode="numeric" className="font-mono text-xs" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Benutzer / Nebenstelle">
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
              <Field label="Modell Spracherkennung">
                <Input value={draft.sttModel} onChange={(e) => up({ sttModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label="Modell Sprachausgabe">
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
          <SectionTitle>Sprache</SectionTitle>
          {secret("OpenAI-API-Key", c.hasOpenAiKey, draft.openAiKey, (v) => up({ openAiKey: v }), "openAiKey", "Für Spracherkennung und Sprachausgabe. Das Gespräch selbst führt Claude über dein Abo.")}
          <Field label="Stimme">
            <Select value={draft.voice} onChange={(v) => up({ voice: v })} options={VOICES.map((v) => ({ value: v, label: v }))} className="w-full" />
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
              <label key={k} className="flex items-start gap-2.5">
                <span className="mt-0.5">
                  <Checkbox checked={draft.notifyOn[k]} onChange={(v) => up({ notifyOn: { ...draft.notifyOn, [k]: v } })} label={label} />
                </span>
                <span>
                  <span className="block text-[13px]">{label}</span>
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <SectionTitle>Steuern am Telefon</SectionTitle>
          {secret("PIN", c.hasPin, draft.pin, (v) => up({ pin: v.replace(/\D/g, "").slice(0, 8) }), "pin", "4 bis 8 Ziffern. Im Gespräch über die Telefontastatur eingeben und mit # bestätigen.", "numeric")}
          <label className="flex items-start gap-2.5">
            <span className="mt-0.5">
              <Checkbox checked={draft.requirePin} onChange={(v) => up({ requirePin: v })} label="PIN zum Steuern verlangen" />
            </span>
            <span>
              <span className="block text-[13px]">PIN zum Steuern verlangen</span>
              <span className="block text-xs text-muted">
                Empfohlen. Ohne PIN darf jeder mit einer erlaubten Nummer Sessions starten, Anweisungen schicken und Freigaben erteilen. Anrufernummern lassen sich fälschen.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <p className="flex-1 text-xs text-subtle">
          Bei eingeschaltetem Telefon gehen Gesprächsaudio und vorgelesene Texte an OpenAI. Passwort und API-Key speichert FORGE verschlüsselt für dein Windows-Konto.
        </p>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={draft.pin.length > 0 && draft.pin.length < 4}>
          Speichern
        </Button>
      </div>

      <CallLog />
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
            <button className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] hover:bg-surface-2" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              {c.direction === "in" ? <PhoneIncoming className="h-3.5 w-3.5 text-muted" /> : <PhoneOutgoing className="h-3.5 w-3.5 text-muted" />}
              <span className="font-mono text-xs">{c.number || "unbekannt"}</span>
              <span className={cn("text-xs", c.result === "answered" ? "text-success" : c.result === "missed" ? "text-warning" : "text-danger")}>
                {c.result === "answered" ? "Gespräch" : c.result === "missed" ? "nicht erreicht" : c.result === "rejected" ? "abgewiesen" : "fehlgeschlagen"}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.reason ?? c.detail ?? ""}</span>
              <span className="text-[11px] text-subtle">{relativeTime(c.startedAt)}</span>
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

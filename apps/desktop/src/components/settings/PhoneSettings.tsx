import { useCallback, useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, MonitorSmartphone, PhoneIncoming, PhoneOutgoing, Power } from "lucide-react";
import { PHONE_GEMINI_VOICES, PHONE_VOICES, type ParamsOf, type PhoneConfig, type PhoneEngine, type PhoneState } from "@forge/protocol";
import { call, keys, usePhoneConfig, usePhoneState } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge, ErrorBanner, LabelWithInfo, ToggleRow } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";
import { PhoneStatusBadge } from "@/components/layout/PhoneButton";
import { PhoneNumberList } from "./PhoneNumberList";
import { Group } from "./layout";
import { t } from "@/i18n";

const tp = t.settings.phone;

const DEFAULT_PORT = "5060";

type Secret = "password" | "openAiKey" | "geminiKey" | "deskPassword" | "pin";

/** `port` and the desk numbers stay text while editing, so a field can be empty for a moment. */
type Draft = Omit<PhoneConfig, "enabled" | "hasPassword" | "hasOpenAiKey" | "hasGeminiKey" | "hasPin" | "port" | "desk"> & {
  port: string;
  password: string;
  openAiKey: string;
  geminiKey: string;
  pin: string;
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

/** Fields saved only together with a secret value; the rest of the draft is compared to the last save. */
const SECRET_FIELDS = ["password", "openAiKey", "geminiKey", "pin"] as const;

/** The draft as a save request; secrets only when typed in, the PIN only when complete. */
function toPatch(d: Draft): { patch: ParamsOf<"phone.saveConfig">; key: string; secrets: boolean } | { error: string } {
  const port = parsePort(d.port);
  const deskPort = parsePort(d.desk.httpPort, 1024);
  const sessionKeys = parseKeys(d.desk.sessionKeys);
  const clearKeys = parseKeys(d.desk.clearKeys, 30);
  if (port === null) return { error: tp.errors.port };
  if (deskPort === null) return { error: tp.errors.deskPort };
  if (sessionKeys === null) return { error: tp.errors.sessionKeys };
  if (clearKeys === null) return { error: tp.errors.clearKeys };
  const { password: deskPassword, ...desk } = d.desk;
  const base: ParamsOf<"phone.saveConfig"> = {
    server: d.server,
    port,
    username: d.username,
    authUsername: d.authUsername?.trim() || null,
    domain: d.domain?.trim() || null,
    displayName: d.displayName,
    engine: d.engine,
    liveModel: d.liveModel,
    geminiVoice: d.geminiVoice,
    speechProvider: d.speechProvider,
    geminiSttModel: d.geminiSttModel,
    geminiTtsModel: d.geminiTtsModel,
    voice: d.voice,
    sttModel: d.sttModel,
    ttsModel: d.ttsModel,
    // A row just added has no number yet: nothing to save until one is typed.
    allowedCallers: d.allowedCallers.filter((n) => n.number.trim()),
    notifyNumbers: d.notifyNumbers.filter((n) => n.number.trim()),
    notifyOn: d.notifyOn,
    requirePin: d.requirePin,
    desk: { ...desk, httpPort: deskPort, sessionKeys, clearKeys },
  };
  const secrets = {
    ...(d.password ? { password: d.password } : {}),
    ...(d.openAiKey ? { openAiKey: d.openAiKey } : {}),
    ...(d.geminiKey ? { geminiKey: d.geminiKey } : {}),
    ...(deskPassword ? { deskPassword } : {}),
    ...(d.pin.length >= 4 ? { pin: d.pin } : {}),
  };
  return { patch: { ...base, ...secrets }, key: JSON.stringify(base), secrets: Object.keys(secrets).length > 0 };
}

/** After a save: secret fields that still hold what was sent are emptied (the field then shows "gespeichert"). */
function clearSent(cur: Draft, sent: Draft): Draft {
  const next = { ...cur };
  for (const f of SECRET_FIELDS) if (cur[f] === sent[f] && (f !== "pin" || cur.pin.length >= 4)) next[f] = "";
  if (cur.desk.password === sent.desk.password) next.desk = { ...cur.desk, password: "" };
  return next;
}

/** Typing in a text field: saved when the field is left, not on every key. */
function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(el.type);
}

const ENGINES: Array<{ value: PhoneEngine; label: string; description: string }> = [
  { value: "gemini-live", label: "Gemini Live", description: tp.engines.live },
  { value: "claude", label: tp.engines.claudeLabel, description: tp.engines.claude },
];

/** Phone settings: SIP login of the user's PBX, who talks, who may call, when FORGE calls, PIN, desk phone. */
export function PhoneSettings() {
  const config = usePhoneConfig();
  const state = usePhoneState().data;
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [models, setModels] = useState(false);
  const latest = useRef<Draft | null>(null);
  /** the non-secret part of the last save; equal drafts are not sent again */
  const lastSaved = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!config.data || draft) return;
    const d = toDraft(config.data);
    const r = toPatch(d);
    lastSaved.current = "key" in r ? r.key : null;
    setDraft(d);
  }, [config.data, draft]);
  useEffect(() => {
    latest.current = draft;
  }, [draft]);

  /** a save is on its way */
  const saving = useRef(false);
  /** asked for while a save was on its way; runs after it (with `report` if any of the calls wanted it) */
  const queued = useRef<boolean | null>(null);

  /**
   * Saves the draft when it changed; `report`: also say why an invalid one was not saved. One save at a
   * time: a slow older answer must not land after a newer change and count as the last save.
   */
  const persist = useCallback(
    async function run(report: boolean): Promise<void> {
      if (saving.current) {
        queued.current = !!queued.current || report;
        return;
      }
      const d = latest.current;
      if (!d) return;
      if (report && d.pin.length > 0 && d.pin.length < 4) toast.error(tp.pinNotSaved, tp.pinLength);
      const r = toPatch(d);
      if ("error" in r) {
        if (report) toast.error(tp.notSaved, r.error);
        return;
      }
      if (r.key === lastSaved.current && !r.secrets) return;
      saving.current = true;
      try {
        const next = await call("phone.saveConfig", r.patch);
        lastSaved.current = r.key;
        qc.setQueryData(keys.phoneConfig, next);
        setDraft((cur) => (cur ? clearSent(cur, d) : cur));
        toast.saved();
      } catch (e) {
        toast.error(tp.notSaved, errorMessage(e));
      } finally {
        saving.current = false;
        const again = queued.current;
        queued.current = null;
        if (again !== null) void run(again);
      }
    },
    [qc],
  );
  const schedule = useCallback(
    (report: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void persist(report);
      }, 300);
    },
    [persist],
  );
  // Selections and switches save right away; text fields when they are left (onBlur below).
  useEffect(() => {
    if (!draft) return;
    if (!isTextField(document.activeElement)) schedule(false);
    else if (timer.current) {
      // Typing goes on: a save still waiting would catch the field half-typed.
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, [draft, schedule]);
  // Leaving the settings saves what is still pending, also a text field that never lost its focus.
  // persist() sends nothing when the draft equals the last save.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      void persist(false);
    },
    [persist],
  );
  const onFieldBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (isTextField(e.target)) schedule(true);
  };

  if (config.isError) return <ErrorBanner>{errorMessage(config.error)}</ErrorBanner>;
  if (!config.data || !draft) return <PhoneSettingsSkeleton />;
  const c = config.data;
  // The header button, the palette and the phone itself switch it too and only push the phone state.
  const enabled = state?.enabled ?? c.enabled;
  const up =(patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const upDesk = (patch: Partial<Draft["desk"]>) => setDraft({ ...draft, desk: { ...draft.desk, ...patch } });
  const live = draft.engine === "gemini-live";
  const needsGemini = live || draft.speechProvider === "gemini";
  const needsOpenAi = !live && draft.speechProvider === "openai";

  const removeSecret = async (what: Secret) => {
    try {
      qc.setQueryData(keys.phoneConfig, await call("phone.saveConfig", { [what]: "" }));
      toast.saved();
    } catch (e) {
      toast.error(tp.notRemoved, errorMessage(e));
    }
  };

  const toggle = async (enabled: boolean) => {
    try {
      qc.setQueryData(keys.phoneState, await call("phone.setEnabled", { enabled }));
      qc.setQueryData(keys.phoneConfig, await call("phone.config", {}));
    } catch (e) {
      toast.error(enabled ? tp.notEnabled : tp.notDisabled, errorMessage(e));
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
          placeholder={has ? tp.secretSaved : tp.secretUnset}
        />
        {has && (
          <Button variant="ghost" onClick={() => void removeSecret(what)}>
            {tp.remove}
          </Button>
        )}
      </div>
    </Field>
  );

  return (
    <div onBlur={onFieldBlur} className="flex flex-col gap-6">
      <Group
        title={tp.title}
        description={enabled ? tp.descriptionOn : tp.descriptionOff}
      >
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          {state && <PhoneStatusBadge state={state} />}
          <span className="min-w-0 flex-1 text-body text-muted">
            {state?.registration === "failed" && state.message
              ? state.message
              : state?.registration === "registered"
                ? tp.registeredAs(c.username, c.server)
                : !c.server
                  ? tp.enterCredentials
                  : tp.toggleHint}
          </span>
          {state?.registration === "registered" && c.notifyNumbers.some((n) => n.enabled) && (
            <Button size="sm" onClick={() => void call("phone.testCall", {}).then((s) => qc.setQueryData(keys.phoneState, s)).catch((e: unknown) => toast.error(tp.testCallFailed, errorMessage(e)))}>
              <PhoneOutgoing className="h-3.5 w-3.5" /> {tp.testCall}
            </Button>
          )}
          <Button size="sm" variant={enabled ? "outline" : "primary"} onClick={() => void toggle(!enabled)}>
            <Power className="h-3.5 w-3.5" /> {enabled ? tp.turnOff : tp.turnOn}
          </Button>
        </div>
      </Group>

      <Group
        title={
          <LabelWithInfo
            info={
              <div className="flex flex-col gap-1.5">
                <p>{tp.sipInfo1}</p>
                <p>{tp.sipInfo2}</p>
              </div>
            }
          >
            {tp.sipTitle}
          </LabelWithInfo>
        }
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-[1fr_96px] gap-3">
            <Field label={tp.server}>
              <Input value={draft.server} onChange={(e) => up({ server: e.target.value })} placeholder={tp.serverPlaceholder} className="font-mono text-xs" />
            </Field>
            <Field label={tp.port}>
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
            <Field label={tp.username} hint={tp.usernameHint}>
              <Input value={draft.username} onChange={(e) => up({ username: e.target.value })} className="font-mono text-xs" />
            </Field>
            <Field label={tp.displayName}>
              <Input value={draft.displayName} onChange={(e) => up({ displayName: e.target.value })} />
            </Field>
          </div>
          {secret(tp.password, c.hasPassword, draft.password, (v) => up({ password: v }), "password")}
          <AdvancedToggle open={advanced} onToggle={() => setAdvanced(!advanced)} />
          {advanced && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={tp.authUsername}>
                <Input value={draft.authUsername ?? ""} onChange={(e) => up({ authUsername: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label={tp.domain}>
                <Input value={draft.domain ?? ""} onChange={(e) => up({ domain: e.target.value })} placeholder={draft.server} className="font-mono text-xs" />
              </Field>
            </div>
          )}
        </div>
      </Group>

      <Group
        title={
          <LabelWithInfo info={tp.audioInfo(live ? "Google (Gemini Live)" : draft.speechProvider === "gemini" ? "Google (Gemini)" : "OpenAI")}>
            {tp.partnerTitle}
          </LabelWithInfo>
        }
      >
        <div className="flex flex-col gap-4 p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label={tp.engine}>
              <Select<PhoneEngine> value={draft.engine} onChange={(v) => up({ engine: v })} options={ENGINES} className="w-full" />
            </Field>
            <Field label={tp.voice}>
              {needsGemini ? (
                <Select value={draft.geminiVoice} onChange={(v) => up({ geminiVoice: v })} options={PHONE_GEMINI_VOICES.map((v) => ({ value: v, label: v }))} className="w-full" />
              ) : (
                <Select value={draft.voice} onChange={(v) => up({ voice: v })} options={PHONE_VOICES.map((v) => ({ value: v, label: v }))} className="w-full" />
              )}
            </Field>
            {!live && (
              <Field label={tp.speechProvider}>
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
          </div>
          {needsGemini &&
            secret(
              tp.geminiKey,
              c.hasGeminiKey,
              draft.geminiKey,
              (v) => up({ geminiKey: v }),
              "geminiKey",
              live ? tp.geminiKeyLive : tp.speechKeyHint,
            )}
          {needsOpenAi &&
            secret(tp.openAiKey, c.hasOpenAiKey, draft.openAiKey, (v) => up({ openAiKey: v }), "openAiKey", tp.speechKeyHint)}
          <AdvancedToggle label={tp.models} open={models} onToggle={() => setModels(!models)} />
          {models && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={tp.liveModel}>
                <Input value={draft.liveModel} onChange={(e) => up({ liveModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <div />
              <Field label={tp.geminiStt}>
                <Input value={draft.geminiSttModel} onChange={(e) => up({ geminiSttModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label={tp.geminiTts}>
                <Input value={draft.geminiTtsModel} onChange={(e) => up({ geminiTtsModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label={tp.openAiStt}>
                <Input value={draft.sttModel} onChange={(e) => up({ sttModel: e.target.value })} className="font-mono text-xs" />
              </Field>
              <Field label={tp.openAiTts}>
                <Input value={draft.ttsModel} onChange={(e) => up({ ttsModel: e.target.value })} className="font-mono text-xs" />
              </Field>
            </div>
          )}
        </div>
      </Group>

      <Group title={tp.callsTitle}>
        <div className="p-4">
          <PhoneNumberList
            label={tp.allowedCallers}
            hint={tp.allowedCallersHint}
            entries={draft.allowedCallers}
            onChange={(allowedCallers) => up({ allowedCallers })}
            addLabel={tp.addNumber}
            empty={tp.allowedCallersEmpty}
          />
        </div>
        <div className="flex flex-col gap-4 p-4">
          <PhoneNumberList
            label={tp.notifyNumbers}
            hint={tp.notifyNumbersHint}
            entries={draft.notifyNumbers}
            onChange={(notifyNumbers) => up({ notifyNumbers })}
            addLabel={tp.addNumber}
            empty={tp.notifyNumbersEmpty}
          />
          <div className="flex flex-col gap-2">
            {(["done", "approval", "error"] as const).map((k) => (
              <ToggleRow key={k} checked={draft.notifyOn[k]} onChange={(v) => up({ notifyOn: { ...draft.notifyOn, [k]: v } })} label={tp.notifyOn[k].label}>
                {tp.notifyOn[k].hint}
              </ToggleRow>
            ))}
          </div>
        </div>
      </Group>

      <Group title={tp.controlTitle}>
        <div className="flex flex-col gap-4 p-4">
          <div className="max-w-sm">
            {secret(tp.pin, c.hasPin, draft.pin, (v) => up({ pin: v.replace(/\D/g, "").slice(0, 8) }), "pin", tp.pinHint, "numeric")}
          </div>
          <ToggleRow checked={draft.requirePin} onChange={(v) => up({ requirePin: v })} label={tp.requirePin}>
            {tp.requirePinHint}
          </ToggleRow>
        </div>
      </Group>

      <DeskSettings draft={draft} config={c} state={state} up={upDesk} secret={secret} />

      <CallLog />
    </div>
  );
}

/** Shows and hides the rarely needed fields of a card. */
function AdvancedToggle({ open, onToggle, label = tp.advanced }: { open: boolean; onToggle: () => void; label?: string }) {
  return (
    <button className="flex items-center gap-1 self-start text-xs text-muted hover:text-fg" onClick={onToggle} aria-expanded={open}>
      <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} /> {label}
    </button>
  );
}

function FieldSkeleton({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Skeleton className="mb-1.5 h-3 w-24" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

/** A settings card while loading: header with its title, then the body. */
function CardSkeleton({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex h-12 items-center border-b border-border px-4">
        <Skeleton className="h-3 rounded-sm" style={{ width: `${title.length * 0.45}rem` }} />
      </div>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </div>
  );
}

/** The phone settings in their resting layout: status, SIP and partner cards. */
function PhoneSettingsSkeleton() {
  return (
    <SkeletonRegion label={tp.loading} className="flex flex-col gap-6">
      <CardSkeleton title={tp.title}>
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-20 rounded" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-7 w-28" />
        </div>
      </CardSkeleton>
      <CardSkeleton title={tp.sipTitle}>
        <div className="grid grid-cols-[1fr_96px] gap-3">
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
        <FieldSkeleton />
      </CardSkeleton>
      <CardSkeleton title={tp.partnerTitle}>
        <div className="grid grid-cols-2 gap-3">
          <FieldSkeleton />
          <FieldSkeleton />
        </div>
        <FieldSkeleton />
      </CardSkeleton>
    </SkeletonRegion>
  );
}

function CallLogSkeleton() {
  return (
    <SkeletonRegion label={tp.loadingCalls}>
      <CardSkeleton title={tp.recentCalls}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex h-5 items-center gap-2.5">
            <Skeleton className="h-3.5 w-3.5 rounded-sm" />
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-2.5 flex-1" />
            <Skeleton className="h-2.5 w-14" />
          </div>
        ))}
      </CardSkeleton>
    </SkeletonRegion>
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
      () => toast.success(tp.desk.copied),
      () => toast.error(tp.desk.notCopied, tp.desk.noClipboard),
    );
  const test = () =>
    void call("phone.deskTest", {})
      .then((s) => {
        qc.setQueryData(keys.phoneState, s);
        toast.success(tp.desk.testSent, tp.desk.testSentDetail);
      })
      .catch((e: unknown) => toast.error(tp.desk.unreachableToast, errorMessage(e)));
  const desk = state?.desk;

  return (
    <Group
      title={
        <span className="flex items-center gap-2">
          <MonitorSmartphone className="h-4 w-4 text-muted" /> {tp.desk.title}
          {desk && (
            <Badge tone={desk.reachable === true ? "success" : desk.reachable === false ? "danger" : "neutral"}>
              {desk.reachable === true ? tp.desk.connected : desk.reachable === false ? tp.desk.unreachable : tp.desk.waiting}
            </Badge>
          )}
        </span>
      }
      action={
        desk && (
          <Button size="sm" onClick={test}>
            {tp.desk.test}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <ToggleRow checked={d.enabled} onChange={(v) => up({ enabled: v })} label={tp.desk.enable}>
          {tp.desk.enableHint}
        </ToggleRow>
        {desk?.message && <p className="text-xs text-danger">{desk.message}</p>}
      </div>
      {d.enabled && (
        <>
          <div className="flex flex-col gap-4 p-4">
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <Field label={tp.desk.ip} hint={tp.desk.ipHint}>
                <Input value={d.phoneIp} onChange={(e) => up({ phoneIp: e.target.value })} placeholder="192.168.0.50" className="font-mono text-xs" />
              </Field>
              <Field label={tp.desk.port}>
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
              <Field label={tp.desk.webUser}>
                <Input value={d.webUser} onChange={(e) => up({ webUser: e.target.value })} className="font-mono text-xs" />
              </Field>
              {secret(tp.desk.webPassword, config.desk.hasWebPassword, d.password, (v) => up({ password: v }), "deskPassword")}
            </div>
            <Field label={tp.desk.provisioning} hint={tp.desk.provisioningHint}>
              <div className="flex gap-2">
                <Input value={url ?? tp.desk.provisioningPending} readOnly className="font-mono text-xs" />
                {url && (
                  <Button variant="ghost" size="icon" aria-label={tp.desk.copyAddress} onClick={() => void copy(url)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </Field>
          </div>
          <div className="flex flex-col gap-4 p-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label={tp.desk.sessionKeys} hint={tp.desk.sessionKeysHint}>
                <Input value={d.sessionKeys} onChange={(e) => up({ sessionKeys: e.target.value })} aria-invalid={parseKeys(d.sessionKeys) === null || undefined} className="font-mono text-xs" />
              </Field>
              <Field label={tp.desk.clearKeys} hint={tp.desk.clearKeysHint}>
                <Input
                  value={d.clearKeys}
                  onChange={(e) => up({ clearKeys: e.target.value })}
                  aria-invalid={parseKeys(d.clearKeys, 30) === null || undefined}
                  placeholder={tp.desk.none}
                  className="font-mono text-xs"
                />
              </Field>
            </div>
            <div className="max-w-sm">
              <Field label={tp.desk.display}>
                <Select<"lines" | "statusline" | "off">
                  value={d.display}
                  onChange={(v) => up({ display: v })}
                  options={[
                    { value: "lines", ...tp.desk.displayLines },
                    { value: "statusline", ...tp.desk.displayStatusline },
                    { value: "off", ...tp.desk.displayOff },
                  ]}
                  className="w-full"
                />
              </Field>
            </div>
            <ToggleRow checked={d.hotline} onChange={(v) => up({ hotline: v })} label={tp.desk.hotline}>
              {tp.desk.hotlineHint(draft.username || tp.desk.notEntered)}
            </ToggleRow>
            <ToggleRow checked={d.leds} onChange={(v) => up({ leds: v })} label={tp.desk.leds}>
              {tp.desk.ledsHint}
            </ToggleRow>
          </div>
        </>
      )}
    </Group>
  );
}

function CallLog() {
  const calls = useQuery({ queryKey: keys.phoneCalls, queryFn: () => call("phone.calls", { limit: 20 }) });
  const [open, setOpen] = useState<string | null>(null);
  if (calls.isPending) return <CallLogSkeleton />;
  if (!calls.data?.length) return null;
  return (
    <Group title={tp.recentCalls}>
      {calls.data.map((c) => (
          <div key={c.id}>
            <button className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-body hover:bg-surface-2" onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              {c.direction === "in" ? <PhoneIncoming className="h-3.5 w-3.5 text-muted" /> : <PhoneOutgoing className="h-3.5 w-3.5 text-muted" />}
              <span className="font-mono text-xs">{c.number || tp.log.unknown}</span>
              <span className={cn("text-xs", c.result === "answered" ? "text-success" : c.result === "missed" ? "text-warning" : "text-danger")}>
                {c.result === "answered" ? tp.log.answered : c.result === "missed" ? tp.log.missed : c.result === "rejected" ? tp.log.rejected : tp.log.failed}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{c.reason ?? c.detail ?? ""}</span>
              <span className="text-caption text-subtle">{relativeTime(c.startedAt)}</span>
            </button>
            {open === c.id && (
              <div className="space-y-1 bg-surface-2 px-4 py-2 text-xs">
                {c.detail && <div className="text-muted">{tp.log.end(c.detail)}</div>}
                {c.transcript.length === 0 && <div className="text-subtle">{tp.log.noTranscript}</div>}
                {c.transcript.map((line, i) => (
                  <div key={i} className="flex gap-2">
                    <span className={cn("w-12 shrink-0", line.role === "caller" ? "text-accent" : "text-muted")}>{line.role === "caller" ? tp.log.you : "FORGE"}</span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
    </Group>
  );
}

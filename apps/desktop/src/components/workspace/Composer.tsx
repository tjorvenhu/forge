import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUp, ListTodo, Square } from "lucide-react";
import type { PermissionMode, Project, Session } from "@forge/protocol";
import { call, keys, useRuntimeInfo, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Kbd, Tooltip } from "@/components/ui/misc";

const PROFILE_MODE: Record<Project["profile"], PermissionMode> = { safe: "default", balanced: "acceptEdits", autonomous: "bypassPermissions" };

export function Composer({
  project,
  session,
  resumeClaudeSessionId,
  prefill,
  onPrefillConsumed,
}: {
  project: Project;
  session: Session | null;
  resumeClaudeSessionId?: string;
  prefill?: string | null;
  onPrefillConsumed?: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [planOnly, setPlanOnly] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const settings = useSettings();
  const runtime = useRuntimeInfo();
  const qc = useQueryClient();
  const setActive = useUi((s) => s.setActiveSession);
  const enterToSend = settings.data?.enterToSend ?? true;

  const working = session?.status === "running" || session?.status === "starting" || session?.status === "stopping";
  const waiting = session?.status === "waiting_approval";
  const effectiveModel = session ? session.model : (model ?? project.defaultModel ?? settings.data?.defaultModel ?? null);
  const isPlan = session ? session.permissionMode === "plan" : planOnly;

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onPrefillConsumed?.();
      ref.current?.focus();
    }
  }, [prefill, onPrefillConsumed]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text]);

  const send = async () => {
    const prompt = text.trim();
    if (!prompt || sending || working || waiting) return;
    setSending(true);
    try {
      if (!session) {
        const s = await call("sessions.start", {
          projectId: project.id,
          prompt,
          model: effectiveModel,
          planOnly,
          resumeClaudeSessionId,
        });
        qc.setQueryData(keys.session(s.id), s);
        void qc.invalidateQueries({ queryKey: keys.sessions(project.id) });
        setActive(project.id, s.id);
      } else {
        const s = await call("sessions.send", { sessionId: session.id, text: prompt });
        qc.setQueryData(keys.session(s.id), s);
      }
      setText("");
    } catch (e) {
      toast.error("Nachricht nicht gesendet", errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    if (!session) return;
    try {
      await call("sessions.stop", { sessionId: session.id });
    } catch (e) {
      toast.error("Stop fehlgeschlagen", errorMessage(e));
    }
  };

  const changeModel = async (v: string) => {
    const next = v === "__default" ? null : v;
    if (!session) return setModel(next);
    if (!next) return;
    try {
      qc.setQueryData(keys.session(session.id), await call("sessions.setModel", { sessionId: session.id, model: next }));
    } catch (e) {
      toast.error("Modell nicht gewechselt", errorMessage(e));
    }
  };

  const togglePlan = async () => {
    if (!session) return setPlanOnly(!planOnly);
    const mode: PermissionMode = isPlan ? PROFILE_MODE[session.profile] : "plan";
    try {
      qc.setQueryData(keys.session(session.id), await call("sessions.setPermissionMode", { sessionId: session.id, mode }));
    } catch (e) {
      toast.error("Modus nicht gewechselt", errorMessage(e));
    }
  };

  const models = runtime.data?.models.filter((m) => m.value !== "default") ?? [];
  const modelOptions = [
    ...(session ? [] : [{ value: "__default", label: "Standardmodell" }]),
    ...models.map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description })),
  ];
  if (effectiveModel && !modelOptions.some((o) => o.value === effectiveModel)) modelOptions.push({ value: effectiveModel, label: effectiveModel, description: "" });

  const placeholder = waiting
    ? "Erst die Freigabeanfrage oben beantworten"
    : working
      ? "Claude arbeitet. Esc stoppt."
      : session && !session.live
        ? "Nachricht schreiben, um die Session fortzusetzen"
        : "Nachricht an Claude";

  return (
    <div className="shrink-0 px-6 pb-4 pt-2">
      <div className={cn("mx-auto max-w-4xl rounded-xl border bg-surface-2 transition-colors", working ? "border-accent/40" : "border-border focus-within:border-accent")}>
        <textarea
          id="composer-input"
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          aria-label="Nachricht an Claude"
          rows={2}
          className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] text-fg placeholder:text-subtle focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Escape" && working) {
              e.preventDefault();
              void stop();
              return;
            }
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const submit = enterToSend ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
            if (submit) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
          <Tooltip content={isPlan ? "Plan-Modus: Claude plant nur und ändert nichts" : "Nur planen (Plan-Modus)"}>
            <Button size="sm" variant={isPlan ? "secondary" : "ghost"} onClick={() => void togglePlan()} aria-pressed={isPlan} className={cn(isPlan && "text-accent")}>
              <ListTodo className="h-3.5 w-3.5" /> Planen
            </Button>
          </Tooltip>
          <div className="flex-1" />
          <span className="hidden text-[11px] text-subtle lg:inline">
            {enterToSend ? (
              <>
                <Kbd>Enter</Kbd> senden · <Kbd>Umschalt+Enter</Kbd> Zeile
              </>
            ) : (
              <>
                <Kbd>Strg+Enter</Kbd> senden
              </>
            )}
          </span>
          <Select
            size="sm"
            value={effectiveModel ?? "__default"}
            onChange={(v) => void changeModel(v)}
            options={modelOptions}
            className="w-40"
            aria-label="Modell"
            disabled={working}
          />
          {working ? (
            <Button size="icon-sm" variant="danger" onClick={() => void stop()} aria-label="Stoppen (Esc)" title="Stoppen (Esc)" disabled={session?.status === "stopping"}>
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          ) : (
            <Button size="icon-sm" variant="primary" onClick={() => void send()} disabled={!text.trim() || waiting} loading={sending} aria-label="Senden">
              {!sending && <ArrowUp className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

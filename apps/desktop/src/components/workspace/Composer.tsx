import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ListTodo, Paperclip, Square } from "lucide-react";
import type { EffortLevel, Project, Session } from "@forge/protocol";
import { useRuntimeInfo, useSettings } from "@/lib/queries";
import { EFFORT_LEVELS, findModel, modelLabel } from "@/lib/models";
import { isWorking } from "@/lib/working";
import { cn } from "@/lib/utils";
import { draftKey, useDrafts } from "@/stores/drafts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Kbd, Tooltip } from "@/components/ui/misc";
import { ContextMeter } from "./ContextMeter";
import { RateLimitBadge } from "./RateLimitBadge";
import { AttachmentList } from "./AttachmentList";
import { CLEAR_COMMANDS, isClearCommand, SlashCommandMenu, useSlashCommands } from "./SlashCommandMenu";
import { useAttachments } from "./useAttachments";
import { compactSession, stopSession, useComposerOptions, useSendMessage } from "./useSendMessage";

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
  const key = draftKey(project.id, session?.id ?? null, resumeClaudeSessionId);
  const text = useDrafts((s) => s.drafts[key]?.text ?? "");
  const setText = useCallback((t: string) => useDrafts.getState().setText(key, t), [key]);
  const attachments = useAttachments(key);
  const { files } = attachments;
  const options = useComposerOptions(project, session, key);
  const { send, sending } = useSendMessage({ project, session, draftKey: key, resumeClaudeSessionId, options });
  const [cmdIndex, setCmdIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const settings = useSettings();
  const runtime = useRuntimeInfo();
  const enterToSend = settings.data?.enterToSend ?? true;

  const working = isWorking(session?.status);
  const waiting = session?.status === "waiting_approval";

  const matches = useSlashCommands(project.id, text);
  useEffect(() => setCmdIndex(0), [text]);
  const pickCommand = (name: string) => {
    setText(`/${name} `);
    ref.current?.focus();
  };

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onPrefillConsumed?.();
      ref.current?.focus();
    }
  }, [prefill, onPrefillConsumed, setText]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
  }, [text]);

  const clearTyped = isClearCommand(text);
  const submit = () => {
    if (!waiting || clearTyped) void send(text, files);
  };
  const stop = () => {
    if (session) void stopSession(session.id);
  };

  const models = runtime.data?.models.filter((m) => m.value !== "default") ?? [];
  const modelOptions = [
    ...(session && options.model ? [] : [{ value: "__default", label: "Standardmodell" }]),
    ...models.map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description })),
  ];
  if (options.model && !modelOptions.some((o) => o.value === options.model)) modelOptions.push({ value: options.model, label: modelLabel(options.model, runtime.data?.models), description: "" });

  const modelInfo = findModel(options.model, runtime.data?.models ?? []);
  const effortLevels = modelInfo?.supportedEffortLevels?.length ? modelInfo.supportedEffortLevels : EFFORT_LEVELS;
  // Unknown models keep the picker; listed ones only when Claude Code reports effort support.
  const showEffort = !modelInfo || modelInfo.supportsEffort === true;

  const placeholder = waiting
    ? "Erst die Anfrage oben beantworten"
    : working
      ? "Claude arbeitet. Weitere Anweisung schreiben, sie wird beim nächsten Schritt übernommen. Esc stoppt."
      : session && !session.live
        ? "Nachricht schreiben, um die Session fortzusetzen"
        : "Nachricht an Claude, / für Befehle, Dateien hineinziehen oder einfügen";

  return (
    <div className="relative shrink-0 px-6 pb-5 pt-2">
      <SlashCommandMenu matches={matches} index={cmdIndex} onPick={pickCommand} />
      <div
        className={cn(
          "relative mx-auto max-w-4xl rounded-2xl border bg-surface shadow-lg shadow-black/20 transition-colors",
          attachments.dragging ? "border-accent bg-accent-soft" : working ? "border-accent/40" : "border-border focus-within:border-accent",
        )}
      >
        {attachments.dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl text-body text-accent">Dateien hier ablegen</div>
        )}
        <AttachmentList files={files} onRemove={attachments.remove} />
        <textarea
          id="composer-input"
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length) {
              e.preventDefault();
              void attachments.addBlobs(pasted);
            }
          }}
          placeholder={placeholder}
          aria-label="Nachricht an Claude"
          rows={2}
          className="block max-h-65 w-full resize-none bg-transparent px-5 pt-4 text-ui text-fg placeholder:text-subtle focus:outline-none focus-visible:outline-none"
          onKeyDown={(e) => {
            if (matches.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setCmdIndex((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const name = matches[cmdIndex]!.name;
                // Like the terminal: Enter on /clear runs it right away, Tab only completes.
                if (e.key === "Enter" && CLEAR_COMMANDS.includes(name)) void send(`/${name}`, []);
                else pickCommand(name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setText("");
                return;
              }
            }
            if (e.key === "Escape" && working) {
              e.preventDefault();
              stop();
              return;
            }
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const isSubmit = enterToSend ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey;
            if (isSubmit) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="flex items-center gap-2 px-4 pb-3.5 pt-2">
          <Tooltip content="Bilder, PDFs oder Textdateien anhängen (auch per Einfügen oder Hineinziehen)">
            <Button size="icon-sm" variant="ghost" onClick={() => void attachments.pick()} aria-label="Dateien anhängen" disabled={attachments.full}>
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content={options.isPlan ? "Plan-Modus: Claude plant nur und ändert nichts" : "Nur planen (Plan-Modus)"}>
            <Button
              size="sm"
              variant={options.isPlan ? "secondary" : "outline"}
              onClick={() => void options.togglePlan()}
              aria-pressed={options.isPlan}
              className={cn("h-8 rounded-lg px-3", options.isPlan && "border-accent/40 text-accent")}
            >
              <ListTodo className="h-3.5 w-3.5" /> Planen
            </Button>
          </Tooltip>
          <div className="flex-1" />
          <RateLimitBadge autoContinueAt={session?.autoContinueAt ?? null} />
          {session?.context && <ContextMeter usage={session.context} onCompact={() => void compactSession(session.id)} disabled={working || waiting || sending} />}
          <span className="hidden whitespace-nowrap text-caption text-subtle 2xl:inline">
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
          {showEffort && (
            <Select
              size="sm"
              value={options.effort ?? "__default"}
              onChange={(v) => void options.changeEffort(v === "__default" ? null : (v as EffortLevel))}
              options={[{ value: "__default", label: "Effort: Standard" }, ...effortLevels.map((l) => ({ value: l, label: `Effort: ${l}` }))]}
              className="w-36"
              aria-label="Effort"
              disabled={working}
            />
          )}
          <Select
            size="sm"
            value={options.model ?? "__default"}
            onChange={(v) => void options.changeModel(v === "__default" ? null : v)}
            options={modelOptions}
            className="w-40"
            aria-label="Modell"
            disabled={working}
          />
          {working && (
            <Button size="icon" variant="danger" className="h-9 w-9 rounded-lg" onClick={stop} aria-label="Stoppen (Esc)" title="Stoppen (Esc)" disabled={session?.status === "stopping"}>
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          )}
          {(!working || text.trim() || files.length > 0) && (
            <Button
              size="icon"
              variant="primary"
              className="h-9 w-9 rounded-lg"
              onClick={submit}
              disabled={(!text.trim() && !files.length) || (waiting && !clearTyped)}
              loading={sending}
              aria-label={working ? "Dazwischen senden" : "Senden"}
              title={working ? "Dazwischen senden: Claude übernimmt die Nachricht beim nächsten Schritt" : undefined}
            >
              {!sending && <ArrowUp className="h-4 w-4" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

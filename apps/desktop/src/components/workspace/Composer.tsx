import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
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
import { InfoCommandDialog, infoCommand, INFO_COMMANDS, type InfoCommand } from "./InfoCommandDialog";
import { useAttachments } from "./useAttachments";
import { DictationButton } from "./DictationButton";
import { useDictation } from "./useDictation";
import { compactSession, stopSession, useComposerOptions, useSendMessage } from "./useSendMessage";

/** Words of the trade the speech service should expect; the project adds its name and stack. */
const DICTATION_TERMS = ["FORGE", "Claude", "Claude Code", "Commit", "Branch", "Pull Request", "Merge", "Deploy", "Worktree", "TypeScript", "JavaScript", "React", "Next.js", "Node", "pnpm", "API", "Endpoint", "Komponente", "Refactoring", "Bug", "Diff", "Session"];

/** Puts dictated text in place of the selection, with a space to its neighbours; `caret` lands after it. */
export function insertSpoken(cur: string, from: number, to: number, spoken: string): { text: string; caret: number } {
  const before = cur.slice(0, from);
  const after = cur.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return { text: before + lead + spoken + trail + after, caret: (before + lead + spoken).length };
}

/** Memoized: the chat re-renders while text streams in, the composer has nothing to do with that. */
export const Composer = memo(function Composer({
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

  /**
   * Like Claude Code, the words appear in the field while they are spoken and get corrected in place.
   * `anchor` is the text around the cursor at the first word; `written` is what the field held after
   * the last update. Once the user types meanwhile, the field is left alone until the end.
   */
  const anchor = useRef<{ before: string; after: string; written: string | null } | null>(null);
  const draftText = useCallback(() => useDrafts.getState().drafts[key]?.text ?? "", [key]);
  const writeSpoken = useCallback(
    (spoken: string, focus: boolean) => {
      const a = anchor.current;
      if (!a) return;
      const { text: next, caret } = insertSpoken(a.before + a.after, a.before.length, a.before.length, spoken);
      a.written = next;
      setText(next);
      requestAnimationFrame(() => {
        if (focus) ref.current?.focus();
        if (document.activeElement === ref.current) ref.current?.setSelectionRange(caret, caret);
      });
    },
    [setText],
  );
  const ownsField = useCallback(() => !!anchor.current && (anchor.current.written === null || anchor.current.written === draftText()), [draftText]);

  /** The finished text replaces the live one; if the user typed meanwhile, it goes where the cursor is. */
  const insertDictation = useCallback(
    (spoken: string) => {
      if (ownsField()) {
        writeSpoken(spoken, true);
        anchor.current = null;
        return;
      }
      anchor.current = null;
      const el = ref.current;
      const cur = draftText();
      const { text: next, caret } = insertSpoken(cur, el ? el.selectionStart : cur.length, el ? el.selectionEnd : cur.length, spoken);
      setText(next);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(caret, caret);
      });
    },
    [draftText, ownsField, setText, writeSpoken],
  );
  // Project words help the recognition with names it would otherwise spell like everyday words.
  const keyterms = useMemo(() => [...DICTATION_TERMS, project.name, ...project.technologies], [project.name, project.technologies]);
  const dictation = useDictation(insertDictation, keyterms);

  useEffect(() => {
    if (dictation.state === "idle") {
      // Ended without a result (discarded or nothing recognized): the live words go again.
      if (anchor.current?.written != null && ownsField()) setText(anchor.current.before + anchor.current.after);
      anchor.current = null;
      return;
    }
    if (!dictation.live) return;
    if (!anchor.current) {
      const el = ref.current;
      const cur = draftText();
      anchor.current = { before: cur.slice(0, el ? el.selectionStart : cur.length), after: cur.slice(el ? el.selectionEnd : cur.length), written: null };
    }
    if (ownsField()) writeSpoken(dictation.live, false);
  }, [dictation.live, dictation.state, draftText, ownsField, setText, writeSpoken]);
  const toggleDictation = () => {
    if (dictation.state === "recording") return void dictation.stop();
    if (dictation.state === "idle") void dictation.start();
  };

  /**
   * Hold space to dictate, like Claude Code: the first press types a space as usual. Only when the key
   * repeats is it a hold; the space is taken back and the recording runs until the key comes up.
   */
  const spaceDown = useRef<{ text: string; start: number; end: number } | null>(null);
  const holding = useRef(false);
  const [held, setHeld] = useState(false);
  const releaseHold = () => {
    if (!holding.current) return;
    holding.current = false;
    setHeld(false);
    void dictation.stop();
  };
  const onSpaceDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e.repeat) {
      spaceDown.current = dictation.state === "idle" ? { text, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd } : null;
      return;
    }
    if (holding.current) return e.preventDefault();
    const before = spaceDown.current;
    if (!before || dictation.state !== "idle") return;
    e.preventDefault();
    setText(before.text);
    requestAnimationFrame(() => ref.current?.setSelectionRange(before.start, before.end));
    holding.current = true;
    setHeld(true);
    void dictation.start();
  };

  const [info, setInfo] = useState<InfoCommand | null>(null);
  const openInfo = (cmd: InfoCommand) => {
    setText("");
    setInfo(cmd);
  };

  const clearTyped = isClearCommand(text);
  const localTyped = clearTyped || !!infoCommand(text);
  /** counts sends; the arrow animation restarts with each */
  const [sentTick, setSentTick] = useState(0);
  const submit = () => {
    const cmd = infoCommand(text);
    if (cmd) return openInfo(cmd);
    if (waiting && !clearTyped) return;
    setSentTick((n) => n + 1);
    void send(text, files);
  };
  const stop = () => {
    if (session) void stopSession(session.id);
  };

  const models = runtime.data?.models.filter((m) => m.value !== "default") ?? [];
  const modelOptions = [
    ...(session && options.model ? [] : [{ value: "__default", label: "Standardmodell" }]),
    ...models.map((m) => ({ value: m.value, label: m.displayName || m.value, description: m.description })),
  ];
  const modelInfo = findModel(options.model, runtime.data?.models ?? []);
  // A running session reports the resolved ID ("claude-opus-5-5"); select the listed entry ("Opus 5.5") instead.
  const modelValue = options.model ? (modelInfo && modelInfo.value !== "default" ? modelInfo.value : options.model) : "__default";
  if (options.model && !modelOptions.some((o) => o.value === modelValue)) modelOptions.push({ value: modelValue, label: modelLabel(modelValue, runtime.data?.models), description: "" });
  const effortLevels = modelInfo?.supportedEffortLevels?.length ? modelInfo.supportedEffortLevels : EFFORT_LEVELS;
  // Unknown models keep the picker; listed ones only when Claude Code reports effort support.
  const showEffort = !modelInfo || modelInfo.supportsEffort === true;

  const placeholder = dictation.state === "recording" || dictation.state === "starting"
    ? held
      ? "Sprich jetzt. Leertaste loslassen fügt den Text ein, Esc verwirft ihn."
      : "Sprich jetzt. Klick auf die Aufnahme fügt den Text ein, Esc verwirft ihn."
    : dictation.state === "transcribing"
      ? "Claude schreibt den Rest mit …"
      : waiting
    ? "Erst die Anfrage oben beantworten"
    : working
      ? "Claude arbeitet. Weitere Anweisung schreiben, sie wird beim nächsten Schritt übernommen. Esc stoppt."
      : session && !session.live
        ? "Nachricht schreiben, um die Session fortzusetzen"
        : "Nachricht an Claude, / für Befehle, Dateien hineinziehen oder einfügen";

  return (
    <div className="relative w-full shrink-0 px-6 pb-5 pt-2">
      <SlashCommandMenu matches={matches} index={cmdIndex} onPick={pickCommand} />
      <InfoCommandDialog command={info} project={project} session={session} onClose={() => setInfo(null)} />
      <div
        className={cn(
          "relative rounded-2xl border bg-surface shadow-lg shadow-black/20 transition-[border-color,background-color,transform] duration-150 ease-snappy",
          attachments.dragging
            ? "scale-[1.01] border-accent bg-accent-soft"
            : dictation.state === "starting" || dictation.state === "recording"
              ? "dictation-ring"
              : working
                ? "border-accent/40"
                : "border-border focus-within:border-accent",
        )}
      >
        {attachments.dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex animate-fade-in items-center justify-center rounded-xl text-body text-accent">Dateien hier ablegen</div>
        )}
        <AttachmentList files={files} onRemove={attachments.remove} />
        {dictation.state !== "idle" && dictation.live && (
          <div className="animate-fade-in border-b border-border px-5 py-2.5 text-ui text-muted" aria-live="polite">
            {dictation.live}
          </div>
        )}
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
          onKeyUp={(e) => {
            if (e.key !== " ") return;
            spaceDown.current = null;
            if (holding.current) {
              e.preventDefault();
              releaseHold();
            }
          }}
          // Focus gone while holding: the key-up never arrives here, so the recording ends now.
          onBlur={releaseHold}
          onKeyDown={(e) => {
            if (e.key === " " && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.nativeEvent.isComposing) return onSpaceDown(e);
            if (e.key === "Escape" && (dictation.state === "recording" || dictation.state === "starting")) {
              e.preventDefault();
              holding.current = false;
              setHeld(false);
              dictation.cancel();
              return;
            }
            if (matches.length) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setCmdIndex((i) => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                const name = matches[cmdIndex]!.name;
                // Like the terminal: Enter on /clear or /usage runs it right away, Tab only completes.
                const info = INFO_COMMANDS.find((c) => c.name === name);
                if (e.key === "Enter" && info) openInfo(info);
                else if (e.key === "Enter" && CLEAR_COMMANDS.includes(name)) void send(`/${name}`, []);
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
          <DictationButton state={dictation.state} seconds={dictation.seconds} onToggle={toggleDictation} />
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
            value={modelValue}
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
              // The message shows in the chat at once ("wird gesendet"), so no spinner here: the arrow flies off.
              disabled={(!text.trim() && !files.length) || (waiting && !localTyped) || sending}
              aria-label={working ? "Dazwischen senden" : "Senden"}
              title={working ? "Dazwischen senden: Claude übernimmt die Nachricht beim nächsten Schritt" : undefined}
            >
              <ArrowUp key={sentTick} className={cn("h-4 w-4", sentTick > 0 && "animate-send")} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

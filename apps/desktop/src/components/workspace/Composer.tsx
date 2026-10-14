import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, ListTodo, Paperclip, SlidersHorizontal, Square } from "lucide-react";
import type { EffortLevel, Project, Session } from "@forge/protocol";
import { useRuntimeInfo, useSettings } from "@/lib/queries";
import { EFFORT_LEVELS, findModel, modelLabel } from "@/lib/models";
import { isWorking } from "@/lib/working";
import { cn } from "@/lib/utils";
import { draftKey, useDrafts } from "@/stores/drafts";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Select } from "@/components/ui/select";
import { Kbd, Tooltip } from "@/components/ui/misc";
import { ContextMeter } from "./ContextMeter";
import { RateLimitBadge } from "./RateLimitBadge";
import { AttachmentList } from "./AttachmentList";
import { CLEAR_COMMANDS, isClearCommand, SlashCommandMenu, useSlashCommands, type Command } from "./SlashCommandMenu";
import { InfoCommandDialog, infoCommand, INFO_COMMANDS, type InfoCommand } from "./InfoCommandDialog";
import { useAttachments } from "./useAttachments";
import { DictationButton } from "./DictationButton";
import { useDictation } from "./useDictation";
import { compactSession, stopSession, useComposerOptions, useSendMessage } from "./useSendMessage";
import { composerInputId, useChatSlot } from "./chat-slot";
import { hasUltrathink, withUltrathink } from "./ultrathink";

/** Words of the trade the speech service should expect; the project adds its name and stack. */
const DICTATION_TERMS = ["FORGE", "Claude", "Claude Code", "Commit", "Branch", "Pull Request", "Merge", "Deploy", "Worktree", "TypeScript", "JavaScript", "React", "Next.js", "Node", "pnpm", "API", "Endpoint", "Komponente", "Refactoring", "Bug", "Diff", "Session"];
/** Space held this long is dictation; a typed space is up again well before, also when typing slowly. */
const HOLD_MS = 380;

/** Puts dictated text in place of the selection, with a space to its neighbours; `caret` lands after it. */
export function insertSpoken(cur: string, from: number, to: number, spoken: string): { text: string; caret: number } {
  const before = cur.slice(0, from);
  const after = cur.slice(to);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const trail = after && !/^\s/.test(after) ? " " : "";
  return { text: before + lead + spoken + trail + after, caret: (before + lead + spoken).length };
}

/**
 * Where `segment`, written at `from` into `written`, stands in `cur` after the user typed before or
 * after it; -1 when the edit touched the segment itself.
 */
export function findLive(written: string, from: number, segment: string, cur: string): number {
  if (cur === written) return from;
  let head = 0;
  while (head < written.length && head < cur.length && written[head] === cur[head]) head++;
  if (head >= from + segment.length) return from;
  let tail = 0;
  while (tail < written.length - head && tail < cur.length - head && written[written.length - 1 - tail] === cur[cur.length - 1 - tail]) tail++;
  if (written.length - tail > from) return -1;
  const at = from + cur.length - written.length;
  return at >= 0 && cur.slice(at, at + segment.length) === segment ? at : -1;
}

interface LiveAnchor {
  /** the text around the cursor at the first word */
  before: string;
  after: string;
  /** what the field held after the last update; null before the first */
  written: string | null;
  /** the live words with the spaces put around them, at `before.length` in `written` */
  segment: string;
  /** where the cursor was put after the last update; null while not set (field not focused, frame pending) */
  caret: number | null;
  /** the cursor left the live words (click, arrow keys): they stay as they are until the end */
  detached: boolean;
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
  const slot = useChatSlot();
  const key = draftKey(project.id, session?.id ?? null, resumeClaudeSessionId, slot.pane);
  const text = useDrafts((s) => s.drafts[key]?.text ?? "");
  const setText = useCallback((t: string) => useDrafts.getState().setText(key, t), [key]);
  const attachments = useAttachments(key);
  const { files } = attachments;
  const options = useComposerOptions(project, session, key);
  const { send, sending } = useSendMessage({ project, session, draftKey: key, resumeClaudeSessionId, options, slot });
  const [cmdIndex, setCmdIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const settings = useSettings();
  const runtime = useRuntimeInfo();
  const enterToSend = settings.data?.enterToSend ?? true;

  const working = isWorking(session?.status);
  const waiting = session?.status === "waiting_approval";

  const matches = useSlashCommands(project.id, text);
  useEffect(() => setCmdIndex(0), [text]);
  /** a user or project command picked from the menu that is named like an info dialog; it goes to Claude */
  const [custom, setCustom] = useState<string | null>(null);
  const customTyped = custom !== null && text.trim().split(/\s/)[0]?.toLowerCase() === `/${custom.toLowerCase()}`;
  useEffect(() => {
    if (custom !== null && !customTyped) setCustom(null);
  }, [custom, customTyped]);
  const pickCommand = (c: Command) => {
    setText(`/${c.name} `);
    setCustom(c.custom ? c.name : null);
    ref.current?.focus();
  };

  useEffect(() => {
    if (prefill) {
      setText(prefill);
      onPrefillConsumed?.();
      ref.current?.focus();
    }
  }, [prefill, onPrefillConsumed, setText]);

  /**
   * A textarea cannot color a single word. With "ultrathink" in the text its own letters turn transparent
   * and a copy behind it, laid out the same way, shows the text with the colored word.
   */
  const mirror = useRef<HTMLDivElement>(null);
  const ultrathink = hasUltrathink(text);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 260) + "px";
    if (mirror.current) mirror.current.scrollTop = el.scrollTop;
  }, [text]);

  /**
   * Like Claude Code, the words appear in the field while they are spoken and get corrected in place.
   * Once the user types or moves the cursor meanwhile, the field is left alone until the end; the
   * finished text then replaces the live words where they stand.
   */
  const anchor = useRef<LiveAnchor | null>(null);
  /** what a hold took back: the field with the typed space, restored when the hold brings no text */
  const holdSpace = useRef<{ text: string; start: number; end: number; without: string } | null>(null);
  const draftText = useCallback(() => useDrafts.getState().drafts[key]?.text ?? "", [key]);
  const writeSpoken = useCallback(
    (spoken: string, focus: boolean) => {
      const a = anchor.current;
      if (!a) return;
      const { text: next, caret } = insertSpoken(a.before + a.after, a.before.length, a.before.length, spoken);
      a.written = next;
      a.segment = next.slice(a.before.length, next.length - a.after.length);
      a.caret = null;
      setText(next);
      requestAnimationFrame(() => {
        if (a.detached) return;
        if (focus) ref.current?.focus();
        if (document.activeElement !== ref.current) return;
        ref.current?.setSelectionRange(caret, caret);
        a.caret = caret;
      });
    },
    [setText],
  );
  const ownsField = useCallback(() => {
    const a = anchor.current;
    if (!a || a.detached) return false;
    if (a.written !== null && a.written !== draftText()) return false;
    const el = ref.current;
    // The cursor is no longer where the last update put it: the user works elsewhere in the text now.
    if (a.caret !== null && el && document.activeElement === el && (el.selectionStart !== a.caret || el.selectionEnd !== a.caret)) a.detached = true;
    return !a.detached;
  }, [draftText]);

  /** The finished text replaces the live words; without any, it goes where the cursor is. */
  const insertDictation = useCallback(
    (spoken: string) => {
      holdSpace.current = null;
      const a = anchor.current;
      if (a && ownsField()) {
        writeSpoken(spoken, true);
        anchor.current = null;
        return;
      }
      anchor.current = null;
      const el = ref.current;
      const cur = draftText();
      const at = a?.written != null ? findLive(a.written, a.before.length, a.segment, cur) : -1;
      const [from, to] = a && at >= 0 ? [at, at + a.segment.length] : el ? [el.selectionStart, el.selectionEnd] : [cur.length, cur.length];
      const { text: next, caret } = insertSpoken(cur, from, to, spoken);
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

  const lastState = useRef(dictation.state);
  useEffect(() => {
    const was = lastState.current;
    lastState.current = dictation.state;
    if (dictation.state === "idle") {
      // Ended without a result (discarded or nothing recognized): the live words go again.
      const a = anchor.current;
      anchor.current = null;
      if (a?.written != null) {
        const cur = draftText();
        const at = findLive(a.written, a.before.length, a.segment, cur);
        if (at >= 0) setText(cur.slice(0, at) + cur.slice(at + a.segment.length));
      }
      // A hold that brought no text gives back the space it took.
      const h = holdSpace.current;
      holdSpace.current = null;
      if (h && was !== "idle" && draftText() === h.without) {
        setText(h.text);
        requestAnimationFrame(() => ref.current?.setSelectionRange(h.start, h.end));
      }
      return;
    }
    if (!dictation.live) return;
    if (!anchor.current) {
      const el = ref.current;
      const cur = draftText();
      anchor.current = { before: cur.slice(0, el ? el.selectionStart : cur.length), after: cur.slice(el ? el.selectionEnd : cur.length), written: null, segment: "", caret: null, detached: false };
    }
    if (ownsField()) writeSpoken(dictation.live, false);
  }, [dictation.live, dictation.state, draftText, ownsField, setText, writeSpoken]);
  const toggleDictation = () => {
    if (dictation.state === "recording") return void dictation.stop();
    if (dictation.state === "idle") void dictation.start();
  };

  /**
   * Hold space to dictate, like Claude Code: the first press types a space as usual. Held for
   * HOLD_MS with no other key in between, it is a hold: the space is taken back and the recording
   * runs until the key comes up. Waiting for the key repeat instead costs half a second or more.
   */
  const spaceDown = useRef<{ text: string; start: number; end: number } | null>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  const holding = useRef(false);
  const [held, setHeld] = useState(false);
  const cancelHoldTimer = () => {
    window.clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  };
  const releaseHold = () => {
    cancelHoldTimer();
    spaceDown.current = null;
    if (!holding.current) return;
    holding.current = false;
    setHeld(false);
    void dictation.stop();
  };
  const beginHold = () => {
    cancelHoldTimer();
    const before = spaceDown.current;
    if (!before || holding.current) return;
    const el = ref.current;
    const typed = draftText();
    holdSpace.current = { text: typed, start: el?.selectionStart ?? typed.length, end: el?.selectionEnd ?? typed.length, without: before.text };
    setText(before.text);
    requestAnimationFrame(() => ref.current?.setSelectionRange(before.start, before.end));
    holding.current = true;
    setHeld(true);
    void dictation.start();
  };
  const onSpaceDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e.repeat) {
      cancelHoldTimer();
      spaceDown.current = dictation.state === "idle" ? { text, start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd } : null;
      if (spaceDown.current) {
        dictation.prewarm();
        holdTimer.current = window.setTimeout(beginHold, HOLD_MS);
      }
      return;
    }
    if (holding.current) return e.preventDefault();
    if (!spaceDown.current || dictation.state !== "idle") return;
    e.preventDefault();
    beginHold();
  };
  useEffect(() => () => window.clearTimeout(holdTimer.current), []);

  const [info, setInfo] = useState<InfoCommand | null>(null);
  const openInfo = (cmd: InfoCommand) => {
    setText("");
    setInfo(cmd);
  };

  const clearTyped = isClearCommand(text);
  const typedInfo = infoCommand(text, customTyped ? custom : null);
  const localTyped = clearTyped || !!typedInfo;
  // The field still holds live words or waits for the finished text; sent now, the rest would land in an empty draft.
  const dictating = dictation.state !== "idle";
  /** counts sends; the arrow animation restarts with each */
  const [sentTick, setSentTick] = useState(0);
  const submit = () => {
    if (dictating) return;
    if (typedInfo) return openInfo(typedInfo);
    if (waiting && !clearTyped) return;
    setSentTick((n) => n + 1);
    void attachments.settled().then((ready) => send(text, ready));
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
    // A container of its own: the bottom row drops what is not needed by the composer's width (split view, side panel), not the window's.
    <div className="@container/composer relative w-full shrink-0 px-6 pb-5 pt-2">
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
        <AttachmentList files={files} preparing={attachments.preparing} onRemove={attachments.remove} />
        {dictation.state !== "idle" && dictation.live && (
          <div className="animate-fade-in border-b border-border px-5 py-2.5 text-ui text-muted" aria-live="polite">
            {dictation.live}
          </div>
        )}
        <div className="relative">
        {ultrathink && (
          <div ref={mirror} aria-hidden className="pointer-events-none absolute inset-0 overflow-y-auto whitespace-pre-wrap break-words px-5 pt-4 text-ui text-fg">
            {withUltrathink(text)}
            {"​"}
          </div>
        )}
        <textarea
          id={composerInputId(slot)}
          data-composer
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onScroll={(e) => {
            if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
          }}
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
          // Not through cn: tailwind-merge takes text-ui for a color and drops it next to text-fg, the text would
          // shrink to 13px and no longer line up with the copy behind it.
          className={`relative block max-h-65 w-full resize-none bg-transparent px-5 pt-4 text-ui placeholder:text-subtle focus:outline-none focus-visible:outline-none ${ultrathink ? "text-transparent caret-fg" : "text-fg"}`}
          onKeyUp={(e) => {
            if (e.key !== " ") return;
            if (holding.current) e.preventDefault();
            releaseHold();
          }}
          onFocus={dictation.prewarm}
          // Focus gone while holding: the key-up never arrives here, so the recording ends now.
          onBlur={releaseHold}
          onKeyDown={(e) => {
            if (e.key === " " && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !e.nativeEvent.isComposing) return onSpaceDown(e);
            // Another key while space is down: fast typing, not a hold.
            if (!holding.current && spaceDown.current) {
              cancelHoldTimer();
              spaceDown.current = null;
            }
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
                const picked = matches[cmdIndex]!;
                // Like the terminal: Enter on /clear or /usage runs it right away, Tab only completes.
                const info = !picked.custom && INFO_COMMANDS.find((c) => c.name === picked.name);
                if (e.key === "Enter" && info) openInfo(info);
                else if (e.key === "Enter" && CLEAR_COMMANDS.includes(picked.name) && !dictating) void send(`/${picked.name}`, []);
                else pickCommand(picked);
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
        </div>
        <div className="flex items-center gap-2 px-4 pb-3.5 pt-2">
          <Tooltip content="Bilder, PDFs oder Textdateien anhängen (auch per Einfügen oder Hineinziehen)">
            <Button size="icon-sm" variant="ghost" onClick={() => void attachments.pick()} aria-label="Dateien anhängen" disabled={attachments.full}>
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          </Tooltip>
          <DictationButton state={dictation.state} seconds={dictation.seconds} onToggle={toggleDictation} onPrepare={dictation.prewarm} />
          <Tooltip content={options.isPlan ? "Plan-Modus: Claude plant nur und ändert nichts" : "Nur planen (Plan-Modus)"}>
            <Button
              size="sm"
              variant={options.isPlan ? "secondary" : "outline"}
              onClick={() => void options.togglePlan()}
              aria-pressed={options.isPlan}
              aria-label="Planen"
              className={cn("h-8 shrink-0 rounded-lg px-2.5 @2xl/composer:px-3", options.isPlan && "border-accent/40 text-accent")}
            >
              <ListTodo className="h-3.5 w-3.5" />
              <span className="hidden @2xl/composer:inline">Planen</span>
            </Button>
          </Tooltip>
          <div className="min-w-0 flex-1" />
          <RateLimitBadge autoContinueAt={session?.autoContinueAt ?? null} />
          {session?.context && <ContextMeter usage={session.context} onCompact={() => void compactSession(session.id)} disabled={working || waiting || sending} />}
          <span className="hidden shrink-0 whitespace-nowrap text-caption text-subtle @5xl/composer:inline">
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
              className="hidden w-36 shrink-0 @4xl/composer:inline-flex"
              aria-label="Effort"
              disabled={working}
            />
          )}
          <Select
            size="sm"
            value={modelValue}
            onChange={(v) => void options.changeModel(v === "__default" ? null : v)}
            options={modelOptions}
            className="hidden w-40 shrink-0 @xl/composer:inline-flex"
            aria-label="Modell"
            disabled={working}
          />
          {/* Narrow: Effort (and below that the model) move into one menu instead of squeezing the row. */}
          <div className="shrink-0 @4xl/composer:hidden">
            <DropdownMenu
              header="Modell und Effort"
              trigger={
                <Button size="icon-sm" variant="ghost" aria-label="Modell und Effort" title="Modell und Effort" disabled={working}>
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </Button>
              }
              items={[
                ...modelOptions.map((o) => ({
                  label: o.label,
                  hint: o.value === modelValue ? "aktiv" : undefined,
                  onSelect: () => void options.changeModel(o.value === "__default" ? null : o.value),
                })),
                ...(showEffort
                  ? [{ value: "__default", label: "Effort: Standard" }, ...effortLevels.map((l) => ({ value: l, label: `Effort: ${l}` }))].map((o) => ({
                      label: o.label,
                      hint: o.value === (options.effort ?? "__default") ? "aktiv" : undefined,
                      onSelect: () => void options.changeEffort(o.value === "__default" ? null : (o.value as EffortLevel)),
                    }))
                  : []),
              ]}
            />
          </div>
          {working && (
            <Button size="icon" variant="danger" className="h-9 w-9 shrink-0 rounded-lg" onClick={stop} aria-label="Stoppen (Esc)" title="Stoppen (Esc)" disabled={session?.status === "stopping"}>
              <Square className="h-3.5 w-3.5 fill-current" />
            </Button>
          )}
          {(!working || text.trim() || files.length > 0) && (
            <Button
              size="icon"
              variant="primary"
              className="h-9 w-9 shrink-0 rounded-lg"
              onClick={submit}
              // The message shows in the chat at once ("wird gesendet"), so no spinner here: the arrow flies off.
              disabled={(!text.trim() && !files.length) || (waiting && !localTyped) || sending || dictating}
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

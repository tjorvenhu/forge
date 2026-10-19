import type { ReactNode } from "react";
import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd, Spinner, Tooltip } from "@/components/ui/misc";
import type { DictationState } from "./useDictation";
import { t } from "@/i18n";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Microphone in the composer: starts dictation, shows the running time while recording, stops it. */
export function DictationButton({ state, seconds, onToggle, onPrepare }: { state: DictationState; seconds: number; onToggle: () => void; onPrepare?: () => void }) {
  if (state === "recording")
    return (
      <Tooltip content={t.chat.dictation.stopTooltip}>
        <Button size="sm" variant="outline" onClick={onToggle} aria-label={t.chat.dictation.stop} className="h-8 gap-1.5 rounded-lg border-danger/40 px-2.5 text-danger">
          <span className="h-2 w-2 animate-soft-pulse rounded-full bg-danger" aria-hidden />
          <span className="tabular-nums">{clock(seconds)}</span>
        </Button>
      </Tooltip>
    );
  if (state === "transcribing")
    return (
      <Button size="sm" variant="ghost" disabled aria-label={t.chat.dictation.recognizing} className="h-8 gap-1.5 rounded-lg px-2.5">
        <Spinner className="h-3.5 w-3.5" /> {t.chat.dictation.recognizingShort}
      </Button>
    );
  return (
    <Tooltip content={t.chat.dictation.tooltip}>
      <Button size="icon-sm" variant="ghost" onClick={onToggle} onPointerEnter={onPrepare} aria-label={t.chat.dictation.dictate} loading={state === "starting"}>
        <Mic className="h-3.5 w-3.5" />
      </Button>
    </Tooltip>
  );
}

/**
 * Above the composer while dictation is switched on (Ctrl+Space or a click on the microphone): says that it
 * keeps running and how it ends. Each key is also a button.
 */
export function DictationToggleBar({ state, seconds, sending, onSend, onStop, onDiscard }: { state: DictationState; seconds: number; sending: boolean; onSend: () => void; onStop: () => void; onDiscard: () => void }) {
  const d = t.chat.dictation;
  if (sending || state === "transcribing")
    return (
      <div role="status" className="mb-2 flex animate-fade-in items-center gap-2 rounded-xl border border-border bg-surface px-3.5 py-2 text-small text-muted">
        <Spinner className="h-3.5 w-3.5" /> {sending ? d.sendingAfter : d.recognizing}
      </div>
    );
  if (state !== "recording" && state !== "starting") return null;
  const key = (label: string, keys: ReactNode, title: string, onClick: () => void) => (
    <button type="button" title={title} onClick={onClick} className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-surface-3 hover:text-fg">
      {keys}
      <span>{label}</span>
    </button>
  );
  return (
    <div role="status" aria-live="polite" className="mb-2 flex animate-fade-in flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2 text-small">
      <span className="flex items-center gap-2 font-medium text-fg">
        <span className="h-2 w-2 animate-soft-pulse rounded-full bg-danger" aria-hidden />
        {d.toggleOn}
        <span className="font-normal tabular-nums text-muted">{clock(seconds)}</span>
      </span>
      <span className="text-muted">{d.toggleOnDetail}</span>
      <span className="ml-auto flex flex-wrap items-center gap-1 text-muted">
        {key(d.toggleSend, <Kbd>Enter</Kbd>, d.toggleSendTitle, onSend)}
        {key(d.toggleStop, <Kbd>{t.layout.actions.ctrl(d.spaceKey)}</Kbd>, d.toggleStopTitle, onStop)}
        {key(d.toggleDiscard, <Kbd>Esc</Kbd>, d.toggleDiscardTitle, onDiscard)}
      </span>
    </div>
  );
}

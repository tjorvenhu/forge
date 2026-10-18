import { Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner, Tooltip } from "@/components/ui/misc";
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

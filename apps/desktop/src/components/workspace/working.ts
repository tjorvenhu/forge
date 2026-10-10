import type { SessionEvent } from "@forge/protocol";

/** Shown while Claude works, in the spirit of the spinner words in the Claude Code shell. */
export const WORKING_PHRASES = [
  "Schmiedet",
  "Hämmert",
  "Feilt",
  "Glüht vor",
  "Schleift",
  "Härtet",
  "Tüftelt",
  "Grübelt",
  "Werkelt",
  "Knobelt",
  "Sinniert",
  "Brütet",
  "Puzzelt",
  "Bastelt",
  "Jongliert",
  "Kombiniert",
  "Wälzt Gedanken",
  "Dreht an Schrauben",
  "Zerbricht sich den Kopf",
  "Sortiert Ideen",
];

/** A new phrase every this many ms, so long turns do not look frozen. */
export const PHRASE_INTERVAL_MS = 15_000;

/**
 * Start of the running turn: the first user message after the last result. A message sent while
 * Claude works joins the running turn and must not reset the clock.
 */
export function turnStartedAt(events: readonly SessionEvent[]): string | null {
  let lastResult = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.body.type === "turn.result") {
      lastResult = i;
      break;
    }
  }
  const rest = events.slice(lastResult + 1);
  return (rest.find((e) => e.body.type === "user.message") ?? rest[0])?.ts ?? null;
}

export function pickPhrase(startedAt: string, elapsedMs: number): string {
  let seed = 0;
  for (const ch of startedAt) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const step = Math.floor(Math.max(0, elapsedMs) / PHRASE_INTERVAL_MS);
  return WORKING_PHRASES[(seed + step) % WORKING_PHRASES.length]!;
}

/** "8 s", "1 min 05 s", "1 h 02 min" */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

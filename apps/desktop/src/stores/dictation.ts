import { useEffect, useState } from "react";
import { create } from "zustand";

interface DictationActivity {
  /** composers recording or transcribing right now */
  active: number;
  /** Marks one dictation as running; call the returned function when it is done. */
  hold: () => () => void;
}

/**
 * Whether any dictation runs. Dialogs that open on their own (update offer) wait for it: they take the
 * focus, the composer loses the held space and the recording ends mid-sentence.
 */
export const useDictationActivity = create<DictationActivity>((set) => ({
  active: 0,
  hold: () => {
    set((s) => ({ active: s.active + 1 }));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      set((s) => ({ active: Math.max(0, s.active - 1) }));
    };
  },
}));

/**
 * True while no dictation runs and the last one ended at least `ms` ago, so a dialog does not jump up
 * the moment the text lands while the user is about to go on.
 */
export function useDictationQuiet(ms = 2000): boolean {
  const active = useDictationActivity((d) => d.active > 0);
  const [quiet, setQuiet] = useState(!active);
  useEffect(() => {
    if (active) {
      setQuiet(false);
      return;
    }
    const t = window.setTimeout(() => setQuiet(true), ms);
    return () => window.clearTimeout(t);
  }, [active, ms]);
  return quiet && !active;
}

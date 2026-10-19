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

/** Sent to a composer's input to switch dictation on or off, as Ctrl+Space there does. */
export const DICTATION_TOGGLE_EVENT = "forge:dictation-toggle";

/**
 * Switches dictation in the focused composer (else the main one) once no dialog is open: the command
 * palette gives the focus back while it closes.
 */
export function toggleDictationSoon(deadline = performance.now() + 1500) {
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
    if (performance.now() < deadline) requestAnimationFrame(() => toggleDictationSoon(deadline));
    return;
  }
  setTimeout(() => {
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.matches("[data-composer]") ? document.activeElement : null;
    const el = focused ?? document.getElementById("composer-input");
    if (!el) return;
    el.focus();
    el.dispatchEvent(new CustomEvent(DICTATION_TOGGLE_EVENT));
  }, 30);
}

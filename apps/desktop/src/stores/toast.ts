import { create } from "zustand";
import { t } from "@/i18n";

export interface Toast {
  id: number;
  tone: "success" | "error" | "info" | "warning";
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  /** ms until it closes by itself; defaults depend on the tone */
  duration?: number;
  /** playing its exit animation; removed right after */
  leaving?: boolean;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id" | "leaving">) => number;
  /** starts the auto-close time of an open toast again */
  extend: (id: number, ms: number) => void;
  /** closes with the exit animation */
  dismiss: (id: number) => void;
  /** the pointer is over the toast: it stays until the pointer leaves */
  pause: (id: number) => void;
  resume: (id: number) => void;
}

/** length of the exit animation (animate-toast-out) */
export const TOAST_EXIT_MS = 150;

let nextId = 1;
/** auto-close timers; `remaining` is what is left after a pause */
const timers = new Map<number, { timer: ReturnType<typeof setTimeout> | null; remaining: number; started: number }>();

export const useToasts = create<ToastState>((set, get) => {
  const arm = (id: number, ms: number) => {
    timers.set(id, { timer: setTimeout(() => get().dismiss(id), ms), remaining: ms, started: Date.now() });
  };
  const remove = (id: number) => {
    timers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  };
  return {
    toasts: [],
    push: (t) => {
      const id = nextId++;
      const kept = get().toasts.slice(-3);
      for (const old of get().toasts) if (!kept.includes(old)) timers.delete(old.id);
      set({ toasts: [...kept, { ...t, id }] });
      arm(id, t.duration ?? (t.tone === "error" ? 8000 : 4000));
      return id;
    },
    extend: (id, ms) => {
      const timer = timers.get(id)?.timer;
      if (timer) clearTimeout(timer);
      if (get().toasts.some((t) => t.id === id && !t.leaving)) arm(id, ms);
    },
    dismiss: (id) => {
      const t = get().toasts.find((x) => x.id === id);
      const timer = timers.get(id)?.timer;
      if (timer) clearTimeout(timer);
      if (!t || t.leaving) return;
      set({ toasts: get().toasts.map((x) => (x.id === id ? { ...x, leaving: true } : x)) });
      setTimeout(() => remove(id), TOAST_EXIT_MS);
    },
    pause: (id) => {
      const s = timers.get(id);
      if (!s?.timer) return;
      clearTimeout(s.timer);
      timers.set(id, { timer: null, remaining: Math.max(0, s.remaining - (Date.now() - s.started)), started: Date.now() });
    },
    resume: (id) => {
      const s = timers.get(id);
      if (!s || s.timer) return;
      // A moment to read the rest after the pointer leaves.
      arm(id, Math.max(s.remaining, 1500));
    },
  };
});

/** the open "saved" toast; further saves keep it up instead of stacking new ones */
let savedId: number | null = null;
const SAVED_MS = 2000;

export const toast = {
  /** Settings save on every change; this confirms it quietly, once for a burst of changes. */
  saved: () => {
    const s = useToasts.getState();
    if (savedId !== null && s.toasts.some((t) => t.id === savedId && !t.leaving)) s.extend(savedId, SAVED_MS);
    else savedId = s.push({ tone: "success", title: t.stores.autoSaved, duration: SAVED_MS });
  },
  success: (title: string, body?: string) => useToasts.getState().push({ tone: "success", title, body }),
  error: (title: string, body?: string) => useToasts.getState().push({ tone: "error", title, body }),
  info: (title: string, body?: string) => useToasts.getState().push({ tone: "info", title, body }),
  notify: (t: Omit<Toast, "id" | "leaving">) => useToasts.getState().push(t),
};

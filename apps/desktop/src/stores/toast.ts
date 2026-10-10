import { create } from "zustand";

export interface Toast {
  id: number;
  tone: "success" | "error" | "info" | "warning";
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  /** ms until it closes by itself; defaults depend on the tone */
  duration?: number;
}

interface ToastState {
  toasts: Toast[];
  push: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismiss(id), t.duration ?? (t.tone === "error" ? 8000 : 4000));
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  success: (title: string, body?: string) => useToasts.getState().push({ tone: "success", title, body }),
  error: (title: string, body?: string) => useToasts.getState().push({ tone: "error", title, body }),
  info: (title: string, body?: string) => useToasts.getState().push({ tone: "info", title, body }),
  notify: (t: Omit<Toast, "id">) => useToasts.getState().push(t),
};

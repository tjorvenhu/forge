import { create } from "zustand";

/** Work started from the UI that runs a while (push, pull …), shown on the start page while it runs. */
export interface RunningOp {
  id: number;
  projectId: string;
  label: string;
  startedAt: string;
}

interface ActivityState {
  ops: RunningOp[];
  /** Runs `fn` and lists it as running until it settles; returns its result. */
  track: <T>(projectId: string, label: string, fn: () => Promise<T>) => Promise<T>;
}

let next = 1;

export const useActivity = create<ActivityState>((set) => ({
  ops: [],
  track: async (projectId, label, fn) => {
    const op = { id: next++, projectId, label, startedAt: new Date().toISOString() };
    set((s) => ({ ops: [...s.ops, op] }));
    try {
      return await fn();
    } finally {
      set((s) => ({ ops: s.ops.filter((o) => o.id !== op.id) }));
    }
  },
}));

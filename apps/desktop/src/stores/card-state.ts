import { useRef, type SetStateAction } from "react";
import { create } from "zustand";

/** Keys are kept in insertion order; beyond this the oldest go first. Only small UI values live here. */
const MAX_ENTRIES = 500;

interface CardStateStore {
  values: Map<string, unknown>;
  set: (key: string, value: unknown) => void;
  /** drops all values of one session, e.g. when its buffer is evicted or it is deleted */
  dropSession: (sessionId: string) => void;
}

/**
 * Local state of chat cards (typed answers, expanded state, deny reason). The chat list is virtualized,
 * so rows unmount while scrolled out of view; plain useState would lose what the user entered.
 */
export const useCardStore = create<CardStateStore>((set) => ({
  values: new Map(),
  set: (key, value) =>
    set((s) => {
      const values = new Map(s.values);
      values.delete(key);
      values.set(key, value);
      while (values.size > MAX_ENTRIES) values.delete(values.keys().next().value!);
      return { values };
    }),
  dropSession: (sessionId) =>
    set((s) => {
      const prefix = `${sessionId}|`;
      if (![...s.values.keys()].some((k) => k.startsWith(prefix))) return s;
      return { values: new Map([...s.values].filter(([k]) => !k.startsWith(prefix))) };
    }),
}));

export function cardKey(sessionId: string, id: string, field: string): string {
  return `${sessionId}|${id}|${field}`;
}

/** Like useState, but survives unmounting. `initial` applies until the first update. */
export function useCardState<T>(key: string, initial: T | (() => T)): [T, (next: SetStateAction<T>) => void] {
  const stored = useCardStore((s) => s.values.get(key)) as T | undefined;
  const fallback = useRef<{ key: string; value: T } | null>(null);
  if (stored === undefined && fallback.current?.key !== key) {
    fallback.current = { key, value: typeof initial === "function" ? (initial as () => T)() : initial };
  }
  const value = stored !== undefined ? stored : fallback.current!.value;
  const update = (next: SetStateAction<T>) => {
    const raw = useCardStore.getState().values.get(key);
    const cur = raw !== undefined ? (raw as T) : value;
    useCardStore.getState().set(key, typeof next === "function" ? (next as (c: T) => T)(cur) : next);
  };
  return [value, update];
}

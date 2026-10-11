import { create } from "zustand";
import type { BottomTab } from "./ui";

export type TerminalProgram = "shell" | "claude";

export interface TerminalTab {
  key: string;
  label: string;
  program: TerminalProgram;
  /** folder the process was started in; fixed for the lifetime of the tab */
  cwd: string;
  /** claude binary resolved when the tab was opened; only used for program "claude" */
  claudePath: string | null;
}

interface TerminalsState {
  /** open terminal tabs per project */
  tabs: Record<string, TerminalTab[]>;
  /** shown tab of the bottom panel per project: a terminal key or one of the fixed tabs */
  active: Record<string, string>;
  add: (projectId: string, tab: Omit<TerminalTab, "key" | "label"> & { label?: string }) => string;
  remove: (projectId: string, key: string) => void;
  setActive: (projectId: string, tab: string) => void;
}

export const DEFAULT_BOTTOM_TAB: BottomTab = "output";
export const NO_TABS: TerminalTab[] = [];

/**
 * Terminal tabs outlive the workspace view: switching projects or views must not end their processes.
 * The xterm instances and PTYs behind the keys live in lib/terminal-registry.
 */
export const useTerminals = create<TerminalsState>((set) => ({
  tabs: {},
  active: {},
  add: (projectId, { label, ...tab }) => {
    const key = crypto.randomUUID();
    set((s) => {
      const cur = s.tabs[projectId] ?? [];
      const name = label ?? (tab.program === "claude" ? "Claude" : `Terminal ${cur.filter((t) => t.program === "shell").length + 1}`);
      return { tabs: { ...s.tabs, [projectId]: [...cur, { ...tab, key, label: name }] }, active: { ...s.active, [projectId]: key } };
    });
    return key;
  },
  remove: (projectId, key) =>
    set((s) => ({
      tabs: { ...s.tabs, [projectId]: (s.tabs[projectId] ?? []).filter((t) => t.key !== key) },
      active: s.active[projectId] === key ? { ...s.active, [projectId]: DEFAULT_BOTTOM_TAB } : s.active,
    })),
  setActive: (projectId, tab) => set((s) => ({ active: { ...s.active, [projectId]: tab } })),
}));

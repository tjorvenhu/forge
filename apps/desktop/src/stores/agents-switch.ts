import { create } from "zustand";

interface AgentsSwitch {
  /** the main project whose parallel agents are about to be switched off; waits for the confirmation */
  confirm: { id: string; name: string } | null;
  requestOff: (p: { id: string; name: string }) => void;
  close: () => void;
}

/** Confirmation of components/projects/AgentsSwitch.tsx; settings, palette and the project menu ask for it. */
export const useAgentsSwitch = create<AgentsSwitch>((set) => ({
  confirm: null,
  requestOff: (p) => set({ confirm: { id: p.id, name: p.name } }),
  close: () => set({ confirm: null }),
}));

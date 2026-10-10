import { create } from "zustand";

/** Same cap as the sidecar keeps per project. */
const MAX_CHARS = 200_000;

interface DevOutputState {
  /** output per project; undefined until loaded from the sidecar */
  text: Record<string, string | undefined>;
  set: (projectId: string, text: string) => void;
  append: (projectId: string, text: string) => void;
}

/** Dev server output per project, filled by the initial load and the devserver.output events. */
export const useDevOutput = create<DevOutputState>((set) => ({
  text: {},
  set: (projectId, text) => set((s) => ({ text: { ...s.text, [projectId]: text.slice(-MAX_CHARS) } })),
  append: (projectId, chunk) =>
    set((s) => {
      const cur = s.text[projectId];
      // Not loaded yet: the initial load returns the full log including this chunk.
      if (cur === undefined) return s;
      return { text: { ...s.text, [projectId]: (cur + chunk).slice(-MAX_CHARS) } };
    }),
}));

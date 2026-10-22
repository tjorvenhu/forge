import { create } from "zustand";

interface SessionUsageDialog {
  shown: boolean;
  /** stays after closing, so the dialog keeps its content while it fades out */
  sessionId: string | null;
  title: string | null;
  open: (sessionId: string, title: string | null) => void;
  close: () => void;
}

/** The dialog of components/usage/SessionUsage.tsx; opened from the composer, the palette and menus. */
export const useSessionUsageDialog = create<SessionUsageDialog>((set) => ({
  shown: false,
  sessionId: null,
  title: null,
  open: (sessionId, title) => set({ shown: true, sessionId, title }),
  close: () => set({ shown: false }),
}));

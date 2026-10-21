import { create } from "zustand";

interface GitRemoteDialog {
  /** the project whose origin is shown and edited */
  project: { id: string; name: string } | null;
  open: (p: { id: string; name: string }) => void;
  close: () => void;
}

/** Dialog of components/git/RemoteDialog.tsx; the Git tab, project settings, the project menu and the palette open it. */
export const useGitRemoteDialog = create<GitRemoteDialog>((set) => ({
  project: null,
  open: (p) => set({ project: { id: p.id, name: p.name } }),
  close: () => set({ project: null }),
}));

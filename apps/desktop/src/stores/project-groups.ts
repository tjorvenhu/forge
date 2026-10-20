import { create } from "zustand";

interface ProjectGroupDialogs {
  /** the project whose group is being set */
  assign: { projectId: string; name: string; group: string | null } | null;
  /** name of the group being renamed or dissolved */
  rename: string | null;
  dissolve: string | null;
  openAssign: (p: { id: string; name: string; group: string | null }) => void;
  openRename: (group: string) => void;
  openDissolve: (group: string) => void;
  close: () => void;
}

/** Dialogs of components/projects/ProjectGroupDialogs.tsx; cards, menus, settings and the palette open them. */
export const useProjectGroupDialogs = create<ProjectGroupDialogs>((set) => ({
  assign: null,
  rename: null,
  dissolve: null,
  openAssign: (p) => set({ assign: { projectId: p.id, name: p.name, group: p.group }, rename: null, dissolve: null }),
  openRename: (rename) => set({ rename, assign: null, dissolve: null }),
  openDissolve: (dissolve) => set({ dissolve, assign: null, rename: null }),
  close: () => set({ assign: null, rename: null, dissolve: null }),
}));

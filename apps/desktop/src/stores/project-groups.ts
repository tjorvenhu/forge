import { create } from "zustand";
import { groupKey } from "@/lib/project-tree";

interface ProjectGroupDialogs {
  /** the project whose group is being set */
  assign: { projectId: string; name: string; group: string | null } | null;
  /** name of the group being renamed or dissolved */
  rename: string | null;
  dissolve: string | null;
  /** "Gruppe erstellen" (group: null) or adding projects to a group */
  create: { group: string | null } | null;
  /**
   * Groups made without a project yet, shown as empty sections to drag projects into. A group lives
   * in its projects (the sidecar stores no groups of their own), so these stay on this screen and
   * go once a project is in them.
   */
  emptyGroups: string[];
  openAssign: (p: { id: string; name: string; group: string | null }) => void;
  openRename: (group: string) => void;
  openDissolve: (group: string) => void;
  openCreate: (group?: string | null) => void;
  addEmptyGroup: (group: string) => void;
  removeEmptyGroup: (group: string) => void;
  close: () => void;
}

const closed = { assign: null, rename: null, dissolve: null, create: null };

/** Dialogs of components/projects/ProjectGroupDialogs.tsx; cards, menus, settings and the palette open them. */
export const useProjectGroupDialogs = create<ProjectGroupDialogs>((set) => ({
  ...closed,
  emptyGroups: [],
  openAssign: (p) => set({ ...closed, assign: { projectId: p.id, name: p.name, group: p.group } }),
  openRename: (rename) => set({ ...closed, rename }),
  openDissolve: (dissolve) => set({ ...closed, dissolve }),
  openCreate: (group = null) => set({ ...closed, create: { group } }),
  addEmptyGroup: (group) => set((s) => (s.emptyGroups.some((g) => groupKey(g) === groupKey(group)) ? s : { emptyGroups: [...s.emptyGroups, group] })),
  removeEmptyGroup: (group) => set((s) => ({ emptyGroups: s.emptyGroups.filter((g) => groupKey(g) !== groupKey(group)) })),
  close: () => set(closed),
}));

import { create } from "zustand";

/** A template to apply from outside the composer (palette, right click on a file or project). */
export interface TemplateApplyRequest {
  /** null: the dialog asks for the project */
  projectId: string | null;
  /** null: the dialog lets the user pick one */
  templateId: string | null;
  /** values the caller knows, e.g. the file that was right-clicked */
  values: Record<string, string>;
}

/** The editor for a new template (text from a chat message) or an existing one. */
export interface TemplateEditRequest {
  id: string | null;
  text?: string;
  projectId?: string | null;
}

interface TemplateDialogs {
  apply: TemplateApplyRequest | null;
  edit: TemplateEditRequest | null;
  openApply: (r: Partial<TemplateApplyRequest>) => void;
  openEdit: (r: TemplateEditRequest) => void;
  closeApply: () => void;
  closeEdit: () => void;
}

/** Dialogs of the template host (components/templates/TemplateHost.tsx); they outlive the palette and menus that open them. */
export const useTemplateDialogs = create<TemplateDialogs>((set) => ({
  apply: null,
  edit: null,
  openApply: (r) => set({ apply: { projectId: r.projectId ?? null, templateId: r.templateId ?? null, values: r.values ?? {} } }),
  openEdit: (edit) => set({ edit }),
  closeApply: () => set({ apply: null }),
  closeEdit: () => set({ edit: null }),
}));

/** A look for repeated messages runs (templates.learn); the buttons wait for it. */
export const useTemplateLearning = create<{ running: boolean }>(() => ({ running: false }));

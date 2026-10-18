import { useMemo } from "react";
import { knownTemplateValues, templatePlaceholders } from "@forge/protocol";
import { locale } from "@/i18n";
import { useProject } from "@/lib/queries";
import { useUi } from "@/stores/ui";

export interface TemplateContext {
  project: string | null;
  branch: string | null;
  file: string | null;
  date: string;
}

/** What FORGE knows for a project's templates: its name, the checked out branch, the file chosen in the Dateien tab, today. */
export function useTemplateContext(projectId: string | null): TemplateContext {
  const project = useProject(projectId).data;
  const file = useUi((s) => (projectId ? (s.selectedFile[projectId] ?? null) : null));
  return useMemo(
    () => ({ project: project?.name ?? null, branch: project?.git?.branch ?? null, file, date: new Date().toLocaleDateString(locale) }),
    [project?.name, project?.git?.branch, file],
  );
}

/** Start values of the form: what FORGE knows, overridden by what the caller passed (a right-clicked file). */
export function startValues(text: string, ctx: TemplateContext, given: Record<string, string> = {}): Record<string, string> {
  const known = knownTemplateValues(text, ctx);
  const out: Record<string, string> = {};
  for (const name of templatePlaceholders(text)) {
    const passed = Object.entries(given).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    out[name] = passed ?? known[name] ?? "";
  }
  return out;
}

/** The given values as the file placeholder under both its names, so {datei} and {file} get it. */
export function fileValues(path: string): Record<string, string> {
  return { datei: path, file: path };
}

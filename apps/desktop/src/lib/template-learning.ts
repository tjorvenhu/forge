import type { QueryClient } from "@tanstack/react-query";
import { useTemplateLearning } from "@/stores/templates";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { call } from "./queries";
import { errorMessage } from "./rpc";

/** Looks now for requests the user keeps sending and saves them as learned templates. */
export async function learnTemplatesNow(qc: QueryClient) {
  if (useTemplateLearning.getState().running) return;
  useTemplateLearning.setState({ running: true });
  try {
    const r = await call("templates.learn", {});
    void qc.invalidateQueries({ queryKey: ["templates"] });
    if (r.added.length) toast.success(r.added.length === 1 ? "Vorlage gelernt" : `${r.added.length} Vorlagen gelernt`, r.added.map((t) => t.name).join(", "));
    else toast.info("Nichts Neues gelernt", r.message);
  } catch (e) {
    toast.error("Vorlagen nicht gelernt", errorMessage(e));
  } finally {
    useTemplateLearning.setState({ running: false });
  }
}

/** FORGE learned templates on its own (event templates.learned): a note with the way to them. */
export function announceLearnedTemplates(names: string[]) {
  toast.notify({
    tone: "info",
    title: names.length === 1 ? "Neue Vorlage gelernt" : `${names.length} neue Vorlagen gelernt`,
    body: `${names.join(", ")}. Im Chat schlägt FORGE sie beim Tippen vor.`,
    action: { label: "Ansehen", onClick: () => useUi.getState().openSettings("templates") },
  });
}

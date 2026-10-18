import type { QueryClient } from "@tanstack/react-query";
import { useTemplateLearning } from "@/stores/templates";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { call } from "./queries";
import { errorMessage } from "./rpc";
import { t } from "@/i18n";

/** Looks now for requests the user keeps sending and saves them as learned templates. */
export async function learnTemplatesNow(qc: QueryClient) {
  if (useTemplateLearning.getState().running) return;
  useTemplateLearning.setState({ running: true });
  try {
    const r = await call("templates.learn", {});
    void qc.invalidateQueries({ queryKey: ["templates"] });
    if (r.added.length) toast.success(t.lib.templates.learned(r.added.length), r.added.map((x) => x.name).join(", "));
    else toast.info(t.lib.templates.nothingNew, r.message);
  } catch (e) {
    toast.error(t.lib.templates.notLearned, errorMessage(e));
  } finally {
    useTemplateLearning.setState({ running: false });
  }
}

/** FORGE learned templates on its own (event templates.learned): a note with the way to them. */
export function announceLearnedTemplates(names: string[]) {
  toast.notify({
    tone: "info",
    title: t.lib.templates.newLearned(names.length),
    body: t.lib.templates.newLearnedBody(names.join(", ")),
    action: { label: t.lib.view, onClick: () => useUi.getState().openSettings("templates") },
  });
}

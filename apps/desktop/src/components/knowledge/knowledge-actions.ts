import type { QueryClient } from "@tanstack/react-query";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { refsMissingLabel } from "./knowledge-text";

/** Checks the references again without the cache (one entry or all) and tells the result. */
export async function recheckKnowledgeRefs(qc: QueryClient, owner: string, id?: string) {
  try {
    const r = await call("knowledge.checkRefs", { projectId: owner, id, refresh: true });
    void qc.invalidateQueries({ queryKey: keys.knowledgeStale(owner) });
    const stale = r.entries.filter((e) => e.missing.length);
    if (id) {
      const n = stale[0]?.missing.length ?? 0;
      if (n) toast.info("Verweise geprüft", `${refsMissingLabel(n)}.`);
      else toast.success("Verweise geprüft", "Alle Verweise gibt es im Projekt.");
    } else if (stale.length) toast.info("Verweise geprüft", `${stale.length === 1 ? "1 Eintrag verweist" : `${stale.length} Einträge verweisen`} auf etwas, das es nicht mehr gibt.`);
    else toast.success("Verweise geprüft", "Kein Eintrag verweist ins Leere.");
  } catch (e) {
    toast.error("Prüfung fehlgeschlagen", errorMessage(e));
  }
}

/** The missing references of an entry were a false alarm. */
export async function markKnowledgeChecked(qc: QueryClient, owner: string, id: string) {
  try {
    await call("knowledge.markChecked", { projectId: owner, id });
    void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
    toast.success("Als geprüft markiert", "FORGE meldet diese Verweise nicht mehr.");
  } catch (e) {
    toast.error("Nicht markiert", errorMessage(e));
  }
}

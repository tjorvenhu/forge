import type { QueryClient } from "@tanstack/react-query";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { t } from "@/i18n";
import { refsMissingLabel } from "./knowledge-text";

/** Checks the references again without the cache (one entry or all) and tells the result. */
export async function recheckKnowledgeRefs(qc: QueryClient, owner: string, id?: string) {
  try {
    const r = await call("knowledge.checkRefs", { projectId: owner, id, refresh: true });
    void qc.invalidateQueries({ queryKey: keys.knowledgeStale(owner) });
    const stale = r.entries.filter((e) => e.missing.length);
    if (id) {
      const n = stale[0]?.missing.length ?? 0;
      if (n) toast.info(t.knowledge.actions.refsChecked, `${refsMissingLabel(n)}.`);
      else toast.success(t.knowledge.actions.refsChecked, t.knowledge.actions.allRefsExist);
    } else if (stale.length) toast.info(t.knowledge.actions.refsChecked, t.knowledge.actions.staleEntries(stale.length));
    else toast.success(t.knowledge.actions.refsChecked, t.knowledge.actions.noStale);
  } catch (e) {
    toast.error(t.knowledge.actions.checkFailed, errorMessage(e));
  }
}

/** The missing references of an entry were a false alarm. */
export async function markKnowledgeChecked(qc: QueryClient, owner: string, id: string) {
  try {
    await call("knowledge.markChecked", { projectId: owner, id });
    void qc.invalidateQueries({ queryKey: keys.knowledge(owner) });
    toast.success(t.knowledge.actions.markedChecked, t.knowledge.actions.markedCheckedHint);
  } catch (e) {
    toast.error(t.knowledge.actions.notMarked, errorMessage(e));
  }
}

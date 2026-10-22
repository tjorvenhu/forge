import { create } from "zustand";
import type { GitIncoming } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { useActivity } from "@/stores/activity";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { t } from "@/i18n";

interface RemoteCheck {
  /** the project whose branch is behind origin; components/git/RemoteCheckDialog.tsx asks what to do */
  shown: { projectId: string; incoming: GitIncoming } | null;
  close: () => void;
}

/** Projects compared automatically since FORGE started: only the first opening asks, not later switches back. */
const checked = new Set<string>();

export const useRemoteCheck = create<RemoteCheck>((set) => ({
  shown: null,
  close: () => set({ shown: null }),
}));

/**
 * Fetches origin and asks when the branch is behind. Automatically only on the first opening of a
 * project after FORGE started, silent when there is nothing new or the server cannot be reached.
 * `manual` (palette, project menu) always checks, also after "Später", and reports the outcome.
 */
export async function checkRemote(projectId: string, manual: boolean) {
  if (!manual && checked.has(projectId)) return;
  checked.add(projectId);
  const m = t.git.remoteCheck;
  let incoming: GitIncoming | null;
  try {
    const fetch = () => call("git.incoming", { projectId });
    incoming = manual ? await useActivity.getState().track(projectId, m.checkLabel, fetch) : await fetch();
  } catch (e) {
    if (manual) toast.error(m.notChecked, errorMessage(e));
    return;
  }
  if (!incoming) {
    if (manual) toast.info(m.noRemoteBranch);
    return;
  }
  if (!incoming.behind) {
    if (!manual) return;
    const local = [incoming.ahead ? m.notPushed(incoming.ahead) : "", incoming.changedCount ? m.changed(incoming.changedCount) : ""].filter(Boolean);
    toast.success(m.upToDate, local.length ? m.upToDateLocal(local.join(", ")) : undefined);
    return;
  }
  if (!manual && useUi.getState().activeProjectId !== projectId) return;
  useRemoteCheck.setState({ shown: { projectId, incoming } });
}

/** for tests */
export function resetRemoteChecks() {
  checked.clear();
  useRemoteCheck.setState({ shown: null });
}

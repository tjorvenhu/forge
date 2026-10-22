import { create } from "zustand";
import type { GitIncoming } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { useActivity } from "@/stores/activity";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { t } from "@/i18n";

/** Opening a project compares it with origin at most this often; switching back and forth does not fetch each time. */
export const AUTO_CHECK_EVERY_MS = 5 * 60_000;

interface RemoteCheck {
  /** the project whose branch is behind origin; components/git/RemoteCheckDialog.tsx asks what to do */
  shown: { projectId: string; incoming: GitIncoming } | null;
  /** "Später": the same remote state does not ask again on the next opening, a newer one does */
  later: () => void;
  close: () => void;
}

const checkedAt = new Map<string, number>();
const putOff = new Map<string, string>();

export const useRemoteCheck = create<RemoteCheck>((set, get) => ({
  shown: null,
  later: () => {
    const s = get().shown;
    if (s) putOff.set(s.projectId, s.incoming.remoteHead);
    set({ shown: null });
  },
  close: () => set({ shown: null }),
}));

/**
 * Fetches origin and asks when the branch is behind. `manual` (palette, project menu) also asks after
 * "Später" and reports when there is nothing to take over; the automatic check on opening stays silent
 * then, also when the server cannot be reached.
 */
export async function checkRemote(projectId: string, manual: boolean) {
  const now = Date.now();
  if (!manual && now - (checkedAt.get(projectId) ?? 0) < AUTO_CHECK_EVERY_MS) return;
  checkedAt.set(projectId, now);
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
  if (!manual && (putOff.get(projectId) === incoming.remoteHead || useUi.getState().activeProjectId !== projectId)) return;
  useRemoteCheck.setState({ shown: { projectId, incoming } });
}

/** for tests */
export function resetRemoteChecks() {
  checkedAt.clear();
  putOff.clear();
  useRemoteCheck.setState({ shown: null });
}

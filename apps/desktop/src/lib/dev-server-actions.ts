import type { QueryClient } from "@tanstack/react-query";
import type { DevServerState } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { openExternal } from "@/lib/native";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";

/** How long to wait for a starting dev server to print its address. */
const URL_WAIT_MS = 30_000;

/**
 * Opens a project's dev server in the browser, starting it first if needed (an agent's has its own
 * port). Waits until the server prints its address.
 */
export async function openDevServer(qc: QueryClient, projectId: string) {
  try {
    let st: DevServerState = await call("devserver.state", { projectId });
    if (st.status !== "running") st = await call("devserver.start", { projectId });
    qc.setQueryData(keys.devServer(projectId), st);
    const deadline = Date.now() + URL_WAIT_MS;
    while (!st.url && st.status === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      st = await call("devserver.state", { projectId });
    }
    qc.setQueryData(keys.devServer(projectId), st);
    if (st.url) return void (await openExternal(st.url));
    toast.error(
      "Dev-Server nicht geöffnet",
      st.status === "running" ? "Er läuft, hat aber noch keine Adresse ausgegeben. Die Ausgabe steht in den Dev-Tools." : (st.error ?? "Er ist nicht gestartet. Die Ausgabe steht in den Dev-Tools."),
    );
  } catch (e) {
    toast.error("Dev-Server nicht gestartet", errorMessage(e));
  }
}

export async function stopDevServer(qc: QueryClient, projectId: string) {
  try {
    qc.setQueryData(keys.devServer(projectId), await call("devserver.stop", { projectId }));
  } catch (e) {
    toast.error("Dev-Server nicht gestoppt", errorMessage(e));
  }
}

/** Runs the preparation of an agent's worktree again (install, configuration, build output, database). */
export async function prepareWorktree(qc: QueryClient, projectId: string) {
  try {
    qc.setQueryData(keys.worktreeSetup(projectId), await call("worktrees.prepare", { projectId }));
  } catch (e) {
    toast.error("Vorbereitung nicht gestartet", errorMessage(e));
  }
}

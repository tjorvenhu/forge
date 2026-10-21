import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { call, keys, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useAgentsSwitch } from "@/stores/agents-switch";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { t } from "@/i18n";

const m = t.projects.agents;

/** Saves the switch; false when it failed (the toast is shown). */
export async function setProjectAgents(qc: QueryClient, p: { id: string; name: string }, enabled: boolean): Promise<boolean> {
  try {
    await call("projects.update", { projectId: p.id, agentsEnabled: enabled });
    await qc.invalidateQueries({ queryKey: keys.project(p.id) });
    void qc.invalidateQueries({ queryKey: keys.projects });
    toast.success(enabled ? m.turnedOn : m.turnedOff, p.name);
    return true;
  } catch (e) {
    toast.error(m.notSaved, errorMessage(e));
    return false;
  }
}

/** Allowing agents again saves right away; switching them off asks first (AgentsOffDialog). */
export function switchProjectAgents(qc: QueryClient, p: { id: string; name: string }, enabled: boolean) {
  if (enabled) void setProjectAgents(qc, p, true);
  else useAgentsSwitch.getState().requestOff(p);
}

/** The confirmation before a project stops starting parallel agents, wherever it was asked for. */
export function AgentsOffDialog() {
  const qc = useQueryClient();
  const confirm = useAgentsSwitch((s) => s.confirm);
  const close = useAgentsSwitch((s) => s.close);
  const projects = useProjects();
  const running = confirm ? (projects.data ?? []).filter((p) => p.parentId === confirm.id).length : 0;
  return (
    <ConfirmDialog
      open={!!confirm}
      onOpenChange={(o) => !o && close()}
      title={m.confirmTitle}
      description={confirm?.name}
      confirmLabel={m.confirmLabel}
      onConfirm={async () => {
        if (!confirm || !(await setProjectAgents(qc, confirm, false))) throw new Error("not saved");
      }}
    >
      <div role="alert" className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2.5 text-body">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">{m.warningTitle}</span>
          <span className="text-fg/90">{m.warningText}</span>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        {running > 0 && `${m.existing(running)} `}
        {m.undo}
      </p>
    </ConfirmDialog>
  );
}

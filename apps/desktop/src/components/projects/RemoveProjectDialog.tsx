import { useQueryClient } from "@tanstack/react-query";
import type { Project } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function RemoveProjectDialog({ project, onClose }: { project: Pick<Project, "id" | "name" | "path"> | null; onClose: () => void }) {
  const qc = useQueryClient();
  return (
    <ConfirmDialog
      open={!!project}
      onOpenChange={(o) => !o && onClose()}
      title="Projekt aus FORGE entfernen?"
      description="Der Ordner und alle Dateien bleiben unverändert. Nur der Eintrag und die FORGE-Session-Historie werden entfernt."
      confirmLabel="Entfernen"
      danger
      onConfirm={async () => {
        if (!project) return;
        try {
          await call("projects.remove", { projectId: project.id });
          const ui = useUi.getState();
          if (ui.activeProjectId === project.id) ui.closeProject();
          await qc.invalidateQueries({ queryKey: keys.projects });
          toast.success("Projekt entfernt", project.path);
        } catch (e) {
          toast.error("Entfernen fehlgeschlagen", errorMessage(e));
        }
      }}
    >
      {project && <div className="rounded-md bg-surface-2 px-3 py-2 font-mono text-xs text-muted">{project.path}</div>}
    </ConfirmDialog>
  );
}

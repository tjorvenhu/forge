import { useQueryClient } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import type { CommitInfo } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Confirms bringing the project's files back to the state of a commit. The files change as new,
 * uncommitted changes; branch and history stay. Open work is stashed by the sidecar first.
 */
export function RestoreDialog({
  projectId,
  commit,
  current,
  openChanges,
  onOpenChange,
}: {
  projectId: string;
  commit: CommitInfo | null;
  /** the commit is HEAD: restoring only puts the open changes aside */
  current: boolean;
  openChanges: number;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();

  const restore = async () => {
    if (!commit) return;
    try {
      const r = await call("git.restoreTo", { projectId, commit: commit.hash });
      const detail = [
        r.changed ? `${r.changed} Datei(en) geändert. Prüfe sie im Git-Bereich und committe sie.` : "Die Dateien entsprechen jetzt diesem Stand.",
        r.stashed ? "Deine offenen Änderungen liegen im Git-Stash." : null,
      ]
        .filter(Boolean)
        .join(" ");
      toast.success(`Stand von ${r.commit.slice(0, 7)} wiederhergestellt`, detail);
      void qc.invalidateQueries({ queryKey: keys.git(projectId) });
      void qc.invalidateQueries({ queryKey: keys.project(projectId) });
    } catch (e) {
      toast.error("Nicht wiederhergestellt", errorMessage(e));
      throw e;
    }
  };

  return (
    <ConfirmDialog
      open={!!commit}
      onOpenChange={onOpenChange}
      title={current ? "Offene Änderungen beiseitelegen?" : "Auf diesen Stand zurück?"}
      description={
        current
          ? "Die Dateien bekommen wieder den Stand des letzten Commits. Der Verlauf bleibt unverändert."
          : "Alle Dateien im Projekt bekommen den Stand dieses Commits. Das passiert als neue Änderungen, die du danach prüfen und committen kannst. Der Verlauf bleibt unverändert."
      }
      confirmLabel={current ? "Beiseitelegen" : "Wiederherstellen"}
      onConfirm={restore}
    >
      {commit && (
        <div className="space-y-3">
          <div className="rounded-md bg-surface-2 px-3 py-2">
            <div className="truncate text-body">{commit.subject}</div>
            <div className="text-caption text-subtle">
              <span className="font-mono">{commit.shortHash}</span> · {commit.author} · {relativeTime(commit.date)}
            </div>
          </div>
          {openChanges > 0 && (
            <div className="flex items-start gap-2 text-xs text-muted">
              <Archive className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                {openChanges} nicht committete Datei(en) sichert FORGE vorher im Git-Stash. Zurückholen kannst du sie mit <span className="font-mono">git stash pop</span>.
              </span>
            </div>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

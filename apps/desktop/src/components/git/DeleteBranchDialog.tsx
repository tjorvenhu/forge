import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { call, keys } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { t } from "@/i18n";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * Deletes a local branch. First try without force; if git reports commits that are in no other
 * branch, the dialog stays open and asks again before dropping them.
 */
export function DeleteBranchDialog({ projectId, branch, onOpenChange }: { projectId: string; branch: string | null; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [unmerged, setUnmerged] = useState(false);
  useEffect(() => {
    if (branch) setUnmerged(false);
  }, [branch]);

  const remove = async () => {
    if (!branch) return;
    try {
      const branches = await call("git.deleteBranch", { projectId, branch, force: unmerged });
      qc.setQueryData(keys.branches(projectId), branches);
      toast.success(t.git.deleteBranch.deleted, branch);
    } catch (e) {
      if (e instanceof RpcCallError && e.code === "CONFLICT" && (e.details as { unmerged?: boolean } | undefined)?.unmerged && !unmerged) {
        setUnmerged(true);
        throw e;
      }
      // Not retryable from here (current, default or worktree branch): report and close.
      toast.error(t.git.deleteBranch.notDeleted, errorMessage(e));
    }
  };

  return (
    <ConfirmDialog
      open={!!branch}
      onOpenChange={onOpenChange}
      title={unmerged ? t.git.deleteBranch.titleAnyway : t.git.deleteBranch.title}
      description={unmerged ? t.git.deleteBranch.unmergedDescription(branch ?? "") : t.git.deleteBranch.description(branch ?? "")}
      confirmLabel={unmerged ? t.git.deleteBranch.deleteAnyway : t.git.deleteBranch.delete}
      danger
      onConfirm={remove}
    />
  );
}

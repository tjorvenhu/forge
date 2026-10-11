import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type { Project, ProjectWithStatus } from "@forge/protocol";
import { call, keys, useGitHubLogin } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { closeProjectTerminals } from "@/lib/terminal-registry";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, ErrorBanner, Loading } from "@/components/ui/misc";
import { DeviceCode } from "@/components/github/DeviceCode";
import { useAutoOpenGitHub } from "@/components/github/GitHubPanel";

export function RemoveProjectDialog({ project, onClose }: { project: Pick<Project, "id" | "name" | "path"> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [deleteFolder, setDeleteFolder] = useState(false);
  const [deleteRepo, setDeleteRepo] = useState(false);
  const info = useQuery({
    queryKey: ["removalInfo", project?.id],
    queryFn: () => call("projects.removalInfo", { projectId: project!.id }),
    enabled: !!project,
    staleTime: 0,
  });
  const i = info.data;
  const destructive = deleteFolder || deleteRepo;
  const needsScope = deleteRepo && !!i && !i.githubCanDelete;

  useEffect(() => {
    if (!project) {
      setDeleteFolder(false);
      setDeleteRepo(false);
    }
  }, [project]);

  return (
    <ConfirmDialog
      open={!!project}
      onOpenChange={(o) => !o && onClose()}
      title={destructive ? "Projekt endgültig löschen?" : "Projekt aus FORGE entfernen?"}
      description={
        destructive
          ? "Das lässt sich nicht rückgängig machen."
          : "Entfernt den Eintrag und die Session-Historie in FORGE. Ordner und GitHub-Repository bleiben, wenn du unten nichts auswählst."
      }
      confirmLabel={destructive ? "Endgültig löschen" : "Entfernen"}
      danger
      requireText={destructive ? project?.name : undefined}
      confirmDisabled={info.isLoading || needsScope}
      onConfirm={async () => {
        if (!project) return;
        try {
          if (deleteFolder) {
            const worktrees = (qc.getQueryData<ProjectWithStatus[]>(keys.projects) ?? []).filter((p) => p.parentId === project.id);
            closeProjectTerminals([project.id, ...worktrees.map((p) => p.id)]);
          }
          const r = await call("projects.remove", { projectId: project.id, deleteFolder, deleteGitHubRepo: deleteRepo });
          const ui = useUi.getState();
          if (ui.activeProjectId === project.id) ui.closeProject();
          await qc.invalidateQueries({ queryKey: keys.projects });
          const parts = [r.folderDeleted && "Ordner gelöscht", r.githubDeleted && `${i?.githubRepo} auf GitHub gelöscht`].filter(Boolean);
          toast.success(destructive ? "Projekt gelöscht" : "Projekt entfernt", parts.length ? parts.join(", ") : project.path);
        } catch (e) {
          await info.refetch();
          toast.error("Löschen fehlgeschlagen", errorMessage(e));
          throw e;
        }
      }}
    >
      {project && (
        <div className="flex flex-col gap-3">
          {info.isLoading && <Loading />}
          {info.isError && <ErrorBanner>{errorMessage(info.error)}</ErrorBanner>}
          {i && (
            <>
              <div className="rounded-lg border border-border p-3">
                <label className="flex items-center gap-2 text-body">
                  <Checkbox checked={deleteFolder} onChange={setDeleteFolder} disabled={!i.folderExists || !!i.folderBlocker} label="Lokalen Ordner löschen" />
                  Lokalen Ordner löschen
                </label>
                <div className="mt-1.5 break-all pl-6 font-mono text-xs text-muted">{i.path}</div>
                {!i.folderExists && <p className="mt-1.5 pl-6 text-xs text-subtle">Der Ordner existiert nicht mehr.</p>}
                {i.folderBlocker && <p className="mt-1.5 pl-6 text-xs text-warning">{i.folderBlocker}</p>}
                {deleteFolder && i.isWorktree && <p className="mt-1.5 pl-6 text-xs text-subtle">Löscht den Worktree. Der Branch und seine Commits bleiben im Repository.</p>}
                {deleteFolder && i.worktrees > 0 && (
                  <p className="mt-1.5 pl-6 text-xs text-subtle">
                    {i.worktrees === 1 ? "Der Worktree" : `Die ${i.worktrees} Worktrees`} dieses Projekts werden mit gelöscht.
                  </p>
                )}
              </div>

              {i.githubRepo && (
                <div className="rounded-lg border border-border p-3">
                  <label className="flex items-center gap-2 text-body">
                    <Checkbox checked={deleteRepo} onChange={setDeleteRepo} disabled={!i.githubSignedIn} label="Repository auf GitHub löschen" />
                    Repository auf GitHub löschen
                  </label>
                  <div className="mt-1.5 pl-6 font-mono text-xs text-muted">github.com/{i.githubRepo}</div>
                  {!i.githubSignedIn && <p className="mt-1.5 pl-6 text-xs text-subtle">Dafür musst du in FORGE bei GitHub angemeldet sein.</p>}
                  {needsScope && <GrantDeleteScope onGranted={() => void info.refetch()} />}
                  {deleteRepo && !needsScope && <p className="mt-1.5 pl-6 text-xs text-subtle">Löscht Code, Issues und Pull Requests auf GitHub.</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}

/** GitHub asks separately for the delete_repo permission; same device flow as the login. */
function GrantDeleteScope({ onGranted }: { onGranted: () => void }) {
  const qc = useQueryClient();
  const login = useGitHubLogin().data;
  const [started, setStarted] = useState(false);
  useAutoOpenGitHub();

  useEffect(() => {
    if (started && login?.phase === "done") {
      setStarted(false);
      onGranted();
    }
  }, [started, login?.phase, onGranted]);

  const start = async () => {
    try {
      qc.setQueryData(keys.githubLogin, await call("github.startLogin", { scopes: ["delete_repo"] }));
      setStarted(true);
    } catch (e) {
      toast.error("Berechtigung nicht angefragt", errorMessage(e));
    }
  };

  if (started && login?.phase === "waiting" && login.code && login.url) {
    return (
      <div className="mt-2.5 pl-6">
        <DeviceCode code={login.code} url={login.url} prompt="Gib diesen Code auf der GitHub-Seite ein:" compact />
      </div>
    );
  }

  return (
    <div className="mt-2.5 flex flex-col items-start gap-2 pl-6">
      <p className="text-xs text-muted">GitHub verlangt dafür einmalig die Berechtigung delete_repo. Die Freigabe läuft im Browser.</p>
      {login?.phase === "error" && started && <p className="text-xs text-danger">{login.message}</p>}
      <Button size="sm" onClick={() => void start()} loading={started && (login?.phase === "starting" || login?.phase === "waiting")}>
        <KeyRound className="h-3.5 w-3.5" /> Berechtigung erteilen
      </Button>
    </div>
  );
}

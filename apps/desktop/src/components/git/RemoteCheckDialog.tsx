import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, GitMerge, RotateCcw, type LucideIcon } from "lucide-react";
import type { GitIncoming } from "@forge/protocol";
import { call, keys, useProject } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { useActivity } from "@/stores/activity";
import { useDictationQuiet } from "@/stores/dictation";
import { checkRemote, useRemoteCheck } from "@/stores/remote-check";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { AuthorAvatar } from "./AuthorAvatar";
import { runGitSync } from "./Sync";
import { t } from "@/i18n";

type Choice = "rebase" | "merge" | "reset";

const SHOWN_COMMITS = 5;

/**
 * When a project is opened, FORGE fetches origin in the background. Is the branch behind, this asks
 * before the work starts: take over with own work on top (rebase), merge, or reset to origin.
 */
export function RemoteCheckDialog() {
  useCheckOnOpen();
  const shown = useRemoteCheck((s) => s.shown);
  // Opens without a click: it must not cut off a running dictation (see stores/dictation.ts).
  const quiet = useDictationQuiet();
  if (!shown || !quiet) return null;
  return <Ask key={`${shown.projectId}:${shown.incoming.remoteHead}`} projectId={shown.projectId} incoming={shown.incoming} />;
}

function useCheckOnOpen() {
  const view = useUi((s) => s.view);
  const projectId = useUi((s) => s.activeProjectId);
  const project = useProject(view === "workspace" ? projectId : null).data;
  const id = project && project.exists && project.gitEnabled && project.git?.remoteUrl && !project.git.detached ? project.id : null;
  useEffect(() => {
    if (id) void checkRemote(id, false);
  }, [id]);
}

function Ask({ projectId, incoming }: { projectId: string; incoming: GitIncoming }) {
  const qc = useQueryClient();
  const project = useProject(projectId).data;
  const { later, close } = useRemoteCheck.getState();
  const [choice, setChoice] = useState<Choice>("rebase");
  const [busy, setBusy] = useState(false);
  const m = t.git.remoteCheck;
  const hasLocal = incoming.ahead > 0 || incoming.changedCount > 0;
  const options: Array<{ value: Choice; label: string; hint: string; Icon: LucideIcon }> = [
    { value: "rebase", label: m.rebase, hint: m.rebaseHint, Icon: ArrowDownToLine },
    // Without own commits a merge is the same fast-forward as the rebase.
    ...(incoming.ahead > 0 ? [{ value: "merge" as const, label: m.merge, hint: m.mergeHint, Icon: GitMerge }] : []),
    { value: "reset", label: m.reset, hint: m.resetHint, Icon: RotateCcw },
  ];

  // The project may have been closed meanwhile (removed, Git switched off).
  useEffect(() => {
    if (project && (!project.exists || !project.gitEnabled)) close();
  }, [project, close]);

  const run = async () => {
    setBusy(true);
    try {
      if (choice === "reset") {
        const r = await useActivity.getState().track(projectId, m.resetLabel, () => call("git.resetToRemote", { projectId }));
        void qc.invalidateQueries({ queryKey: keys.git(projectId) });
        void qc.invalidateQueries({ queryKey: keys.log(projectId) });
        const notes = [r.stashed ? m.resetStashed : "", r.backupBranch ? m.resetBackup(r.backupBranch) : ""].filter(Boolean);
        toast.success(m.resetDone(r.branch), notes.join(" ") || undefined);
        close();
        return;
      }
      const strategy = choice === "merge" ? "merge" : "rebase";
      if (await runGitSync(qc, projectId, m.pullLabel, () => call("git.pull", { projectId, strategy }), m.updated)) close();
    } catch (e) {
      toast.error(m.resetFailed, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const local = [incoming.ahead ? m.notPushed(incoming.ahead) : "", incoming.changedCount ? m.changed(incoming.changedCount) : ""].filter(Boolean);
  const more = incoming.behind - Math.min(incoming.commits.length, SHOWN_COMMITS);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && later()}
      title={m.title(incoming.branch)}
      description={m.description(project?.name ?? "", incoming.behind)}
      className="w-150"
      bodyClassName="flex flex-col gap-4"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={later} disabled={busy}>
            {m.later}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void run()}>
            {!hasLocal ? m.update : choice === "reset" ? m.doReset : m.apply}
          </Button>
        </>
      }
    >
      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted">{m.incoming}</h3>
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {incoming.commits.slice(0, SHOWN_COMMITS).map((c) => (
            <li key={c.hash} className="flex items-center gap-2.5 px-3 py-2 text-body">
              <AuthorAvatar name={c.author} url={null} className="h-5 w-5" />
              <span className="min-w-0 flex-1 truncate" title={c.subject}>
                {c.subject}
              </span>
              <span className="shrink-0 text-xs text-subtle" title={`${c.author}, ${c.shortHash}`}>
                {relativeTime(c.date)}
              </span>
            </li>
          ))}
          {more > 0 && <li className="px-3 py-1.5 text-xs text-muted">{m.more(more)}</li>}
        </ul>
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted">{m.local}</h3>
        <p className="text-body">{local.length ? local.join(", ") : m.nothingLocal}</p>
      </section>

      {hasLocal && (
        <div role="radiogroup" aria-label={m.choice} className="flex flex-col gap-2">
          {options.map((o) => {
            const active = o.value === choice;
            return (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                onClick={() => setChoice(o.value)}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors duration-120 disabled:opacity-50",
                  active ? "border-accent bg-accent-soft" : "border-border enabled:hover:border-border-strong enabled:hover:bg-surface-2",
                )}
              >
                <o.Icon className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-accent" : "text-muted")} />
                <span className="flex-1">
                  <span className="block text-body font-medium">{o.label}</span>
                  <span className="block text-xs text-muted">{o.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {hasLocal && choice !== "reset" && <p className="text-xs text-subtle">{m.conflictNote}</p>}
    </Dialog>
  );
}

import { useQueryClient } from "@tanstack/react-query";
import { Globe, RotateCcw } from "lucide-react";
import type { DevServerState, WorktreeSetupState } from "@forge/protocol";
import { useDevServer, useWorktreeSetup } from "@/lib/queries";
import { openDevServer, prepareWorktree } from "@/lib/dev-server-actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const STEP_WORD: Record<WorktreeSetupState["steps"][number]["status"], string> = t.workspace.agentEnv.step;

function seconds(from: string, to: string | null): string {
  return `${Math.max(1, Math.round((Date.parse(to ?? from) - Date.parse(from)) / 1000))} s`;
}

/** All steps with their details, for the tooltip. */
export function setupSummary(s: WorktreeSetupState): string {
  return s.steps.map((x) => `${x.label}: ${STEP_WORD[x.status]}${x.detail ? `. ${x.detail}` : ""}`).join("\n");
}

function setupLine(s: WorktreeSetupState): string {
  if (s.status === "running") {
    const now = s.steps.filter((x) => x.status === "running").map((x) => x.label);
    return now.length ? t.workspace.agentEnv.preparingSteps(now.join(", ")) : t.workspace.agentEnv.preparing;
  }
  const failed = s.steps.filter((x) => x.status === "failed").map((x) => x.label);
  if (failed.length) return t.workspace.agentEnv.failedSteps(failed.join(", "));
  return t.workspace.agentEnv.preparedIn(seconds(s.startedAt, s.finishedAt));
}

function devLabel(dev: DevServerState | undefined): { text: string; tone: string; title: string } {
  const m = t.workspace.agentEnv;
  if (dev?.status === "running") {
    const port = dev.url ? /:(\d+)(\/|$)/.exec(dev.url)?.[1] : null;
    return port ? { text: `:${port}`, tone: "font-mono text-accent", title: m.openDev(dev.url!) } : { text: m.devStarting, tone: "text-warning", title: m.devStartingTitle };
  }
  if (dev?.status === "failed" || (dev?.status === "exited" && dev.exitCode !== 0)) return { text: m.devCrashed, tone: "text-danger", title: m.devRestartTitle };
  return { text: m.devServer, tone: "text-muted", title: m.devStartTitle };
}

/**
 * Third row of an agent card: how far FORGE has prepared the worktree (dependencies, local
 * configuration, build output, own test database), and the agent's own dev server with its port.
 */
export function AgentEnvironment({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const setup = useWorktreeSetup(projectId);
  const dev = useDevServer(projectId);
  if (setup.isLoading || dev.isLoading) {
    return (
      <SkeletonRegion label={t.workspace.agentEnv.loading} className="flex h-5 items-center gap-2">
        <Skeleton className="h-2.5 w-2/5" />
        <div className="flex-1" />
        <Skeleton className="h-2.5 w-16" />
      </SkeletonRegion>
    );
  }
  const s = setup.data ?? null;
  const label = devLabel(dev.data);
  return (
    <div className="flex h-5 items-center gap-2 text-xs">
      {s && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", s.status === "running" ? "animate-soft-pulse bg-warning" : s.status === "failed" ? "bg-danger" : "bg-success")} />}
      <span className={cn("min-w-0 flex-1 truncate", s?.status === "failed" ? "text-danger" : "text-muted")} title={s ? setupSummary(s) : undefined}>
        {s ? setupLine(s) : ""}
      </span>
      {s?.status === "failed" && (
        <Button size="icon-sm" variant="ghost" className="h-5 w-5" onClick={() => void prepareWorktree(qc, projectId)} title={t.workspace.agentEnv.retrySetup} aria-label={t.workspace.agentEnv.retrySetup}>
          <RotateCcw className="h-3 w-3" />
        </Button>
      )}
      <button onClick={() => void openDevServer(qc, projectId)} className={cn("flex shrink-0 items-center gap-1 hover:underline", label.tone)} title={label.title}>
        <Globe className="h-3 w-3" />
        {label.text}
      </button>
    </div>
  );
}

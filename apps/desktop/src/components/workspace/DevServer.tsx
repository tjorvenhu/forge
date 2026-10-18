import { useEffect, useLayoutEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Play, RotateCw, SendHorizontal, Square } from "lucide-react";
import type { DevServerState, Project } from "@forge/protocol";
import { call, keys, useDevServer } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { openExternal } from "@/lib/native";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { activeDraftKey, useDrafts } from "@/stores/drafts";
import { useDevOutput } from "@/stores/dev-output";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

/** Lines of dev server output handed to Claude; enough for a stack trace, small enough for the prompt. */
const LINES_FOR_CLAUDE = 80;

export function useDevActions(projectId: string) {
  const qc = useQueryClient();
  const run = async (method: "devserver.start" | "devserver.stop", errorTitle: string) => {
    try {
      qc.setQueryData(keys.devServer(projectId), await call(method, { projectId }));
    } catch (e) {
      toast.error(errorTitle, errorMessage(e));
    }
  };
  return {
    start: () => {
      // A restart begins with an empty log, like a fresh terminal.
      useDevOutput.getState().set(projectId, "");
      return run("devserver.start", t.workspace.devServer.notStarted);
    },
    stop: () => run("devserver.stop", t.workspace.devServer.notStopped),
  };
}

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function statusBadge(state: DevServerState) {
  switch (state.status) {
    case "running":
      return <Badge tone="success">{t.workspace.devServer.running}</Badge>;
    case "exited":
      return <Badge tone={state.exitCode === 0 ? "neutral" : "danger"}>{t.workspace.devServer.exited}{state.exitCode !== null ? t.workspace.devServer.exitCode(state.exitCode) : ""}</Badge>;
    case "failed":
      return <Badge tone="danger">{t.workspace.devServer.startFailed}</Badge>;
    default:
      return <Badge>{t.workspace.devServer.stopped}</Badge>;
  }
}

/** Status and start/stop/restart as prominent buttons, for the header of the Dev-Tools card. */
export function DevServerControls({ project }: { project: Project }) {
  const query = useDevServer(project.id);
  const state = query.data;
  const { start, stop } = useDevActions(project.id);
  if (query.isLoading)
    return (
      <SkeletonRegion label={t.workspace.devServer.loading} className="flex shrink-0 items-center gap-2">
        <Skeleton className="h-5 w-14 rounded" />
        <Skeleton className="h-7 w-22" />
      </SkeletonRegion>
    );
  if (!state) return null;
  return (
    <div className="flex shrink-0 items-center gap-2">
      {statusBadge(state)}
      {state.status === "running" ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => void stop().then(start)} title={t.workspace.devServer.restartTitle}>
            <RotateCw className="h-3.5 w-3.5" /> {t.workspace.devServer.restart}
          </Button>
          <Button size="sm" onClick={() => void stop()}>
            <Square className="h-3 w-3 fill-current" /> {t.workspace.devServer.stop}
          </Button>
        </>
      ) : (
        <Button size="sm" variant="primary" onClick={() => void start()} disabled={!state.effectiveCommand}>
          <Play className="h-3.5 w-3.5" /> {t.workspace.devServer.start}
        </Button>
      )}
    </div>
  );
}

/**
 * Output of the dev server (bottom panel and Dev-Tools tab), with a shortcut to hand the last lines to Claude.
 * `controls={false}` leaves status and start/stop to {@link DevServerControls} elsewhere.
 */
export function DevServerPanel({ project, controls = true }: { project: Project; controls?: boolean }) {
  const query = useDevServer(project.id);
  const state = query.data;
  const text = useDevOutput((s) => s.text[project.id]);
  const { start, stop } = useDevActions(project.id);
  const scrollRef = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    if (text !== undefined) return;
    call("devserver.output", { projectId: project.id })
      .then((r) => useDevOutput.getState().set(project.id, r.text))
      .catch(() => useDevOutput.getState().set(project.id, ""));
  }, [project.id, text]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  const sendToClaude = () => {
    const lines = (text ?? "").trimEnd().split(/\r?\n/).slice(-LINES_FOR_CLAUDE).join("\n");
    if (!lines.trim()) return;
    const ui = useUi.getState();
    const key = activeDraftKey(project.id, ui.activeSession[project.id]);
    const block = t.workspace.devServer.forClaude(state?.command ?? t.workspace.devServer.name, lines);
    const drafts = useDrafts.getState();
    const cur = drafts.drafts[key]?.text ?? "";
    drafts.setText(key, cur.trim() ? `${cur.trimEnd()}\n\n${block}` : block);
    ui.setWorkspaceTab("chat");
    requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
    toast.info(t.workspace.devServer.addedToMessage, t.workspace.devServer.addedToMessageHint);
  };

  if (query.isLoading)
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3" aria-hidden>
          {controls && <Skeleton className="h-5 w-14 rounded" />}
          <Skeleton className="h-2.5 w-32" />
          <div className="flex-1" />
          <Skeleton className="h-6 w-20" />
          {controls && <Skeleton className="h-6 w-20" />}
        </div>
        <OutputSkeleton />
      </div>
    );
  if (!state) return null;
  const running = state.status === "running";
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
        {controls && statusBadge(state)}
        <span className="min-w-0 truncate font-mono text-subtle">{state.command ?? state.effectiveCommand ?? t.workspace.devServer.noCommand}</span>
        {running && state.url && (
          <button onClick={() => void openExternal(state.url!)} className="flex items-center gap-1 font-mono text-accent hover:underline">
            {hostOf(state.url)} <ExternalLink className="h-3 w-3" />
          </button>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={sendToClaude} disabled={!text?.trim()} title={t.workspace.devServer.sendTitle}>
          <SendHorizontal className="h-3.5 w-3.5" /> {t.workspace.devServer.send}
        </Button>
        {controls &&
          (running ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void stop().then(start)} title={t.workspace.devServer.restartTitle}>
                <RotateCw className="h-3.5 w-3.5" /> {t.workspace.devServer.restart}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void stop()} className="hover:text-danger">
                <Square className="h-3 w-3 fill-current" /> {t.workspace.devServer.stop}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void start()} disabled={!state.effectiveCommand}>
              <Play className="h-3.5 w-3.5" /> {t.workspace.devServer.start}
            </Button>
          ))}
      </div>
      {text === undefined ? (
        <OutputSkeleton />
      ) : (
        <pre
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-caption-lg leading-[1.45] text-muted"
        >
          {text || (state.effectiveCommand ? t.workspace.devServer.noOutput(state.effectiveCommand) : t.workspace.devServer.noCommandDetected)}
        </pre>
      )}
    </div>
  );
}

/** Log lines at the pre's padding and line height. */
function OutputSkeleton() {
  return (
    <SkeletonRegion label={t.workspace.devServer.loadingOutput} className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-2">
      {[55, 70, 40, 62, 30].map((w) => (
        <div key={w} className="flex h-[1.45em] items-center text-caption-lg">
          <Skeleton className="h-2.5 rounded-sm" style={{ width: `${w}%` }} />
        </div>
      ))}
    </SkeletonRegion>
  );
}

import { memo, useEffect, useState, type ReactNode } from "react";
import { ArrowDownToLine, Bot, Hourglass, Square } from "lucide-react";
import type { BackgroundTask, SubagentProgress } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi, type TaskView } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd, Tooltip } from "@/components/ui/misc";
import { ChatRow } from "./ChatRow";
import { ClaudeMark } from "./ClaudeMark";
import { formatElapsed, pickPhrase } from "./working";

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** What opens when a background task is clicked: a subagent's history or a command's output. */
function taskViewOf(t: BackgroundTask, sessionId: string | undefined): TaskView | null {
  if (!sessionId) return null;
  if (t.taskType === "local_agent") return t.toolUseId ? { kind: "agent", sessionId, toolUseId: t.toolUseId, title: t.description } : null;
  return { kind: "shell", sessionId, taskId: t.taskId, toolUseId: t.toolUseId, title: t.description };
}

/** Name of a task; a button that opens its own history when there is one. */
function TaskTitle({ task, className, children }: { task: TaskView | null; className?: string; children: ReactNode }) {
  const openTask = useUi((s) => s.openTask);
  if (!task) return <span className={cn("min-w-0 truncate", className)}>{children}</span>;
  return (
    <button
      type="button"
      className={cn("min-w-0 truncate text-left underline-offset-2 hover:underline", className)}
      title={task.kind === "agent" ? "Verlauf des Subagenten öffnen" : "Ausgabe ansehen"}
      onClick={() => openTask(task)}
    >
      {children}
    </button>
  );
}

/** Commands and subagents Claude left running in the background; each can be stopped on its own. */
export const BackgroundIndicator = memo(function BackgroundIndicator({ tasks, sessionId }: { tasks: BackgroundTask[]; sessionId?: string }) {
  const now = useNow();
  const [stopping, setStopping] = useState<Set<string>>(() => new Set());
  const stop = async (taskId: string) => {
    if (!sessionId) return;
    setStopping((s) => new Set(s).add(taskId));
    try {
      await call("sessions.stopTask", { sessionId, taskId });
    } catch (e) {
      toast.error("Aufgabe nicht gestoppt", errorMessage(e));
      setStopping((s) => {
        const next = new Set(s);
        next.delete(taskId);
        return next;
      });
    }
  };
  return (
    <div className="flex flex-col gap-0.5 px-6 pb-4 text-small">
      {tasks.map((t) => (
        <ChatRow key={t.taskId} marker={<Hourglass className="animate-soft-pulse h-3.5 w-3.5 text-accent" />}>
          <div className="group/task flex min-w-0 items-baseline gap-2">
            <TaskTitle task={taskViewOf(t, sessionId)} className="text-fg">
              Im Hintergrund: {t.description}
            </TaskTitle>
            {t.summary && (
              <span className="min-w-0 truncate text-muted" title={t.summary}>
                · {t.summary}
              </span>
            )}
            <span className="shrink-0 tabular-nums text-subtle">seit {formatElapsed(now - new Date(t.startedAt).getTime())}</span>
            {sessionId && (
              <Tooltip content="Nur diese Aufgabe stoppen">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="h-5 w-5 shrink-0 self-center opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100"
                  aria-label={`${t.description} stoppen`}
                  loading={stopping.has(t.taskId)}
                  onClick={() => void stop(t.taskId)}
                >
                  {!stopping.has(t.taskId) && <Square className="h-3 w-3" />}
                </Button>
              </Tooltip>
            )}
          </div>
        </ChatRow>
      ))}
      <ChatRow>
        <span className="text-subtle">Claude meldet sich in dieser Session, sobald {tasks.length === 1 ? "die Aufgabe" : "eine Aufgabe"} fertig ist.</span>
      </ChatRow>
    </div>
  );
});

/** Claude's turning mark and a working phrase that changes now and then; `children` follow the phrase. */
export function WorkingLine({ startedAt, now, children }: { startedAt: string; now: number; children?: ReactNode }) {
  return (
    <ChatRow
      marker={
        <span className="flex motion-safe:animate-spin-slow">
          <ClaudeMark size={13} />
        </span>
      }
    >
      <span className="font-medium text-claude">{pickPhrase(startedAt, now - new Date(startedAt).getTime())} …</span> {children}
    </ChatRow>
  );
}

/** A subagent or background command at work, in the window with its own history or output. */
export function TaskWorking({ startedAt, progress }: { startedAt: string; progress?: string | null }) {
  const now = useNow();
  return (
    <div className="text-small">
      <WorkingLine startedAt={startedAt} now={now}>
        {progress && <span className="text-muted">{progress} </span>}
        <span className="tabular-nums text-subtle">({formatElapsed(now - new Date(startedAt).getTime())})</span>
      </WorkingLine>
    </div>
  );
}

/**
 * Activity line under the chat while a turn runs, like the spinner line of the Claude Code shell.
 * Subagents of the turn are listed below it with their latest progress; each can be sent to the
 * background, so the turn goes on without waiting for it.
 */
export const WorkingIndicator = memo(function WorkingIndicator({ startedAt, subagents = [], sessionId }: { startedAt: string; subagents?: SubagentProgress[]; sessionId?: string }) {
  const now = useNow();
  const elapsed = now - new Date(startedAt).getTime();
  const toBackground = async (toolUseId: string | null) => {
    if (!sessionId) return;
    try {
      const r = await call("sessions.toBackground", { sessionId, toolUseId: toolUseId ?? undefined });
      if (!r.moved) toast.info("Nichts verschoben", "Der Subagent ist schon fertig.");
    } catch (e) {
      toast.error("Nicht in den Hintergrund verschoben", errorMessage(e));
    }
  };
  return (
    <div className="px-6 pb-4 pt-1 text-small">
      <WorkingLine startedAt={startedAt} now={now}>
        <span className="tabular-nums text-subtle">
          ({formatElapsed(elapsed)} · <Kbd>Esc</Kbd> zum Unterbrechen)
        </span>
      </WorkingLine>
      {subagents.map((a) => (
        <ChatRow key={a.taskId} marker={<Bot className="h-3.5 w-3.5 text-accent" />}>
          <div className="group/agent flex min-w-0 items-baseline gap-2">
            <TaskTitle task={sessionId && a.toolUseId ? { kind: "agent", sessionId, toolUseId: a.toolUseId, title: a.description } : null} className="text-fg">
              {a.description}
            </TaskTitle>
            <span className="min-w-0 truncate text-muted" title={a.summary ?? undefined}>
              {a.summary ?? (a.lastTool ? `nutzt ${a.lastTool}` : "startet …")}
            </span>
            <span className="shrink-0 tabular-nums text-subtle">
              {a.toolUses} {a.toolUses === 1 ? "Aufruf" : "Aufrufe"} · {formatElapsed(now - new Date(a.startedAt).getTime())}
            </span>
            {sessionId && (
              <Tooltip content="In den Hintergrund: Claude arbeitet weiter, der Subagent läuft nebenher (wie Strg+B im Terminal)">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="h-5 w-5 shrink-0 self-center opacity-0 group-hover/agent:opacity-100 focus-visible:opacity-100"
                  aria-label={`${a.description} in den Hintergrund`}
                  onClick={() => void toBackground(a.toolUseId)}
                >
                  <ArrowDownToLine className="h-3 w-3" />
                </Button>
              </Tooltip>
            )}
          </div>
        </ChatRow>
      ))}
    </div>
  );
});

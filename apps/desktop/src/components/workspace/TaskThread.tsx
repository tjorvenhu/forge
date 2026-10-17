import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, History } from "lucide-react";
import type { SessionEvent, SessionEventBody } from "@forge/protocol";
import { call, keys, useOlderHistory, useSession, useSessionHistory, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi, type TaskView } from "@/stores/ui";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { IncrementalItems } from "./chat-items";
import { ItemView } from "./ChatItemView";
import { Markdown } from "./Markdown";
import { FollowScroll } from "./FollowScroll";
import { TaskWorking } from "./WorkingIndicator";

const NO_EVENTS: SessionEvent[] = [];
/** how often a running background command's output is read again */
const OUTPUT_POLL_MS = 1500;

type Body<T extends SessionEventBody["type"]> = Extract<SessionEventBody, { type: T }>;

/** Own history of a subagent or background command of this session, over the chat. */
export function TaskThreadDialog({ sessionId, projectDir }: { sessionId: string; projectDir: string }) {
  const task = useUi((s) => (s.taskView?.sessionId === sessionId ? s.taskView : null));
  const openTask = useUi((s) => s.openTask);
  // Leaving the session closes its task view; it would otherwise reopen on the way back.
  useEffect(() => () => {
    if (useUi.getState().taskView?.sessionId === sessionId) useUi.getState().openTask(null);
  }, [sessionId]);
  return (
    <Dialog
      open={!!task}
      onOpenChange={(open) => !open && openTask(null)}
      title={task?.title ?? ""}
      description={task?.kind === "shell" ? "Ausgabe des Befehls im Hintergrund" : "Verlauf des Subagenten"}
      className="h-[80vh] w-225"
      bodyClassName="flex flex-col overflow-hidden p-0"
    >
      {task?.kind === "agent" ? (
        <FollowScroll key={task.toolUseId} className="px-5 py-4">
          <AgentThread task={task} projectDir={projectDir} />
        </FollowScroll>
      ) : task?.kind === "shell" ? (
        <FollowScroll key={task.taskId} className="px-5 py-4">
          <ShellOutput task={task} />
        </FollowScroll>
      ) : null}
      {task && <TaskComposer key={`composer-${task.kind === "agent" ? task.toolUseId : task.taskId}`} task={task} />}
    </Dialog>
  );
}

function AgentThread({ task, projectDir }: { task: Extract<TaskView, { kind: "agent" }>; projectDir: string }) {
  const { buffer } = useSessionHistory(task.sessionId);
  const session = useSession(task.sessionId).data ?? null;
  const events = buffer?.events ?? NO_EVENTS;
  const [builder] = useState(() => new IncrementalItems(task.toolUseId));
  const items = useMemo(() => builder.build(events), [builder, events]);
  const { use, result } = useMemo(() => agentCall(events, task.toolUseId), [events, task.toolUseId]);
  const { hasOlder, loading, loadOlder } = useOlderHistory(task.sessionId);
  const live = session?.subagents.find((a) => a.toolUseId === task.toolUseId) ?? session?.background.find((b) => b.toolUseId === task.toolUseId) ?? null;
  const [openedAt] = useState(() => new Date().toISOString());
  const running = !result && !!session?.live;
  const prompt = typeof use?.input.prompt === "string" ? use.input.prompt : null;

  if (!buffer?.loaded) return <AgentThreadSkeleton />;
  return (
    <div className="space-y-4">
      {hasOlder && !use && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" loading={loading} onClick={() => void loadOlder()}>
            <History className="h-3.5 w-3.5" /> Ältere Einträge laden
          </Button>
        </div>
      )}
      {prompt && (
        <Section label="Auftrag">
          <div className="text-body text-muted">
            <Markdown text={prompt} />
          </div>
        </Section>
      )}
      <Section label="Schritte">
        {items.length > 0 && (
          <div className="space-y-2">
            {items.map((item) => (
              <ItemView key={item.key} item={item} sessionId={task.sessionId} live={!!session?.live} projectDir={projectDir} />
            ))}
          </div>
        )}
        {!items.length && !running && <p className="text-body text-subtle">Für diesen Subagenten sind keine Schritte gespeichert.</p>}
        {running && (
          <div className={items.length ? "mt-3" : undefined}>
            <TaskWorking startedAt={live?.startedAt ?? openedAt} progress={live?.summary} />
          </div>
        )}
      </Section>
      {result && (
        <Section label={result.isError ? "Fehler" : "Ergebnis"}>
          <div className={result.isError ? "text-body text-danger" : "text-body"}>
            <Markdown text={result.text || "(leer)"} />
          </div>
        </Section>
      )}
    </div>
  );
}

/** Same layout as the thread: the task, then steps as chat rows. */
function AgentThreadSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Lädt">
      <SectionSkeleton>
        <Skeleton className="h-3 w-[80%]" />
        <Skeleton className="h-3 w-[55%]" />
      </SectionSkeleton>
      <SectionSkeleton>
        {[60, 45, 70, 35].map((w, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <Skeleton className="h-3.5 w-3.5 shrink-0 rounded-sm" />
            <Skeleton className="h-3" style={{ width: `${w}%` }} />
          </div>
        ))}
      </SectionSkeleton>
    </div>
  );
}

/** Lines of command output in the mono font. */
function ShellOutputSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-label="Lädt">
      <Skeleton className="h-3 w-48" />
      <div className="space-y-1.5">
        {[75, 60, 85, 40, 65, 50].map((w, i) => (
          <Skeleton key={i} className="h-3" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}

function SectionSkeleton({ children }: { children: ReactNode }) {
  return (
    <div>
      <Skeleton className="mb-2.5 h-2.5 w-16" />
      <div className="space-y-2">{children}</div>
    </div>
  );
}

interface AgentResult {
  isError: boolean;
  text: string;
}

/**
 * The Agent call and its outcome. A subagent in the background answers its call at once with a
 * launch notice; its real answer comes with the end of the background task.
 */
export function agentCall(events: readonly SessionEvent[], toolUseId: string): { use: Body<"tool.use"> | null; result: AgentResult | null } {
  let use: Body<"tool.use"> | null = null;
  let direct: Body<"tool.result"> | null = null;
  let finished: Body<"background.task"> | null = null;
  /** the subagent ran as a task: in the background, or resumed by SendMessage after a run in the foreground */
  let asTask = false;
  for (const e of events) {
    const b = e.body;
    if (b.type === "tool.use" && b.toolUseId === toolUseId) use = b;
    else if (b.type === "tool.result" && b.toolUseId === toolUseId) direct = b;
    // A subagent resumed by SendMessage starts again under its first call: its earlier answer is no longer the last one.
    else if (b.type === "background.task" && b.toolUseId === toolUseId) {
      asTask = true;
      finished = b.state === "started" ? null : b;
    }
  }
  // The call itself may sit on an older page that is not loaded; the launch notice tells it too.
  const background = asTask || use?.input.run_in_background === true || !!direct?.content.text.startsWith("Async agent launched");
  if (background && !direct?.isError) {
    return { use, result: finished ? { isError: finished.state === "failed", text: finished.summary ?? (finished.state === "stopped" ? "Gestoppt." : "") } : null };
  }
  return { use, result: direct && { isError: direct.isError, text: direct.content.text } };
}

function ShellOutput({ task }: { task: Extract<TaskView, { kind: "shell" }> }) {
  const session = useSession(task.sessionId).data ?? null;
  const background = session?.background.find((b) => b.taskId === task.taskId) ?? null;
  const running = !!background;
  const live = !!session?.live;
  const out = useQuery({
    queryKey: ["taskOutput", task.sessionId, task.taskId],
    queryFn: () => call("sessions.taskOutput", { sessionId: task.sessionId, taskId: task.taskId }),
    enabled: live,
    retry: false,
    refetchInterval: running ? OUTPUT_POLL_MS : false,
  });
  // Read once more when the command ends, so its last lines are there.
  const refetch = out.refetch;
  useEffect(() => {
    if (!running && live) void refetch();
  }, [running, live, refetch]);

  if (!session) return <ShellOutputSkeleton />;
  if (!live) return <p className="text-body text-subtle">Die Session ist beendet. Die Ausgabe eines Befehls gibt es nur, solange die Session läuft.</p>;
  if (out.error) return <p className="text-body text-danger">Ausgabe nicht lesbar: {errorMessage(out.error)}</p>;
  if (!out.data) return <ShellOutputSkeleton />;
  return (
    <div className="space-y-2">
      {(!running || out.data.truncated) && (
        <p className="text-small text-subtle">
          {!running && "Beendet."}
          {out.data.truncated && ` Zu sehen sind die letzten 8 KB von ${Math.round(out.data.totalBytes / 1024)} KB.`}
        </p>
      )}
      {out.data.output ? (
        <pre className="whitespace-pre-wrap font-mono text-small leading-relaxed text-muted wrap-anywhere">{out.data.output}</pre>
      ) : (
        <p className="text-body text-subtle">
          {running
            ? "Der Befehl hat noch nichts ausgegeben. Läuft seine Ausgabe durch eine Pipe wie | grep oder | head, kommt sie oft erst, wenn er fertig ist."
            : "Der Befehl hat nichts ausgegeben."}
        </p>
      )}
      {background && (
        <div className="pt-1">
          <TaskWorking startedAt={background.startedAt} />
        </div>
      )}
    </div>
  );
}

/** Placeholder and hint of the input, by what can receive the message. */
export function composerText(kind: TaskView["kind"], sent: boolean): { placeholder: string; hint: string } {
  if (kind === "agent")
    return {
      placeholder: "Nachricht an den Subagenten",
      hint: sent ? "Gesendet. Claude gibt sie an den Subagenten weiter, sie steht auch im Chat." : "Claude gibt die Nachricht an den Subagenten weiter. Ist er schon fertig, macht er damit weiter.",
    };
  return {
    placeholder: "Nachricht an Claude zu dieser Aufgabe",
    hint: sent ? "Gesendet. Claudes Antwort steht im Chat." : "Ein Befehl im Hintergrund liest keine Eingaben. Claude bekommt die Nachricht mit Bezug auf diese Aufgabe und reagiert darauf.",
  };
}

/**
 * Writes to the task. Claude Code cannot hand a message to a task itself: the session gets it with
 * the task named, and passes it on to a subagent with SendMessage.
 */
function TaskComposer({ task }: { task: TaskView }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const qc = useQueryClient();
  const enterToSend = useSettings().data?.enterToSend ?? true;
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!task.compose) return;
    // After the dialog's own focus handling and a closing palette handing focus back.
    const t = setTimeout(() => ref.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [task]);
  const { placeholder, hint } = composerText(task.kind, sent);
  const send = async () => {
    const next = text.trim();
    if (!next || busy) return;
    setBusy(true);
    try {
      const target = task.kind === "agent" ? { toolUseId: task.toolUseId } : { taskId: task.taskId };
      qc.setQueryData(keys.session(task.sessionId), await call("sessions.messageTask", { sessionId: task.sessionId, ...target, text: next }));
      setText("");
      setSent(true);
    } catch (e) {
      toast.error("Nachricht nicht gesendet", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shrink-0 border-t border-border px-5 py-3">
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (sent) setSent(false);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
          rows={Math.min(6, Math.max(1, text.split("\n").length))}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            if (enterToSend ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button size="icon" variant="primary" className="h-9 w-9 shrink-0" onClick={() => void send()} loading={busy} disabled={!text.trim()} aria-label="Senden">
          {!busy && <ArrowUp className="h-4 w-4" />}
        </Button>
      </div>
      <p className="mt-1.5 text-caption text-subtle">{hint}</p>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-caption-lg font-medium uppercase tracking-wide text-subtle">{label}</h3>
      {children}
    </section>
  );
}

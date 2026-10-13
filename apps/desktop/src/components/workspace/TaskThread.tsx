import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import type { SessionEvent, SessionEventBody } from "@forge/protocol";
import { call, useOlderHistory, useSession, useSessionHistory } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { useUi, type TaskView } from "@/stores/ui";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loading } from "@/components/ui/misc";
import { IncrementalItems } from "./chat-items";
import { ItemView } from "./ChatItemView";
import { Markdown } from "./Markdown";

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
    >
      {task?.kind === "agent" ? (
        <AgentThread key={task.toolUseId} task={task} projectDir={projectDir} />
      ) : task?.kind === "shell" ? (
        <ShellOutput key={task.taskId} task={task} />
      ) : null}
    </Dialog>
  );
}

/** Keeps the end in view while new rows arrive, unless the user scrolled up. */
function useStickToEnd(dep: unknown) {
  const end = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  useEffect(() => {
    const el = end.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => (atEnd.current = !!e?.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (atEnd.current) end.current?.scrollIntoView({ block: "end" });
  }, [dep]);
  return end;
}

function AgentThread({ task, projectDir }: { task: Extract<TaskView, { kind: "agent" }>; projectDir: string }) {
  const { buffer } = useSessionHistory(task.sessionId);
  const session = useSession(task.sessionId).data ?? null;
  const events = buffer?.events ?? NO_EVENTS;
  const [builder] = useState(() => new IncrementalItems(task.toolUseId));
  const items = useMemo(() => builder.build(events), [builder, events]);
  const { use, result } = useMemo(() => agentCall(events, task.toolUseId), [events, task.toolUseId]);
  const { hasOlder, loading, loadOlder } = useOlderHistory(task.sessionId);
  const progress = session?.subagents.find((a) => a.toolUseId === task.toolUseId)?.summary ?? session?.background.find((b) => b.toolUseId === task.toolUseId)?.summary ?? null;
  const running = !result && !!session?.live;
  const end = useStickToEnd(items.length + (result ? 1 : 0));
  const prompt = typeof use?.input.prompt === "string" ? use.input.prompt : null;

  if (!buffer?.loaded) return <Loading />;
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
        {items.length ? (
          <div className="space-y-2">
            {items.map((item) => (
              <ItemView key={item.key} item={item} sessionId={task.sessionId} live={!!session?.live} projectDir={projectDir} />
            ))}
          </div>
        ) : (
          <p className="text-body text-subtle">{running ? "Der Subagent startet." : "Für diesen Subagenten sind keine Schritte gespeichert."}</p>
        )}
        {running && <p className="mt-3 animate-soft-pulse text-small text-accent">{progress ?? "Arbeitet …"}</p>}
      </Section>
      {result && (
        <Section label={result.isError ? "Fehler" : "Ergebnis"}>
          <div className={result.isError ? "text-body text-danger" : "text-body"}>
            <Markdown text={result.content.text || "(leer)"} />
          </div>
        </Section>
      )}
      <div ref={end} />
    </div>
  );
}

function agentCall(events: readonly SessionEvent[], toolUseId: string): { use: Body<"tool.use"> | null; result: Body<"tool.result"> | null } {
  let use: Body<"tool.use"> | null = null;
  let result: Body<"tool.result"> | null = null;
  for (const e of events) {
    if (e.body.type === "tool.use" && e.body.toolUseId === toolUseId) use = e.body;
    else if (e.body.type === "tool.result" && e.body.toolUseId === toolUseId) result = e.body;
  }
  return { use, result };
}

function ShellOutput({ task }: { task: Extract<TaskView, { kind: "shell" }> }) {
  const session = useSession(task.sessionId).data ?? null;
  const running = !!session?.background.some((b) => b.taskId === task.taskId);
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
  const end = useStickToEnd(out.data?.totalBytes);

  if (!live) return <p className="text-body text-subtle">Die Session ist beendet. Die Ausgabe eines Befehls gibt es nur, solange die Session läuft.</p>;
  if (out.error) return <p className="text-body text-danger">Ausgabe nicht lesbar: {errorMessage(out.error)}</p>;
  if (!out.data) return <Loading />;
  return (
    <div className="space-y-2">
      <p className="text-small text-subtle">
        {running ? "Läuft noch, die Ausgabe wird laufend gelesen." : "Beendet."}
        {out.data.truncated && ` Zu sehen sind die letzten 8 KB von ${Math.round(out.data.totalBytes / 1024)} KB.`}
      </p>
      <pre className="whitespace-pre-wrap font-mono text-small leading-relaxed text-muted wrap-anywhere">{out.data.output || "(noch keine Ausgabe)"}</pre>
      <div ref={end} />
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

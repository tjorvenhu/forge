import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, FileText, History, Hourglass, ImageIcon, Info, MessageSquarePlus, Power, RotateCcw, ShieldAlert, Smartphone, Terminal, Trash2, Undo2, XCircle } from "lucide-react";
import type { ExternalSession, Project, RewindResult, Session } from "@forge/protocol";
import { call, useSession, useSessionHistory, useSessions } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { clockTime, cn, formatDuration, formatTokens, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Badge, EmptyState, Tooltip, Loading } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { buildChatItems, itemIndexForSeq, lastUserPrompt, type ChatItem } from "./chat-items";
import { PlanCard, QuestionCard } from "./InteractiveCards";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { ApprovalBlock, ToolCard } from "./ToolCard";
import { EventCard, noticeIcon } from "./EventCard";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { ClaudeMark } from "./ClaudeMark";
import { SummaryButton } from "./SummaryButton";
import { SessionTabs } from "./SessionTabs";
import { DeleteSessionDialog } from "./DeleteSessionDialog";
import { BackgroundIndicator, WorkingIndicator } from "./WorkingIndicator";
import { turnStartedAt } from "./working";

/** activeSession values starting with this prefix point at a terminal session not yet adopted by FORGE */
export const EXTERNAL_PREFIX = "ext:";

export function ChatPanel({ project, workingInPanel = false }: { project: Project; workingInPanel?: boolean }) {
  const active = useUi((s) => s.activeSession[project.id] ?? null);
  const setActive = useUi((s) => s.setActiveSession);
  const sessions = useSessions(project.id);
  const external = active?.startsWith(EXTERNAL_PREFIX) ? sessions.data?.external.find((e) => EXTERNAL_PREFIX + e.claudeSessionId === active) ?? null : null;
  const sessionId = active && !active.startsWith(EXTERNAL_PREFIX) ? active : null;
  const session = useSession(sessionId);

  // First open of a project: pick the most recent session instead of an empty chat.
  const didAutoSelect = useRef<string | null>(null);
  useEffect(() => {
    if (didAutoSelect.current === project.id || !sessions.data) return;
    didAutoSelect.current = project.id;
    const state = useUi.getState().activeSession;
    if (!(project.id in state) && sessions.data.sessions[0]) setActive(project.id, sessions.data.sessions[0].id);
  }, [project.id, sessions.data, setActive]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionTabs projectId={project.id} />
      <SessionBar
        project={project}
        session={session.data ?? null}
        external={external}
        sessions={sessions.data?.sessions ?? []}
        externals={sessions.data?.external ?? []}
        onSelect={(id) => setActive(project.id, id)}
      />
      {sessionId ? (
        <SessionThread key={sessionId} sessionId={sessionId} session={session.data ?? null} project={project} workingInPanel={workingInPanel} />
      ) : (
        <NewSessionPane project={project} external={external} />
      )}
    </div>
  );
}

function SessionBar({
  project,
  session,
  external,
  sessions,
  externals,
  onSelect,
}: {
  project: Project;
  session: Session | null;
  external: ExternalSession | null;
  sessions: Session[];
  externals: ExternalSession[];
  onSelect: (id: string | null) => void;
}) {
  const title = session?.title ?? (external ? external.summary : "Neue Session");
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      <DropdownMenu
        align="start"
        header={sessions.length || externals.length ? "Sessions in diesem Projekt" : "Noch keine Sessions"}
        trigger={
          <button className="flex min-w-0 max-w-[420px] items-center gap-1.5 rounded-md px-2 py-1 text-[13px] hover:bg-surface-3" aria-label="Session wählen">
            <History className="h-3.5 w-3.5 shrink-0 text-muted" />
            <span className="truncate">{title}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
          </button>
        }
        items={[
          { label: "Neue Session", icon: <MessageSquarePlus className="h-3.5 w-3.5" />, onSelect: () => onSelect(null), hint: "Strg+N" },
          ...sessions.slice(0, 30).map((s) => ({
            label: s.title ?? "Ohne Titel",
            hint: relativeTime(s.updatedAt),
            icon: <span className={cn("h-1.5 w-1.5 rounded-full", s.live ? "bg-accent" : "bg-subtle")} />,
            onSelect: () => onSelect(s.id),
          })),
          ...externals.slice(0, 15).map((e) => ({
            label: e.summary,
            hint: "Terminal",
            icon: <Terminal className="h-3.5 w-3.5 text-muted" />,
            onSelect: () => onSelect(EXTERNAL_PREFIX + e.claudeSessionId),
          })),
        ]}
      />
      {session && <SessionStatusBadge status={session.status} live={session.live} />}
      {!!session?.background.length && (
        <Tooltip content={session.background.map((t) => t.description).join(", ")}>
          <span>
            <Badge tone="accent">
              <Hourglass className="h-3 w-3" /> {session.background.length} im Hintergrund
            </Badge>
          </span>
        </Tooltip>
      )}
      {session?.permissionMode === "plan" && <Badge tone="accent">Nur planen</Badge>}
      {session?.permissionMode === "bypassPermissions" && (
        <Badge tone="danger">
          <ShieldAlert className="h-3 w-3" /> Bypass
        </Badge>
      )}
      <div className="flex-1" />
      {session?.apiKeySource && session.apiKeySource !== "none" && (
        <Badge tone="warning" className="max-w-56 truncate">
          Auth: {session.apiKeySource}
        </Badge>
      )}
      {session && session.cwd !== project.path && (
        <Badge tone="warning" className="max-w-64 truncate">
          cwd: {session.cwd}
        </Badge>
      )}
      {session && <SummaryButton sessionId={session.id} title={session.title} size="icon-sm" />}
      {session?.live && (session.status === "idle" || session.status === "error") && (
        <Button
          size="sm"
          variant="ghost"
          title={
            session.background.length
              ? "Claude-Prozess beenden. Bricht auch die Aufgaben im Hintergrund ab. Die Session bleibt fortsetzbar."
              : "Claude-Prozess dieser Session beenden. Sie bleibt fortsetzbar."
          }
          onClick={() => call("sessions.close", { sessionId: session.id }).catch((e: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(e)))}
        >
          <Power className="h-3.5 w-3.5" /> Beenden
        </Button>
      )}
      {session && (
        <Tooltip content="Session löschen">
          <Button size="icon-sm" variant="ghost" aria-label="Session löschen" className="hover:text-danger" onClick={() => setDeleting(true)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      )}
      <Button size="sm" variant="ghost" onClick={() => onSelect(null)} title="Neue Session (Strg+N)">
        <MessageSquarePlus className="h-3.5 w-3.5" /> Neu
      </Button>
      <DeleteSessionDialog session={deleting ? session : null} onClose={() => setDeleting(false)} />
    </div>
  );
}

function NewSessionPane({ project, external }: { project: Project; external: ExternalSession | null }) {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {external ? (
          <EmptyState icon={<Terminal className="h-9 w-9" />} title="Session aus dem Terminal fortsetzen">
            „{external.summary}“, zuletzt {relativeTime(external.lastModified)}
            {external.gitBranch ? ` auf ${external.gitBranch}` : ""}. Schreibe eine Nachricht, um sie in FORGE weiterzuführen. Der bisherige Verlauf wird übernommen.
          </EmptyState>
        ) : (
          <EmptyState icon={<MessageSquarePlus className="h-9 w-9" />} title={`Neue Session in ${project.name}`}>
            Claude Code arbeitet im Projektordner mit Profil {project.profile === "safe" ? "Safe" : project.profile === "balanced" ? "Balanced" : "Autonomous"}. CLAUDE.md und
            die Projekt-Einstellungen aus .claude/ werden berücksichtigt.
          </EmptyState>
        )}
      </div>
      <Composer key={external?.claudeSessionId ?? "new"} project={project} session={null} resumeClaudeSessionId={external?.claudeSessionId} />
    </>
  );
}

function SessionThread({ sessionId, session, project, workingInPanel }: { sessionId: string; session: Session | null; project: Project; workingInPanel: boolean }) {
  const buffer = useSessionHistory(sessionId);
  const items = useMemo(() => buildChatItems(buffer?.events ?? [], buffer?.streaming ?? {}), [buffer?.events, buffer?.streaming]);
  const retryPrompt = useMemo(() => lastUserPrompt(buffer?.events ?? []), [buffer?.events]);
  const working = session?.status === "running" || session?.status === "starting";
  const startedAt = useMemo(() => (working ? (turnStartedAt(buffer?.events ?? []) ?? session?.updatedAt ?? null) : null), [working, buffer?.events, session?.updatedAt]);
  const [retryText, setRetryText] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (i) => items[i]!.key,
  });

  // A search hit asked for this session: scroll to the message once the history is there.
  const focus = useUi((s) => s.focusEvent);
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (!focus || focus.sessionId !== sessionId || !buffer?.loaded) return;
    useUi.getState().setFocusEvent(null);
    const i = itemIndexForSeq(items, focus.seq);
    if (i < 0) return;
    pinned.current = false;
    virtualizer.scrollToIndex(i, { align: "center" });
    // Item heights are measured while scrolling; a second pass lands on the final position.
    requestAnimationFrame(() => virtualizer.scrollToIndex(i, { align: "center" }));
    setHighlight(items[i]!.key);
  }, [focus, sessionId, buffer?.loaded, items, virtualizer]);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), 2500);
    return () => clearTimeout(t);
  }, [highlight]);

  // Follow new content only while pinned, and only when the content actually grew. Scrolling
  // on every render fought the user: the virtualizer re-renders during a scroll before onScroll runs.
  const lastHeight = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinned.current && el.scrollHeight > lastHeight.current) el.scrollTop = el.scrollHeight;
    lastHeight.current = el.scrollHeight;
  });

  if (!buffer?.loaded) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loading />
      </div>
    );
  }

  return (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onWheel={(e) => {
          if (e.deltaY < 0) pinned.current = false;
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className="relative mx-auto w-full max-w-4xl" style={{ height: virtualizer.getTotalSize() + 24 }}>
          {virtualizer.getVirtualItems().map((v) => (
            <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute left-0 right-0 px-6 pt-4" style={{ transform: `translateY(${v.start}px)` }}>
              <div className={cn("rounded-lg transition-shadow duration-500", highlight === items[v.index]!.key && "ring-2 ring-accent/60 ring-offset-4 ring-offset-bg")}>
              <ItemView
                item={items[v.index]!}
                sessionId={sessionId}
                live={!!session?.live}
                projectDir={session?.cwd ?? project.path}
                onRetry={retryPrompt && !working ? () => setRetryText(retryPrompt) : undefined}
              />
              </div>
            </div>
          ))}
        </div>
        {startedAt && !workingInPanel && <WorkingIndicator startedAt={startedAt} />}
        {!!session?.background.length && <BackgroundIndicator tasks={session.background} />}
      </div>
      <Composer project={project} session={session} prefill={retryText} onPrefillConsumed={() => setRetryText(null)} />
    </>
  );
}

function ItemView({ item, sessionId, live, projectDir, onRetry }: { item: ChatItem; sessionId: string; live: boolean; projectDir: string; onRetry?: () => void }) {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} sessionId={sessionId} />;
    case "assistant":
      return (
        <div className="flex gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-claude-soft">
            <ClaudeMark size={20} />
          </div>
          <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 py-3">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <Markdown text={item.text} />
                {item.streaming && <span className="animate-soft-pulse ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent" aria-label="schreibt" />}
              </div>
              {item.ts && <span className="shrink-0 pt-0.5 text-[11.5px] text-subtle">{clockTime(item.ts)}</span>}
            </div>
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="pl-12">
          <ToolCard item={item} sessionId={sessionId} sessionLive={live} projectDir={projectDir} />
        </div>
      );
    case "approval":
      if (item.req.toolName === "AskUserQuestion" || item.req.toolName === "ExitPlanMode") {
        // The approval came without a preceding tool event; show the same card as usual.
        const tool: Extract<ChatItem, { kind: "tool" }> = {
          kind: "tool",
          key: item.key,
          ts: item.ts,
          use: { type: "tool.use", toolUseId: item.req.toolUseId, name: item.req.toolName, input: item.req.input, parentToolUseId: null },
          result: null,
          approval: { req: item.req, resolved: item.resolved },
          blocked: null,
          todos: null,
          superseded: false,
        };
        return <div className="pl-12">{item.req.toolName === "AskUserQuestion" ? <QuestionCard item={tool} sessionId={sessionId} /> : <PlanCard item={tool} sessionId={sessionId} />}</div>;
      }
      return (
        <div className="ml-12 overflow-hidden rounded-xl border border-warning/50">
          <ApprovalBlock req={item.req} resolved={item.resolved} sessionId={sessionId} projectDir={projectDir} />
        </div>
      );
    case "blocked":
      return (
        <div className="ml-12 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-[13px]">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 text-danger" /> Von der FORGE-Policy blockiert ({item.body.toolName}): {item.body.message}
        </div>
      );
    case "result":
      return <ResultLine body={item.body} onRetry={onRetry} />;
    case "error":
      return (
        <div className="ml-12 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger-soft px-3.5 py-2.5 text-[13.5px]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1 break-words">{item.message}</div>
          {item.retryable && onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RotateCcw className="h-3.5 w-3.5" /> Erneut senden
            </Button>
          )}
        </div>
      );
    case "notice":
      if (item.card)
        return <EventCard icon={noticeIcon(item.card.icon)} tone={item.tone} title={item.card.title} refText={item.card.ref} detail={item.card.detail} ts={item.ts} />;
      return (
        <div
          className={cn(
            "ml-12 flex items-center gap-2 text-[12.5px]",
            item.tone === "warning" ? "text-warning" : item.tone === "danger" ? "text-danger" : item.tone === "success" ? "text-success" : "text-muted",
          )}
        >
          <Info className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{item.text}</span>
        </div>
      );
    case "check":
      return <CheckCard body={item.body} ts={item.ts} />;
  }
}

function CheckCard({ body, ts }: { body: Extract<ChatItem, { kind: "check" }>["body"]; ts: string }) {
  return (
    <EventCard
      icon={body.ok ? <CheckCircle2 className="h-[18px] w-[18px]" /> : <XCircle className="h-[18px] w-[18px]" />}
      tone={body.ok ? "success" : "danger"}
      title={body.ok ? "Tests erfolgreich" : "Tests fehlgeschlagen"}
      refText={body.command}
      detail={formatDuration(body.durationMs)}
      ts={ts}
      defaultOpen={!body.ok}
    >
      {body.output ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all bg-bg p-3 font-mono text-[11.5px] text-muted">{body.output}</pre> : undefined}
    </EventCard>
  );
}

function ResultLine({ body, onRetry }: { body: Extract<ChatItem, { kind: "result" }>["body"]; onRetry?: () => void }) {
  const interrupted = body.isError && /interrupt|abgebrochen|aborted/i.test(`${body.subtype} ${body.text ?? ""}`);
  return (
    <div className="ml-12 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 pt-1 text-[11.5px] text-subtle">
      {body.isError ? (
        interrupted ? (
          <span className="text-warning">Gestoppt</span>
        ) : (
          <span className="text-danger">Fehlgeschlagen: {body.text ?? body.subtype}</span>
        )
      ) : (
        <span className="text-success">Fertig</span>
      )}
      {body.durationMs !== null && (
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" /> {formatDuration(body.durationMs)}
        </span>
      )}
      {body.numTurns !== null && <span>{body.numTurns} {body.numTurns === 1 ? "Schritt" : "Schritte"}</span>}
      {(body.inputTokens !== null || body.outputTokens !== null) && (
        <span title="Laut Claude Code gemeldete Tokens dieses Durchlaufs (ohne Cache-Lesezugriffe)">
          Tokens: {formatTokens(body.inputTokens)} rein, {formatTokens(body.outputTokens)} raus
        </span>
      )}
      {body.isError && !interrupted && onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RotateCcw className="h-3 w-3" /> Erneut senden
        </Button>
      )}
    </div>
  );
}

function UserMessage({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId: string }) {
  const [preview, setPreview] = useState<RewindResult | null>(null);
  const [loading, setLoading] = useState(false);
  const check = async () => {
    if (!item.uuid) return;
    setLoading(true);
    try {
      const r = await call("sessions.rewind", { sessionId, messageUuid: item.uuid, dryRun: true });
      if (!r.canRewind) toast.info("Nichts zurückzusetzen", r.error ?? "Seit dieser Nachricht hat Claude keine Dateien geändert.");
      else setPreview(r);
    } catch (e) {
      toast.error("Prüfung fehlgeschlagen", errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="group relative flex gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent-soft text-[12px] font-semibold text-accent">Du</div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3">
        {item.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.attachments.map((a, i) => (
              <span key={i} className="flex items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] text-muted">
                {a.mediaType.startsWith("image/") ? <ImageIcon className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                {a.name}
              </span>
            ))}
          </div>
        )}
        <div className="flex min-w-0 items-start gap-4">
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed">{item.text}</div>
          <div className="flex shrink-0 items-center gap-1 pt-0.5 text-[11.5px] text-subtle">
            {item.remote && (
              <span className="flex items-center gap-0.5" title="In der Claude-App geschrieben">
                <Smartphone className="h-3 w-3" /> App
              </span>
            )}
            {clockTime(item.ts)}
          </div>
        </div>
      </div>
      {item.uuid && (
        <Tooltip content="Dateien auf den Stand vor dieser Nachricht zurücksetzen">
          <Button size="icon-sm" variant="ghost" className="absolute -right-9 top-1.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void check()} loading={loading} aria-label="Dateien auf diesen Stand zurücksetzen">
            {!loading && <Undo2 className="h-3.5 w-3.5" />}
          </Button>
        </Tooltip>
      )}
      <ConfirmDialog
        open={!!preview}
        onOpenChange={(o) => !o && setPreview(null)}
        title="Dateien zurücksetzen?"
        description="Alle Dateiänderungen, die Claude seit dieser Nachricht gemacht hat, werden rückgängig gemacht. Der Chatverlauf bleibt erhalten."
        confirmLabel="Zurücksetzen"
        danger
        onConfirm={async () => {
          if (!item.uuid) return;
          try {
            const r = await call("sessions.rewind", { sessionId, messageUuid: item.uuid, dryRun: false });
            if (r.canRewind) toast.success("Zurückgesetzt", `${r.filesChanged.length} Datei(en)`);
            else toast.error("Nicht zurückgesetzt", r.error ?? "");
          } catch (e) {
            toast.error("Nicht zurückgesetzt", errorMessage(e));
          }
        }}
      >
        <div className="text-xs text-muted">
          +{preview?.insertions ?? 0} / -{preview?.deletions ?? 0} Zeilen
        </div>
        <ul className="mt-2 max-h-48 overflow-y-auto font-mono text-xs">
          {preview?.filesChanged.map((f) => (
            <li key={f} className="truncate py-0.5">
              {f}
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

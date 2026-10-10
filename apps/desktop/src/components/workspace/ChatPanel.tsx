import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, CheckCircle2, ChevronDown, Clock, FileText, History, ImageIcon, Info, MessageSquarePlus, Power, RotateCcw, ShieldAlert, Smartphone, Terminal, Undo2, XCircle } from "lucide-react";
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
import { buildChatItems, lastUserPrompt, type ChatItem } from "./chat-items";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { ApprovalBlock, ToolCard } from "./ToolCard";
import { SessionStatusBadge } from "./SessionStatusBadge";
import { ClaudeMark } from "./ClaudeMark";
import { SummaryButton } from "./SummaryButton";
import { SessionTabs } from "./SessionTabs";

/** activeSession values starting with this prefix point at a terminal session not yet adopted by FORGE */
export const EXTERNAL_PREFIX = "ext:";

export function ChatPanel({ project }: { project: Project }) {
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
        <SessionThread key={sessionId} sessionId={sessionId} session={session.data ?? null} project={project} />
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
          title="Claude-Prozess dieser Session beenden. Sie bleibt fortsetzbar."
          onClick={() => call("sessions.close", { sessionId: session.id }).catch((e: unknown) => toast.error("Beenden fehlgeschlagen", errorMessage(e)))}
        >
          <Power className="h-3.5 w-3.5" /> Beenden
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => onSelect(null)} title="Neue Session (Strg+N)">
        <MessageSquarePlus className="h-3.5 w-3.5" /> Neu
      </Button>
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

function SessionThread({ sessionId, session, project }: { sessionId: string; session: Session | null; project: Project }) {
  const buffer = useSessionHistory(sessionId);
  const items = useMemo(() => buildChatItems(buffer?.events ?? [], buffer?.streaming ?? {}), [buffer?.events, buffer?.streaming]);
  const retryPrompt = useMemo(() => lastUserPrompt(buffer?.events ?? []), [buffer?.events]);
  const lastEvent = buffer?.events.at(-1)?.body;
  const working = session?.status === "running" || session?.status === "starting";
  const thinking = working && (lastEvent?.type === "assistant.thinking" || lastEvent?.type === "user.message" || lastEvent?.type === "session.init" || lastEvent?.type === "status");
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
            <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className="absolute left-0 right-0 px-6 pt-3" style={{ transform: `translateY(${v.start}px)` }}>
              <ItemView
                item={items[v.index]!}
                sessionId={sessionId}
                live={!!session?.live}
                projectDir={session?.cwd ?? project.path}
                onRetry={retryPrompt && !working ? () => setRetryText(retryPrompt) : undefined}
              />
            </div>
          ))}
        </div>
        {thinking && (
          <div className="mx-auto flex max-w-4xl items-center gap-2 px-6 pb-4 text-xs text-muted">
            <span className="animate-soft-pulse h-2 w-2 rounded-full bg-accent" /> Claude denkt nach …
          </div>
        )}
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
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-claude-soft">
            <ClaudeMark size={18} />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <Markdown text={item.text} />
            {item.streaming && <span className="animate-soft-pulse ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent" aria-label="schreibt" />}
          </div>
        </div>
      );
    case "tool":
      return (
        <div className="pl-10">
          <ToolCard item={item} sessionId={sessionId} sessionLive={live} projectDir={projectDir} />
        </div>
      );
    case "approval":
      return (
        <div className="overflow-hidden rounded-lg border border-warning/50 pl-0">
          <ApprovalBlock req={item.req} resolved={item.resolved} sessionId={sessionId} projectDir={projectDir} />
        </div>
      );
    case "blocked":
      return (
        <div className="ml-10 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-xs">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 text-danger" /> Von der FORGE-Policy blockiert ({item.body.toolName}): {item.body.message}
        </div>
      );
    case "result":
      return <ResultLine body={item.body} onRetry={onRetry} />;
    case "error":
      return (
        <div className="ml-10 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[13px]">
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
      return (
        <div
          className={cn(
            "ml-10 flex items-center gap-2 text-xs",
            item.tone === "warning" ? "text-warning" : item.tone === "danger" ? "text-danger" : item.tone === "success" ? "text-success" : "text-muted",
          )}
        >
          <Info className="h-3.5 w-3.5 shrink-0" /> <span className="min-w-0 break-words">{item.text}</span>
        </div>
      );
    case "check":
      return <CheckCard body={item.body} />;
  }
}

function CheckCard({ body }: { body: Extract<ChatItem, { kind: "check" }>["body"] }) {
  const [open, setOpen] = useState(!body.ok);
  return (
    <div className={cn("ml-10 rounded-lg border bg-surface", body.ok ? "border-success/30" : "border-danger/40")}>
      <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]" onClick={() => setOpen(!open)} aria-expanded={open}>
        {body.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
        <span className="font-medium">{body.ok ? "Tests grün" : "Tests fehlgeschlagen"}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{body.command}</span>
        <span className="text-[11px] text-subtle">{formatDuration(body.durationMs)}</span>
      </button>
      {open && body.output && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-bg p-2 font-mono text-[11px] text-muted">{body.output}</pre>
      )}
    </div>
  );
}

function ResultLine({ body, onRetry }: { body: Extract<ChatItem, { kind: "result" }>["body"]; onRetry?: () => void }) {
  const interrupted = body.isError && /interrupt|abgebrochen|aborted/i.test(`${body.subtype} ${body.text ?? ""}`);
  return (
    <div className="ml-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-[11px] text-subtle">
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
    <div className="group flex gap-3">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-muted">Du</div>
      <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5">
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
        <div className="flex w-fit min-w-0 max-w-full items-end gap-3 rounded-lg border border-border bg-surface-2 px-3 py-1.5">
          <div className="min-w-0 whitespace-pre-wrap break-words text-[13.5px]">{item.text}</div>
          <div className="flex shrink-0 items-center gap-1 pb-px text-[11px] text-subtle">
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
          <Button size="icon-sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void check()} loading={loading} aria-label="Dateien auf diesen Stand zurücksetzen">
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

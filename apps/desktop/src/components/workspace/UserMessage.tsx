import { useState } from "react";
import { Bot, Copy, FilePlus2, FileText, GitBranch, ImageIcon, Pencil, Smartphone, SquareSlash, SquareTerminal, TimerReset, Undo2 } from "lucide-react";
import { contextItems, copyText } from "@/lib/context-menu";
import type { RewindResult, TaskMessageRef } from "@forge/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { call, keys, useGitHubAccount, useSession, useSettings } from "@/lib/queries";
import { draftKey, useDrafts } from "@/stores/drafts";
import { useMessageEdit } from "@/stores/message-edit";
import { useTemplateDialogs } from "@/stores/templates";
import { Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/rpc";
import { clockTime, cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi, type TaskView } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ToggleRow, Tooltip } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { isSlashCommand, type ChatItem } from "./chat-items";
import { ChatRow, HoverTime } from "./ChatRow";
import { withUltrathink } from "./ultrathink";
import { useChatSlot } from "./chat-slot";
import { t } from "@/i18n";

/** A prompt of the user, with rewinding the files to the state before it and branching the conversation there. */
export function UserMessage({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId: string }) {
  const [preview, setPreview] = useState<RewindResult | null>(null);
  const [forkOpen, setForkOpen] = useState(false);
  const [forkFiles, setForkFiles] = useState(false);
  const projectId = useSession(sessionId).data?.projectId ?? null;
  const slot = useChatSlot();
  const qc = useQueryClient();
  const fork = async () => {
    if (!projectId) return;
    try {
      const r = await call("sessions.fork", { sessionId, beforeSeq: item.seq, rewindFiles: forkFiles });
      const target = r.session?.id ?? null;
      if (r.session) qc.setQueryData(keys.session(r.session.id), r.session);
      void qc.invalidateQueries({ queryKey: keys.sessions(projectId) });
      // The prompt waits in the composer of the branch, to be changed and sent again.
      useDrafts.getState().setText(draftKey(projectId, target, undefined, slot.pane), r.prompt ?? "");
      slot.select(projectId, target);
      toast.success(
        r.session ? t.chat.user.forked : t.chat.user.startedOver,
        [r.session ? t.chat.user.forkedDetail : t.chat.user.startedOverDetail, r.filesChanged ? t.chat.user.filesReset(r.filesChanged.length) : ""]
          .filter(Boolean)
          .join(" "),
      );
    } catch (e) {
      toast.error(t.chat.user.forkFailed, errorMessage(e));
      throw e;
    }
  };
  const [loading, setLoading] = useState(false);
  const check = async () => {
    if (!item.uuid) return;
    setLoading(true);
    try {
      const r = await call("sessions.rewind", { sessionId, messageUuid: item.uuid, dryRun: true });
      if (!r.canRewind) toast.info(t.chat.user.nothingToRewind, r.error ?? t.chat.user.nothingToRewindDetail);
      else setPreview(r);
    } catch (e) {
      toast.error(t.chat.user.checkFailed, errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  const editing = useMessageEdit((s) => s.target?.sessionId === sessionId && s.target.seq === item.seq);
  // Editing would send the text again without the note that names the task.
  const canEdit = !!item.uuid && !item.auto && !item.task;
  const taskView = item.task ? taskViewFor(item.task, sessionId) : null;
  // Images show as name chips: loading them back from the transcript was slow or failed.
  const chips = item.attachments;
  const hasMeta = chips.length > 0 || item.auto || item.edited;
  if (!chips.length && isSlashCommand(item.text) && !editing) return <CommandMessage item={item} />;
  return (
    <div
      className={cn("group -mx-3 rounded-md px-3 py-2.5", item.remote ? "border border-accent/30 bg-accent-soft" : "bg-surface-2")}
      onContextMenu={contextItems(() =>
        editing
          ? []
          : [
              { label: t.chat.user.copy, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(item.text) },
              ...(taskView ? [{ label: t.chat.user.openTask, icon: taskIcon(taskView.kind), onSelect: () => useUi.getState().openTask(taskView) }] : []),
              ...(item.text.trim() ? [{ label: t.chat.user.saveAsTemplate, icon: <FilePlus2 className="h-3.5 w-3.5" />, onSelect: () => useTemplateDialogs.getState().openEdit({ id: null, text: item.text }) }] : []),
              ...(canEdit ? [{ label: t.chat.user.edit, icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => useMessageEdit.getState().start(sessionId, item.seq) }] : []),
              ...(item.uuid
                ? [
                    { label: t.chat.user.fork, icon: <GitBranch className="h-3.5 w-3.5" />, onSelect: () => setForkOpen(true) },
                    { label: t.chat.user.rewind, icon: <Undo2 className="h-3.5 w-3.5" />, onSelect: () => void check() },
                  ]
                : []),
            ],
      )}
    >
      <ChatRow className="text-ui leading-[1.65]" marker={item.remote ? <PhoneAvatar /> : <UserAvatar />}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="min-w-0 flex-1">
            {item.remote && <RemoteLabel />}
            {item.task && <TaskLabel task={item.task} view={taskView} />}
            {editing ? <MessageEditor item={item} sessionId={sessionId} /> : <div className="whitespace-pre-wrap break-words">{withUltrathink(item.text)}</div>}
            {hasMeta && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-caption leading-normal text-subtle">
                {chips.map((a, i) => (
                  <span key={i} className="flex items-center gap-1 rounded-sm border border-border bg-surface px-1.5 py-0.5 text-muted">
                    {a.mediaType.startsWith("image/") ? <ImageIcon className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                    {a.name}
                  </span>
                ))}
                {item.auto && (
                  <span className="flex items-center gap-1" title={t.chat.user.autoTitle}>
                    <TimerReset className="h-3 w-3" /> {t.chat.user.auto}
                  </span>
                )}
                {item.edited && (
                  <span className="flex items-center gap-1" title={t.chat.user.editedTitle}>
                    <Pencil className="h-3 w-3" /> {t.chat.user.edited}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="ml-auto flex h-[1lh] shrink-0 items-center gap-1">
            <HoverTime time={clockTime(item.ts)} />
            {canEdit && !editing && (
              <Tooltip content={t.chat.user.editTooltip}>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => useMessageEdit.getState().start(sessionId, item.seq)}
                  aria-label={t.chat.user.editLabel}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
            {item.uuid && (
              <Tooltip content={t.chat.user.forkTooltip}>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => setForkOpen(true)}
                  aria-label={t.chat.user.fork}
                >
                  <GitBranch className="h-3.5 w-3.5" />
                </Button>
              </Tooltip>
            )}
            {item.uuid && (
              <Tooltip content={t.chat.user.rewindTooltip}>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className={cn("opacity-0 group-hover:opacity-100 focus-visible:opacity-100", loading && "opacity-100")}
                  onClick={() => void check()}
                  loading={loading}
                  aria-label={t.chat.user.rewind}
                >
                  {!loading && <Undo2 className="h-3.5 w-3.5" />}
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      </ChatRow>
      <ConfirmDialog
        open={forkOpen}
        onOpenChange={(o) => {
          setForkOpen(o);
          if (!o) setForkFiles(false);
        }}
        title={t.chat.user.forkConfirmTitle}
        description={t.chat.user.forkConfirmDescription}
        confirmLabel={t.chat.user.forkConfirm}
        onConfirm={fork}
      >
        <ToggleRow checked={forkFiles} onChange={setForkFiles} label={t.chat.user.forkRewindFiles}>
          {t.chat.user.forkRewindFilesHint}
        </ToggleRow>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!preview}
        onOpenChange={(o) => !o && setPreview(null)}
        title={t.chat.user.rewindConfirmTitle}
        description={t.chat.user.rewindConfirmDescription}
        confirmLabel={t.chat.user.rewindConfirm}
        danger
        onConfirm={async () => {
          if (!item.uuid) return;
          try {
            const r = await call("sessions.rewind", { sessionId, messageUuid: item.uuid, dryRun: false });
            if (r.canRewind) toast.success(t.chat.user.rewound, t.chat.user.files(r.filesChanged.length));
            else toast.error(t.chat.user.rewindFailed, r.error ?? "");
          } catch (e) {
            toast.error(t.chat.user.rewindFailed, errorMessage(e));
            throw e;
          }
        }}
      >
        <div className="text-xs text-muted">
          {t.chat.user.lineStats(preview?.insertions ?? 0, preview?.deletions ?? 0)}
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

/** A slash command runs in Claude Code instead of going to Claude: one slim line like in the terminal, no bubble. */
function CommandMessage({ item }: { item: Extract<ChatItem, { kind: "user" }> }) {
  return (
    <ChatRow className="group text-body" marker={<SquareSlash className="h-3.5 w-3.5 text-subtle" />}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-muted" title={item.text}>
          {item.text.trim()}
        </span>
        {item.remote && (
          <span className="flex shrink-0 items-center gap-1 rounded-sm bg-accent/15 px-1.5 py-0.5 text-caption font-medium text-accent" title={t.chat.user.fromPhoneTitle}>
            <Smartphone className="h-3 w-3" /> {t.chat.user.fromPhone}
          </span>
        )}
        <HoverTime time={clockTime(item.ts)} />
      </div>
    </ChatRow>
  );
}

/** Edits a sent prompt in place; sending stops a running turn and lets Claude go on with the new text. */
function MessageEditor({ item, sessionId }: { item: Extract<ChatItem, { kind: "user" }>; sessionId: string }) {
  const [text, setText] = useState(item.text);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const status = useSession(sessionId).data?.status;
  const enterToSend = useSettings().data?.enterToSend ?? true;
  const stop = useMessageEdit((s) => s.stop);
  const running = status === "starting" || status === "running" || status === "waiting_approval";
  const save = async () => {
    const next = text.trim();
    if (!next || busy) return;
    if (next === item.text.trim()) return stop();
    setBusy(true);
    try {
      qc.setQueryData(keys.session(sessionId), await call("sessions.edit", { sessionId, seq: item.seq, text: next }));
      stop();
    } catch (e) {
      toast.error(t.chat.user.editFailed, errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <div>
      <Textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.setSelectionRange(e.currentTarget.value.length, e.currentTarget.value.length)}
        rows={Math.min(12, Math.max(2, text.split("\n").length))}
        className="text-ui leading-[1.65]"
        aria-label={t.chat.user.editLabel}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            stop();
          }
          if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
          if (enterToSend ? !e.shiftKey && !e.ctrlKey : e.ctrlKey || e.metaKey) {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-caption leading-normal text-subtle">
          {t.chat.user.editHint(running, item.attachments.length > 0)}
        </span>
        <Button size="sm" variant="ghost" onClick={stop} disabled={busy}>
          {t.chat.cards.cancel}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} loading={busy} disabled={!text.trim()}>
          {t.chat.composer.sendLabel}
        </Button>
      </div>
    </div>
  );
}

/** What opens the task a message was written to; a subagent's history needs its Agent call. */
function taskViewFor(task: TaskMessageRef, sessionId: string): TaskView | null {
  if (task.kind === "agent") return task.toolUseId ? { kind: "agent", sessionId, toolUseId: task.toolUseId, title: task.description } : null;
  return { kind: "shell", sessionId, taskId: task.taskId, toolUseId: task.toolUseId, title: task.description };
}

function taskIcon(kind: TaskMessageRef["kind"]) {
  return kind === "agent" ? <Bot className="h-3.5 w-3.5" /> : <SquareTerminal className="h-3.5 w-3.5" />;
}

/** Above a message written to a background task; opens the task. */
function TaskLabel({ task, view }: { task: TaskMessageRef; view: TaskView | null }) {
  const label = (
    <>
      {task.kind === "agent" ? <Bot className="h-3 w-3 shrink-0" /> : <SquareTerminal className="h-3 w-3 shrink-0" />}
      <span className="shrink-0">{task.kind === "agent" ? t.chat.user.toSubagent : t.chat.user.toTask}</span>
      <span className="min-w-0 truncate font-medium text-muted">{task.description}</span>
    </>
  );
  const cls = "mb-1 flex max-w-full items-center gap-1.5 text-caption leading-normal text-subtle";
  if (!view) return <div className={cls}>{label}</div>;
  return (
    <button
      type="button"
      className={`${cls} underline-offset-2 hover:text-fg hover:underline`}
      title={task.kind === "agent" ? t.chat.working.openSubagentHistory : t.chat.tool.viewOutput}
      onClick={() => useUi.getState().openTask(view)}
    >
      {label}
    </button>
  );
}

/** Above a prompt typed on the phone in the Claude app (Remote Control). */
function RemoteLabel() {
  return (
    <div className="mb-1 flex items-center gap-1.5 text-caption leading-normal">
      <span className="inline-flex items-center gap-1 rounded-sm bg-accent/15 px-1.5 py-0.5 font-medium text-accent">
        <Smartphone className="h-3 w-3" /> {t.chat.user.fromPhone}
      </span>
      <span className="text-subtle">{t.chat.user.inClaudeApp}</span>
    </div>
  );
}

/** Your avatar with a phone badge, for prompts from the Claude app. */
function PhoneAvatar() {
  return (
    <span className="relative flex shrink-0">
      <UserAvatar />
      <span aria-label={t.chat.user.fromPhone} role="img" className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-accent text-accent-fg ring-2 ring-bg">
        <Smartphone className="h-2.5 w-2.5" />
      </span>
    </span>
  );
}

/** Your GitHub picture when gh is signed in, otherwise a "Du" badge. */
export function UserAvatar() {
  const avatarUrl = useGitHubAccount().data?.avatarUrl;
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return <img src={avatarUrl} alt={t.chat.user.you} width={22} height={22} className="h-5.5 w-5.5 shrink-0 rounded-full border border-border" onError={() => setFailed(true)} />;
  }
  return (
    <span aria-label={t.chat.user.you} role="img" className="flex h-5.5 w-5.5 shrink-0 items-center justify-center rounded-full border border-accent/25 bg-accent-soft text-3xs font-semibold text-accent">
      {t.chat.user.you}
    </span>
  );
}

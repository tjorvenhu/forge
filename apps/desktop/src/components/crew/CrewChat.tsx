import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowDownToLine, CheckCircle2, ClipboardList, Copy, FileText, GitCommitHorizontal, LogIn, LogOut, MessageSquare, Send } from "lucide-react";
import type { Crew, CrewFeedItem } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { crewChanged, memberName, others, useCrewRead } from "@/lib/crew";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { MemberAvatar } from "./CrewDialogs";
import { t } from "@/i18n";

const m = t.crew;
const EVERYONE = "*";
/** messages of one person within this time read as one block (avatar and name once) */
const GROUP_MS = 5 * 60_000;

/** id of the message field of the Crew tab, so the palette and the member menu can put the cursor there */
export const CREW_MESSAGE_INPUT = "crew-message-input";

function dayLabel(ts: string): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return m.today;
  if (d.toDateString() === yesterday.toDateString()) return m.yesterday;
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

const time = (ts: string) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; item: CrewFeedItem; head: boolean; own: boolean }
  | { kind: "event"; key: string; item: CrewFeedItem };

/** The feed as a conversation: oldest first, day separators, messages grouped by sender. */
function rows(crew: Crew): Row[] {
  const out: Row[] = [];
  let day = "";
  let prev: CrewFeedItem | null = null;
  for (const item of crew.feed) {
    const d = new Date(item.ts).toDateString();
    if (d !== day) {
      day = d;
      out.push({ kind: "day", key: `day-${d}`, label: dayLabel(item.ts) });
      prev = null;
    }
    if (item.kind === "message") {
      const head = !prev || prev.kind !== "message" || prev.from !== item.from || prev.to !== item.to || Date.parse(item.ts) - Date.parse(prev.ts) > GROUP_MS;
      out.push({ kind: "message", key: item.id, item, head, own: item.from === crew.selfId });
    } else out.push({ kind: "event", key: item.id, item });
    prev = item;
  }
  return out;
}

/**
 * The crew's chat: messages and what happened (pushes, finished agents, joins) in one conversation,
 * newest at the bottom, with the message field below. In the Crew tab and in the bubble.
 */
export function CrewChat({ crew, to, onTo, inputId, autoFocus = false, className }: { crew: Crew; to: string | null; onTo: (id: string | null) => void; inputId?: string; autoFocus?: boolean; className?: string }) {
  const list = useMemo(() => rows(crew), [crew]);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [behind, setBehind] = useState(false);
  const markRead = useCrewRead((s) => s.markRead);
  const newest = crew.feed.at(-1)?.ts;

  // Shown means read: the newest message counts as seen while the chat is on screen.
  useEffect(() => {
    if (newest) markRead(crew.id, newest);
  }, [crew.id, newest, markRead]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pinned.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [list.length]);

  const toEnd = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    pinned.current = true;
    setBehind(false);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          className="h-full overflow-y-auto px-3 py-3"
          onScroll={(e) => {
            const el = e.currentTarget;
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (pinned.current) setBehind(false);
          }}
        >
          {list.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <MessageSquare className="h-7 w-7 text-subtle" />
              <p className="max-w-sm text-xs text-muted">{m.chatEmpty}</p>
            </div>
          ) : (
            <ol className="flex flex-col">
              {list.map((r) =>
                r.kind === "day" ? (
                  <li key={r.key} className="my-2 flex items-center gap-3 text-caption-lg text-subtle">
                    <span className="h-px flex-1 bg-border" />
                    {r.label}
                    <span className="h-px flex-1 bg-border" />
                  </li>
                ) : r.kind === "message" ? (
                  <MessageRow key={r.key} crew={crew} item={r.item} head={r.head} own={r.own} onReply={() => onTo(r.item.from)} />
                ) : (
                  <EventRow key={r.key} crew={crew} item={r.item} />
                ),
              )}
            </ol>
          )}
        </div>
        {behind && (
          <button type="button" onClick={toEnd} className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-caption-lg text-fg shadow-md hover:bg-surface-3">
            <ArrowDown className="h-3 w-3" /> {m.jumpToNew}
          </button>
        )}
      </div>
      <ChatComposer crew={crew} to={to} onTo={onTo} inputId={inputId} autoFocus={autoFocus} />
    </div>
  );
}

function MessageRow({ crew, item, head, own, onReply }: { crew: Crew; item: CrewFeedItem; head: boolean; own: boolean; onReply: () => void }) {
  const from = crew.members.find((x) => x.id === item.from);
  const color = from?.color ?? "var(--color-subtle)";
  const privateNote = item.to ? (own ? m.privateTo(memberName(crew, item.to)) : m.privateFrom) : null;
  return (
    <li
      className={cn("group flex gap-2 animate-rise-in", own ? "flex-row-reverse" : "flex-row", head ? "mt-2.5" : "mt-0.5")}
      onContextMenu={contextItems(() => [
        { label: m.copyMessage, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(item.text) },
        ...(from && !from.self ? [{ label: m.messageTo(from.name), icon: <MessageSquare className="h-3.5 w-3.5" />, onSelect: onReply }] : []),
      ])}
    >
      <div className="w-7 shrink-0">{head && !own && <MemberAvatar name={from?.name ?? "?"} color={color} avatar={from?.avatar} size={28} />}</div>
      <div className={cn("flex min-w-0 max-w-[80%] flex-col", own ? "items-end" : "items-start")}>
        {head && (
          <div className={cn("mb-0.5 flex items-baseline gap-1.5 px-1 text-caption-lg", own && "flex-row-reverse")}>
            {!own && (
              <span className="font-semibold" style={{ color }}>
                {from?.name ?? "?"}
              </span>
            )}
            {item.agent && <span className="truncate text-subtle">· {item.agent}</span>}
            <span className="text-subtle">{time(item.ts)}</span>
          </div>
        )}
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-body leading-snug",
            own ? "rounded-br-md bg-accent text-accent-fg" : "rounded-bl-md bg-surface-3 text-fg",
            item.to && (own ? "ring-1 ring-accent-strong" : "ring-1 ring-accent/50"),
          )}
          title={head ? undefined : time(item.ts)}
        >
          {item.text}
        </div>
        {privateNote && head && <span className="mt-0.5 px-1 text-caption text-subtle">{privateNote}</span>}
      </div>
    </li>
  );
}

const EVENT_ICON = { turn: CheckCircle2, push: GitCommitHorizontal, pulled: ArrowDownToLine, joined: LogIn, left: LogOut, task: ClipboardList, message: MessageSquare } as const;

function EventRow({ crew, item }: { crew: Crew; item: CrewFeedItem }) {
  const from = crew.members.find((x) => x.id === item.from);
  const name = from?.self ? m.you : (from?.name ?? "?");
  const Icon = EVENT_ICON[item.kind];
  const head =
    item.kind === "turn"
      ? `${name}: ${m.eventTurn(item.agent)}`
      : item.kind === "push"
        ? `${name} ${m.eventPush}`
        : item.kind === "pulled"
          ? m.pulledText(item.text)
          : item.kind === "joined"
            ? m.joinedText(item.text || name)
            : item.kind === "left"
              ? m.leftText(item.text || name)
              : `${name} · ${m.eventTask}`;
  const detail = item.kind === "turn" || item.kind === "push" || item.kind === "task" ? item.text : null;
  return (
    <li
      className="my-1.5 flex justify-center animate-rise-in"
      onContextMenu={contextItems(() => [
        ...(detail ? [{ label: m.copyMessage, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(detail) }] : []),
        ...(item.files.length ? [{ label: m.copyFiles, icon: <FileText className="h-3.5 w-3.5" />, onSelect: () => copyText(item.files.join("\n")) }] : []),
      ])}
    >
      <div className="flex max-w-[92%] flex-col items-center rounded-lg px-2.5 py-1 text-center text-caption-lg text-muted">
        <div className="flex items-center gap-1.5">
          <Icon className={cn("h-3.5 w-3.5 shrink-0", item.kind === "turn" ? "text-success" : item.kind === "push" ? "text-warning" : "text-subtle")} />
          <span className="font-medium text-fg/80">{head}</span>
          <span className="text-subtle">{time(item.ts)}</span>
        </div>
        {(detail || item.files.length > 0) && (
          <div className="line-clamp-2 max-w-full">
            {detail}
            {item.files.length > 0 && (
              <span className="ml-1.5 font-mono text-[10px] text-subtle" title={item.files.join("\n")}>
                {item.files
                  .slice(0, 3)
                  .map((f) => f.split("/").pop())
                  .join(", ")}
                {item.files.length > 3 ? ` +${item.files.length - 3}` : ""}
              </span>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function ChatComposer({ crew, to, onTo, inputId, autoFocus }: { crew: Crew; to: string | null; onTo: (id: string | null) => void; inputId?: string; autoFocus: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const options = [{ value: EVERYONE, label: m.everyone }, ...others(crew).map((x) => ({ value: x.id, label: x.name, icon: <span className="h-2 w-2 rounded-full" style={{ background: x.color }} /> }))];
  const target = to && options.some((o) => o.value === to) ? to : EVERYONE;
  // Grows with the text up to six lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [text]);
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await call("crew.message", { crewId: crew.id, text: body, to: target === EVERYONE ? null : target });
      setText("");
      crewChanged(qc, crew);
    } catch (e) {
      toast.error(m.notSent, errorMessage(e));
    } finally {
      setBusy(false);
      area.current?.focus();
    }
  };
  return (
    <div className="shrink-0 border-t border-border bg-surface px-3 pb-2.5 pt-2">
      <div className="mb-1.5 flex items-center gap-2">
        <Select size="sm" className="w-auto min-w-32 max-w-56" value={target} onChange={(v) => onTo(v === EVERYONE ? null : v)} options={options} aria-label={m.recipient} />
        <span className="min-w-0 flex-1 truncate text-caption text-subtle" title={m.enterHint}>
          {m.enterHint}
        </span>
      </div>
      <div className="flex items-end gap-2 rounded-xl border border-border bg-bg px-2.5 py-1.5 focus-within:border-accent/60">
        <textarea
          ref={area}
          id={inputId}
          value={text}
          rows={1}
          maxLength={2000}
          autoFocus={autoFocus}
          placeholder={target === EVERYONE ? m.messagePlaceholder : m.messageTo(memberName(crew, target))}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          className="max-h-36 min-h-6 flex-1 resize-none bg-transparent py-0.5 text-body text-fg outline-none placeholder:text-subtle"
        />
        <Button size="icon-sm" variant="primary" className="shrink-0 rounded-lg" loading={busy} disabled={!text.trim()} onClick={() => void send()} aria-label={m.send} title={m.send}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Bot, Check, CheckCircle2, Circle, CircleDot, Eye, GitBranch, Globe, LogOut, MessageSquare, Plus, RotateCcw, Send, Trash2, UserCheck, Users, X } from "lucide-react";
import type { CrewView, CrewWebClient, MemberView } from "@/lib/crew-web/client";
import { crewMessages, type CrewMessages } from "@/lib/crew-web/messages";
import { MESSAGE_MAX, TASK_DETAIL_MAX, TASK_TITLE_MAX, type CrewAgent, type FeedItem, type TaskEntry, type TaskStatus } from "@/lib/crew-web/wire";
import type { Locale } from "@/lib/i18n";
import { useI18n } from "../locale";
import { clock, errorText, relativeTime, useTick } from "./util";
import { MemberAvatar } from "./avatar";
import { WatchPanel } from "./watch";

type Tab = "chat" | "people" | "tasks";

/** A crew we are a member of: chat, people with what their agents do, tasks; a live session on top. */
export function CrewBoard({ client, crew, onLeft }: { client: CrewWebClient; crew: CrewView; onLeft: () => void }) {
  const { locale } = useI18n();
  const m = crewMessages(locale);
  const [tab, setTab] = useState<Tab>("chat");
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  useTick();

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e, m));
    }
  };

  const tabs: Array<{ id: Tab; label: string; icon: typeof Users; count?: number }> = [
    { id: "chat", label: m.tabs.chat, icon: MessageSquare },
    { id: "people", label: m.tabs.people, icon: Users, count: crew.members.filter((x) => x.online).length },
    { id: "tasks", label: m.tabs.tasks, icon: CheckCircle2, count: crew.tasks.filter((x) => x.status !== "done").length },
  ];

  return (
    <div className="crew-board" data-tab={tab}>
      <header className="crew-board-head">
        <div className="crew-board-title">
          <h1>{crew.name}</h1>
          <p>
            <span className={crew.connection === "online" ? "live-dot live-dot-on" : "live-dot"} aria-hidden />
            <span>{m.connection[crew.connection]}</span>
            <span aria-hidden>·</span>
            <span className="crew-ellipsis">{m.project(crew.project)}</span>
          </p>
        </div>
        {leaving ? (
          <div className="crew-confirm">
            <button type="button" className="btn btn-outline crew-small crew-danger" onClick={() => void client.leave().then(onLeft)}>
              {m.leaveConfirm}
            </button>
            <button type="button" className="crew-icon-btn" onClick={() => setLeaving(false)} aria-label={m.close} title={m.close}>
              <X aria-hidden />
            </button>
          </div>
        ) : (
          <button type="button" className="crew-icon-btn" onClick={() => setLeaving(true)} aria-label={m.leave} title={m.leave}>
            <LogOut aria-hidden />
          </button>
        )}
      </header>

      {crew.requests.map((r) => (
        <div key={r.id} className="crew-request" role="status">
          <UserCheck aria-hidden />
          <div>
            <strong>{m.requestText(r.name)}</strong>
            <span>
              {m.requestCode}: <code>{r.code}</code>
            </span>
          </div>
          <div className="crew-request-actions">
            <button type="button" className="btn btn-primary crew-small" onClick={() => void act(() => client.respond(r.id, true))}>
              {m.accept}
            </button>
            <button type="button" className="btn btn-outline crew-small" onClick={() => void act(() => client.respond(r.id, false))}>
              {m.decline}
            </button>
          </div>
        </div>
      ))}

      {error && (
        <div className="error-banner" role="alert">
          <X aria-hidden />
          <p>{error}</p>
        </div>
      )}

      <nav className="crew-tabs" role="tablist">
        {tabs.map(({ id, label, icon: Icon, count }) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            <Icon aria-hidden />
            {label}
            {!!count && <span className="crew-count">{count}</span>}
          </button>
        ))}
      </nav>

      <div className="crew-columns">
        <section className="crew-col crew-col-people" aria-label={m.tabs.people}>
          <People crew={crew} m={m} locale={locale} onWatch={(member, agent) => void act(() => client.watch(member, agent))} />
        </section>
        <section className="crew-col crew-col-chat" aria-label={m.tabs.chat}>
          <Chat client={client} crew={crew} m={m} locale={locale} onError={setError} />
        </section>
        <section className="crew-col crew-col-tasks" aria-label={m.tabs.tasks}>
          <Tasks client={client} crew={crew} m={m} locale={locale} act={act} />
        </section>
      </div>

      {crew.watch && (
        <WatchPanel
          watch={crew.watch}
          member={crew.members.find((x) => x.id === crew.watch!.member) ?? null}
          onClose={() => client.stopWatch()}
          onRetry={() => {
            const w = crew.watch!;
            void act(() => client.watch(w.member, w.agentId));
          }}
        />
      )}
    </div>
  );
}

// ---------- chat

function Chat({ client, crew, m, locale, onError }: { client: CrewWebClient; crew: CrewView; m: CrewMessages; locale: Locale; onError: (e: string | null) => void }) {
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const members = new Map(crew.members.map((x) => [x.id, x]));
  const feed = crew.feed.filter((f) => f.kind !== "message" || !f.to || f.to === crew.selfId || f.from === crew.selfId);

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    onError(null);
    client.message(t.slice(0, MESSAGE_MAX)).catch((err: unknown) => onError(errorText(err, m)));
    stick.current = true;
  };

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) send(e);
  };

  return (
    <div className="crew-chat">
      <div
        className="crew-feed"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        aria-live="polite"
      >
        {!feed.length && <p className="crew-empty">{m.chatEmpty}</p>}
        {feed.map((item) => (
          <FeedRow key={item.id} item={item} from={members.get(item.from)} name={client.memberName(item.from)} toName={item.to ? client.memberName(item.to) : null} self={crew.selfId} m={m} locale={locale} />
        ))}
      </div>
      <form className="crew-composer" onSubmit={send}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={keyDown} placeholder={m.messagePlaceholder} rows={1} maxLength={MESSAGE_MAX} aria-label={m.messagePlaceholder} title={m.sendHint} />
        <button type="submit" className="btn btn-primary crew-send" disabled={!text.trim()} aria-label={m.send} title={m.send}>
          <Send aria-hidden />
        </button>
      </form>
    </div>
  );
}

function FeedRow({ item, from, name, toName, self, m, locale }: { item: FeedItem; from: MemberView | undefined; name: string; toName: string | null; self: string; m: CrewMessages; locale: Locale }) {
  const color = from?.color ?? "var(--color-subtle)";
  if (item.kind === "joined" || item.kind === "left" || item.kind === "pulled") {
    const text = item.kind === "joined" ? m.feed.joined(item.text || name) : item.kind === "left" ? `${name} ${m.feed.left}` : `${name} ${m.feed.pulled(item.text)}`;
    return (
      <p className="crew-feed-system">
        {text} · {clock(item.ts, locale)}
      </p>
    );
  }
  const mine = item.kind === "message" && item.from === self;
  return (
    <article className={`crew-feed-item crew-feed-${item.kind}${mine ? " crew-feed-mine" : ""}`}>
      <MemberAvatar name={name} color={color} avatar={from?.avatar} size={30} />
      <div className="crew-feed-body">
        <header>
          <strong>{name}</strong>
          {item.agent && (
            <span className="crew-chip">
              <Bot aria-hidden /> {item.agent}
            </span>
          )}
          {item.kind === "turn" && <span className="crew-muted">{m.feed.turn}</span>}
          {item.kind === "push" && <span className="crew-muted">{m.feed.push}</span>}
          {item.to && <span className="crew-muted">{item.to === self ? m.toYou : m.toMember(toName ?? "?")}</span>}
          <time dateTime={item.ts} title={new Date(item.ts).toLocaleString()}>
            {clock(item.ts, locale)}
          </time>
        </header>
        <p className="crew-text">{item.text}</p>
        {item.files.length > 0 && (
          <details className="crew-files">
            <summary>{m.files(item.files.length)}</summary>
            <ul>
              {item.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </article>
  );
}

// ---------- people

/**
 * Members as FORGE's sidebar shows its own work: the project, under it the sessions in the main
 * checkout, then the parallel agents (with their branch). A row opens the session live.
 */
function People({ crew, m, locale, onWatch }: { crew: CrewView; m: CrewMessages; locale: Locale; onWatch: (member: string, agent: string) => void }) {
  return (
    <div className="crew-people">
      {crew.members.map((p) => {
        const sessions = p.agents.filter((a) => !a.branch);
        const agents = p.agents.filter((a) => a.branch);
        const rows = [...sessions, ...agents];
        const canWatch = !p.self && p.online;
        return (
          <article key={p.id} className="crew-person">
            <header>
              <MemberAvatar name={p.name} color={p.color} avatar={p.avatar} size={28} online={p.online} />
              <div className="crew-person-name">
                <strong>
                  <span className="crew-ellipsis">{p.name}</span>
                  {p.self && <span className="crew-chip">{m.you}</span>}
                  {p.owner && <span className="crew-chip">{m.owner}</span>}
                  {p.web && (
                    <span className="crew-chip">
                      <Globe aria-hidden /> {m.browser}
                    </span>
                  )}
                </strong>
                <span className="crew-muted">{p.online ? m.online : p.lastSeen ? m.lastSeen(relativeTime(p.lastSeen, locale)) : m.neverSeen}</span>
              </div>
            </header>
            {p.web ? (
              !p.self && <p className="crew-muted crew-small-text crew-person-note">{m.webMember}</p>
            ) : (
              <div className="crew-tree">
                <div className="crew-tree-project">
                  <span className="crew-project-icon" aria-hidden>
                    {(crew.project.trim()[0] ?? "?").toUpperCase()}
                  </span>
                  <span className="crew-ellipsis">{crew.project}</span>
                  {p.branch && (
                    <span className="crew-tree-meta" title={m.branch(p.branch)}>
                      <GitBranch aria-hidden /> <span className="crew-ellipsis">{p.branch}</span>
                    </span>
                  )}
                  {p.ahead > 0 && (
                    <span className="crew-tree-meta crew-warn" title={m.ahead(p.ahead)}>
                      <ArrowUp aria-hidden />
                      {p.ahead}
                    </span>
                  )}
                </div>
                {rows.length ? (
                  <ul className="crew-tree-rows">
                    {rows.map((a, i) => (
                      <TreeRow key={a.id} agent={a} last={i === rows.length - 1} m={m} canWatch={canWatch} onWatch={() => onWatch(p.id, a.id)} />
                    ))}
                  </ul>
                ) : (
                  <p className="crew-muted crew-small-text crew-person-note">{m.noAgents}</p>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function TreeRow({ agent, last, m, canWatch, onWatch }: { agent: CrewAgent; last: boolean; m: CrewMessages; canWatch: boolean; onWatch: () => void }) {
  const status = m.status[agent.status];
  const line = agent.status === "idle" && agent.lastResult ? agent.lastResult : agent.task;
  const content = (
    <>
      <span className="crew-tree-head">
        <span className={`crew-tree-dot crew-tree-dot-${agent.status}`} aria-hidden />
        {agent.branch && <Bot aria-hidden className="crew-accent" />}
        {agent.team && <Users aria-hidden className="crew-accent" />}
        <span className="crew-ellipsis crew-tree-title">{agent.title}</span>
        {agent.branch && <span className="crew-tree-branch crew-ellipsis">{agent.branch}</span>}
        {canWatch && <Eye aria-hidden className="crew-tree-eye" />}
      </span>
      {line && <span className="crew-tree-line">{line}</span>}
      {agent.team && agent.team.working > 0 && <span className="crew-tree-line">{m.team(agent.team.working)}</span>}
    </>
  );
  return (
    <li className={last ? "crew-branch crew-branch-last" : "crew-branch"}>
      {canWatch ? (
        <button type="button" className="crew-tree-row" onClick={onWatch} title={`${m.watch}: ${agent.title} (${status})`} aria-label={`${agent.title}, ${status}. ${m.watch}`}>
          {content}
        </button>
      ) : (
        <div className="crew-tree-row" title={`${agent.title} (${status})`}>
          {content}
        </div>
      )}
    </li>
  );
}

// ---------- tasks

const GROUPS: TaskStatus[] = ["in_progress", "open", "done"];

function Tasks({ client, crew, m, locale, act }: { client: CrewWebClient; crew: CrewView; m: CrewMessages; locale: Locale; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const others = crew.members.filter((x) => !x.web || x.self);

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const t = { title: title.slice(0, TASK_TITLE_MAX), detail: detail.slice(0, TASK_DETAIL_MAX), assignee };
    setTitle("");
    setDetail("");
    void act(() => client.addTask(t));
  };

  return (
    <div className="crew-tasks">
      <form className="crew-task-form" onSubmit={add}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={m.taskTitle} maxLength={TASK_TITLE_MAX} aria-label={m.taskTitle} />
        {title.trim() && (
          <>
            <textarea value={detail} onChange={(e) => setDetail(e.target.value)} placeholder={m.taskDetail} rows={2} maxLength={TASK_DETAIL_MAX} aria-label={m.taskDetail} />
            <div className="crew-assignee" role="group" aria-label={m.taskFor}>
              <span className="crew-muted">{m.taskFor}</span>
              <button type="button" aria-pressed={assignee === null} onClick={() => setAssignee(null)}>
                {m.anyone}
              </button>
              {others.map((x) => (
                <button key={x.id} type="button" aria-pressed={assignee === x.id} onClick={() => setAssignee(x.id)}>
                  {x.self ? m.you : x.name}
                </button>
              ))}
            </div>
          </>
        )}
        <button type="submit" className="btn btn-primary crew-small" disabled={!title.trim()}>
          <Plus aria-hidden /> {m.addTask}
        </button>
      </form>
      {!crew.tasks.length && <p className="crew-empty">{m.tasksEmpty}</p>}
      {GROUPS.map((status) => {
        const list = crew.tasks.filter((x) => x.status === status);
        if (!list.length) return null;
        const shown = status === "done" ? list.slice(-20).reverse() : list;
        return (
          <section key={status} className="crew-task-group">
            <h3>
              {m.taskGroups[status]} <span className="crew-count">{list.length}</span>
            </h3>
            <ul>
              {shown.map((task) => (
                <TaskRow key={task.id} task={task} client={client} m={m} locale={locale} act={act} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function TaskRow({ task, client, m, locale, act }: { task: TaskEntry; client: CrewWebClient; m: CrewMessages; locale: Locale; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 4000);
    return () => clearTimeout(id);
  }, [confirm]);
  const Icon = task.status === "done" ? CheckCircle2 : task.status === "in_progress" ? CircleDot : Circle;
  const meta = [
    m.taskBy(client.memberName(task.createdBy)),
    task.assignee ? m.taskFor_(client.memberName(task.assignee)) : null,
    task.owner && task.status !== "open" ? m.taskOwner(`${client.memberName(task.owner.member)}${task.owner.agent ? ` (${task.owner.agent})` : ""}`) : null,
    relativeTime(task.updatedAt, locale),
  ].filter(Boolean);
  return (
    <li className={`crew-task crew-task-${task.status}`}>
      <Icon aria-hidden />
      <div className="crew-task-body">
        <strong>{task.title}</strong>
        {task.detail && <p className="crew-text crew-small-text">{task.detail}</p>}
        {task.note && <p className="crew-muted crew-small-text">{task.note}</p>}
        <p className="crew-muted crew-small-text">{meta.join(" · ")}</p>
        <div className="crew-task-actions">
          {task.status === "open" && (
            <button type="button" onClick={() => void act(() => client.updateTask(task.id, { status: "in_progress" }))}>
              {m.take}
            </button>
          )}
          {task.status !== "done" && (
            <button type="button" onClick={() => void act(() => client.updateTask(task.id, { status: "done" }))}>
              <Check aria-hidden /> {m.done}
            </button>
          )}
          {task.status !== "open" && (
            <button type="button" onClick={() => void act(() => client.updateTask(task.id, { status: "open" }))}>
              <RotateCcw aria-hidden /> {m.reopen}
            </button>
          )}
          <button type="button" className="crew-danger" onClick={() => (confirm ? void act(() => client.removeTask(task.id)) : setConfirm(true))}>
            <Trash2 aria-hidden /> {confirm ? m.removeConfirm : m.remove}
          </button>
        </div>
      </div>
    </li>
  );
}

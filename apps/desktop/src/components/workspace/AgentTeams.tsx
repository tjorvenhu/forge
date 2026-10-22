import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, ClipboardList, Copy, Crown, FileText, Lock, MessageSquare, Power, Send, SquareTerminal, Users, X } from "lucide-react";
import { AGENT_TEAM_ALL, AGENT_TEAM_LEAD, type AgentTeam, type AgentTeamMember, type AgentTeamMessage, type AgentTeamTask, type Project } from "@forge/protocol";
import { call, useAgentTeams } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { currentTask, memberColor, showTeamTerminal, startTeamTerminal, teamLinks, useTeamsAllowed } from "@/lib/agent-teams";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner, SectionTitle } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { LimitForecastWarning } from "@/components/usage/UsageWindows";
import { t } from "@/i18n";

/** A link between two members glows this long after their last message. */
const RECENT_MS = 20_000;

/**
 * Claude Code's agent teams of the project: a lead in a terminal tab spawns teammates that share a
 * task list and message each other. FORGE reads the team's files and shows who works on what.
 */
export function AgentTeamsSection({ project }: { project: Project }) {
  const teams = useAgentTeams(project.id);
  const allowed = useTeamsAllowed(project);
  const [starting, setStarting] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const tt = t.workspace.teams;
  const ended = (teams.data ?? []).filter((x) => !x.active).length;
  // Switched off: nothing to see, unless a team still runs and needs ending.
  if (!allowed.allowed && !teams.data?.some((x) => x.active)) return null;
  const dismissEnded = async () => {
    setDismissing(true);
    try {
      const r = await call("teams.dismiss", { projectId: project.id });
      toast.success(tt.dismissed(r.count));
    } catch (e) {
      toast.error(tt.notDismissed, errorMessage(e));
    } finally {
      setDismissing(false);
    }
  };
  const openSetting = () => {
    if (!allowed.global) useUi.getState().openSettings("claude");
    else {
      if (allowed.rootId && allowed.rootId !== project.id) useUi.getState().openProject(allowed.rootId);
      useUi.getState().openProjectSettings("general");
    }
  };
  return (
    <section>
      <SectionTitle
        action={
          <div className="flex items-center gap-2">
            {ended > 0 && (
              <Button size="sm" variant="ghost" loading={dismissing} onClick={() => void dismissEnded()}>
                <X className="h-3.5 w-3.5" /> {tt.dismissEnded}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => setStarting(true)} disabled={!project.exists || !allowed.allowed}>
              <Users className="h-3.5 w-3.5" /> {tt.start}
            </Button>
          </div>
        }
      >
        {tt.title}
      </SectionTitle>
      <p className="mb-3 text-xs text-muted">{tt.intro}</p>
      {!allowed.allowed && (
        <p className="mb-3 text-xs text-warning">
          {allowed.global ? tt.offProject : tt.offGlobal}{" "}
          <button className="text-accent underline" onClick={openSetting}>
            {tt.offLink}
          </button>
        </p>
      )}
      {teams.isLoading && <TeamSkeleton />}
      {teams.isError && <ErrorBanner title={tt.notLoaded}>{errorMessage(teams.error)}</ErrorBanner>}
      {teams.isSuccess && teams.data.length === 0 && (
        <EmptyState
          icon={<Users className="h-9 w-9" />}
          title={tt.emptyTitle}
          action={
            <Button size="sm" variant="outline" onClick={() => setStarting(true)} disabled={!project.exists}>
              {tt.start}
            </Button>
          }
        >
          {tt.emptyText}
        </EmptyState>
      )}
      <div className="flex flex-col gap-4">
        {teams.data?.map((team) => <TeamCard key={team.name} team={team} projectId={project.id} />)}
      </div>
      <StartTeamDialog open={starting} onOpenChange={setStarting} project={project} />
    </section>
  );
}

function TeamCard({ team, projectId }: { team: AgentTeam; projectId: string }) {
  const tt = t.workspace.teams;
  const [to, setTo] = useState<string>(AGENT_TEAM_LEAD);
  // Ended teams stay as a line with their result; the details open on demand.
  const [expanded, setExpanded] = useState(team.active);
  useEffect(() => {
    if (team.active) setExpanded(true);
  }, [team.active]);
  const done = team.tasks.filter((x) => x.status === "completed").length;
  const running = team.tasks.filter((x) => x.status === "in_progress").length;
  const teammates = team.members.filter((m) => !m.lead);
  const [confirmStop, setConfirmStop] = useState(false);
  const openTerminal = () => {
    if (!showTeamTerminal(team.projectId ?? projectId)) toast.info(tt.terminalGone);
  };
  const stop = async () => {
    try {
      const r = await call("teams.stop", { team: team.name });
      if (r.ok) toast.success(tt.stopped, team.name);
      else toast.info(tt.stopSlow);
    } catch (e) {
      toast.error(tt.notStopped, errorMessage(e));
      throw e;
    }
  };
  const dismiss = async () => {
    try {
      await call("teams.dismiss", { team: team.name });
    } catch (e) {
      toast.error(tt.notDismissed, errorMessage(e));
    }
  };
  const menu = () => [
    { label: tt.showTerminal, icon: <SquareTerminal className="h-3.5 w-3.5" />, onSelect: openTerminal, disabled: !team.active },
    { label: expanded ? tt.collapseTeam : tt.expandTeam, icon: expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />, onSelect: () => setExpanded(!expanded) },
    { label: tt.copyName, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(team.name) },
    team.active
      ? { label: tt.stopConfirm, icon: <Power className="h-3.5 w-3.5" />, onSelect: () => setConfirmStop(true), disabled: !team.canStop, hint: team.canStop ? undefined : tt.cannotStop, danger: true }
      : { label: tt.dismiss, icon: <X className="h-3.5 w-3.5" />, onSelect: () => void dismiss() },
  ];
  return (
    <div className={cn("flex flex-col rounded-xl border border-border bg-surface p-4", expanded ? "gap-4" : "gap-3")} onContextMenu={contextItems(menu)}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="-m-1 rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={expanded ? tt.collapseTeam : tt.expandTeam}
          title={expanded ? tt.collapseTeam : tt.expandTeam}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", team.active ? "animate-pulse bg-success" : "bg-subtle")} aria-hidden />
        <span className="font-mono text-body" title={team.cwd}>
          {team.name}
        </span>
        <Badge tone={team.active ? "success" : "neutral"}>{team.active ? tt.running : tt.ended}</Badge>
        <span className="text-xs text-subtle">{tt.started(relativeTime(team.createdAt))}</span>
        <div className="flex-1" />
        <span className="text-xs text-muted">{tt.counts(teammates.length, done, team.tasks.length)}</span>
        {team.active && (
          <Button size="sm" variant="outline" onClick={openTerminal}>
            <SquareTerminal className="h-3.5 w-3.5" /> {tt.showTerminal}
          </Button>
        )}
        {team.active ? (
          <Button size="sm" variant="danger-ghost" onClick={() => setConfirmStop(true)} disabled={!team.canStop} title={team.canStop ? undefined : tt.cannotStop}>
            <Power className="h-3.5 w-3.5" /> {tt.stop}
          </Button>
        ) : (
          <Button size="icon-sm" variant="ghost" onClick={() => void dismiss()} aria-label={tt.dismiss} title={tt.dismiss}>
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {team.tasks.length > 0 && <TaskProgress done={done} running={running} total={team.tasks.length} />}

      {expanded && <TeamDetails team={team} to={to} onTo={setTo} />}
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title={tt.stopTitle}
        description={tt.stopDescription(team.name)}
        confirmLabel={tt.stopConfirm}
        danger
        onConfirm={stop}
      />
    </div>
  );
}

/** Graph and members, the task board, the messages and the field to write to the team. */
function TeamDetails({ team, to, onTo }: { team: AgentTeam; to: string; onTo: (name: string) => void }) {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <TeamGraph team={team} onPick={onTo} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-2">
          {team.members.map((m) => (
            <MemberCard key={m.name} team={team} member={m} onMessage={() => onTo(m.name)} />
          ))}
        </div>
      </div>

      <TaskBoard team={team} onMessage={onTo} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <MessageTimeline team={team} />
        <TeamComposer team={team} to={to} onTo={onTo} />
      </div>
    </>
  );
}

function TaskProgress({ done, running, total }: { done: number; running: number; total: number }) {
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div className="h-full bg-success transition-[width] duration-300" style={{ width: pct(done) }} />
        <div className="h-full bg-accent/60 transition-[width] duration-300" style={{ width: pct(running) }} />
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted">{t.workspace.teams.progress(done, total)}</span>
    </div>
  );
}

/** Lead in the middle, teammates around it; a line for each pair that wrote to each other, glowing while it is fresh. */
function TeamGraph({ team, onPick }: { team: AgentTeam; onPick: (name: string) => void }) {
  const now = useNow(team.active ? 5_000 : null);
  const size = 260;
  const c = size / 2;
  const lead = team.members.find((m) => m.lead);
  const mates = team.members.filter((m) => !m.lead);
  const pos = useMemo(() => {
    const p = new Map<string, { x: number; y: number }>();
    if (lead) p.set(lead.name, { x: c, y: c });
    const r = mates.length > 1 ? 92 : 70;
    mates.forEach((m, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(mates.length, 1);
      p.set(m.name, { x: c + r * Math.cos(a), y: c + r * Math.sin(a) });
    });
    return p;
  }, [lead, mates, c]);
  const links = teamLinks(team.messages);
  const max = Math.max(1, ...links.map((l) => l.count));
  return (
    <div className="rounded-lg border border-border bg-bg/40 p-2">
      <svg viewBox={`0 0 ${size} ${size}`} className="h-auto w-full" role="img" aria-label={t.workspace.teams.graphLabel}>
        {/* Every teammate hangs on the lead, faintly, also before anyone wrote. */}
        {lead &&
          mates.map((m) => {
            const a = pos.get(lead.name)!;
            const b = pos.get(m.name)!;
            return <line key={`base-${m.name}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-border)" strokeWidth={1} />;
          })}
        {links.map((l) => {
          const a = pos.get(l.a);
          const b = pos.get(l.b);
          if (!a || !b) return null;
          const fresh = team.active && now - Date.parse(l.last) < RECENT_MS;
          return (
            <line
              key={`${l.a}-${l.b}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={fresh ? "var(--color-accent)" : "var(--color-muted)"}
              strokeOpacity={fresh ? 0.95 : 0.45}
              strokeWidth={1.5 + (3 * l.count) / max}
              strokeLinecap="round"
              className={fresh ? "team-flow" : undefined}
            >
              <title>{t.workspace.teams.linkTitle(l.a, l.b, l.count)}</title>
            </line>
          );
        })}
        {team.members.map((m) => {
          const p = pos.get(m.name);
          if (!p) return null;
          const color = memberColor(team, m.name);
          const r = m.lead ? 20 : 16;
          return (
            <g key={m.name} transform={`translate(${p.x} ${p.y})`} className="cursor-pointer" onClick={() => onPick(m.name)}>
              <title>{t.workspace.teams.nodeTitle(m.name, stateLabel(m))}</title>
              {m.state === "working" && team.active && <circle r={r + 5} fill="none" stroke={color} strokeOpacity={0.5} strokeWidth={2} className="animate-pulse" />}
              <circle r={r} fill={color} fillOpacity={m.state === "idle" || !team.active ? 0.55 : 0.9} stroke="var(--color-surface)" strokeWidth={2} />
              <text textAnchor="middle" dy="0.35em" fontSize={m.lead ? 13 : 12} fontWeight={600} fill="#fff">
                {m.lead ? "★" : m.name.slice(0, 1).toUpperCase()}
              </text>
              <text textAnchor="middle" y={r + 18} fontSize={10} fill="var(--color-fg)" stroke="var(--color-bg)" strokeWidth={3} paintOrder="stroke">
                {m.lead ? t.workspace.teams.lead : m.name}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function stateLabel(m: AgentTeamMember): string {
  const tt = t.workspace.teams;
  return m.lead ? tt.inTerminal : m.state === "working" ? tt.working : m.state === "idle" ? tt.idle : tt.unknown;
}

function MemberCard({ team, member, onMessage }: { team: AgentTeam; member: AgentTeamMember; onMessage: () => void }) {
  const tt = t.workspace.teams;
  const color = memberColor(team, member.name);
  const task = member.lead ? null : currentTask(team, member.name);
  const menu = () => [
    { label: tt.messageTo(member.lead ? tt.lead : member.name), icon: <MessageSquare className="h-3.5 w-3.5" />, onSelect: onMessage, disabled: !team.active },
    ...(member.prompt ? [{ label: tt.copyPrompt, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(member.prompt!) }] : []),
    ...(member.lastResult ? [{ label: tt.copyResult, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(member.lastResult!) }] : []),
  ];
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2/60 p-3" onContextMenu={contextItems(menu)}>
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ background: color }} aria-hidden>
          {member.lead ? <Crown className="h-3.5 w-3.5" /> : member.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-body">{member.lead ? tt.lead : member.name}</span>
        {member.model && <Badge>{member.model}</Badge>}
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            !team.active ? "bg-subtle" : member.state === "working" ? "animate-pulse bg-accent" : member.state === "idle" ? "bg-success" : "bg-subtle",
          )}
          aria-hidden
        />
        <span className="text-muted">{team.active ? stateLabel(member) : tt.ended}</span>
        {member.agentType && !member.lead && <span className="truncate text-subtle">· {member.agentType}</span>}
      </div>
      {task && (
        <p className="truncate text-xs text-fg" title={task.description || task.subject}>
          #{task.id} {task.subject}
        </p>
      )}
      {member.lastResult && (
        <p className="line-clamp-2 text-xs text-muted" title={member.lastResult}>
          {member.lastResult}
        </p>
      )}
      {!member.lastResult && member.prompt && (
        <p className="line-clamp-2 text-xs text-subtle" title={member.prompt}>
          {member.prompt}
        </p>
      )}
    </div>
  );
}

function TaskBoard({ team, onMessage }: { team: AgentTeam; onMessage: (name: string) => void }) {
  const tt = t.workspace.teams;
  const columns: Array<{ status: AgentTeamTask["status"]; label: string }> = [
    { status: "pending", label: tt.columnPending },
    { status: "in_progress", label: tt.columnInProgress },
    { status: "completed", label: tt.columnDone },
  ];
  if (!team.tasks.length) return <p className="text-xs text-subtle">{tt.noTasks}</p>;
  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">{tt.tasks}</h4>
      <div className="grid gap-3 md:grid-cols-3">
        {columns.map((col) => {
          const tasks = team.tasks.filter((x) => x.status === col.status);
          return (
            <div key={col.status} className="flex min-h-24 flex-col gap-2 rounded-lg bg-surface-2/50 p-2">
              <div className="flex items-center justify-between px-1 text-xs text-muted">
                <span>{col.label}</span>
                <span className="tabular-nums">{tasks.length}</span>
              </div>
              {tasks.map((task) => (
                <TaskCard key={task.id} team={team} task={task} onMessage={onMessage} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TaskCard({ team, task, onMessage }: { team: AgentTeam; task: AgentTeamTask; onMessage: (name: string) => void }) {
  const tt = t.workspace.teams;
  const owner = task.owner;
  const menu = () => [
    { label: tt.copyTask, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(`#${task.id} ${task.subject}${task.description ? `\n\n${task.description}` : ""}`) },
    ...(owner ? [{ label: tt.messageTo(owner === AGENT_TEAM_LEAD ? tt.lead : owner), icon: <MessageSquare className="h-3.5 w-3.5" />, onSelect: () => onMessage(owner), disabled: !team.active }] : []),
  ];
  return (
    <div
      className={cn("animate-rise-in rounded-md border border-border bg-surface p-2 text-xs", task.status === "completed" && "opacity-70")}
      title={task.description || undefined}
      onContextMenu={contextItems(menu)}
    >
      <div className="flex items-start gap-1.5">
        {task.status === "completed" ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-success" /> : task.blocked ? <Lock className="mt-px h-3.5 w-3.5 shrink-0 text-warning" /> : <ClipboardList className="mt-px h-3.5 w-3.5 shrink-0 text-muted" />}
        <span className={cn("min-w-0 flex-1 text-fg", task.status === "completed" && "line-through decoration-subtle")}>
          <span className="text-subtle">#{task.id}</span> {task.subject}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {owner ? <MemberChip team={team} name={owner} /> : <span className="text-subtle">{tt.unassigned}</span>}
        {task.blocked && <span className="text-warning">{tt.waitsFor(task.blockedBy.map((b) => `#${b}`).join(", "))}</span>}
      </div>
    </div>
  );
}

function MemberChip({ team, name }: { team: AgentTeam; name: string }) {
  const tt = t.workspace.teams;
  const label = name === AGENT_TEAM_LEAD ? tt.lead : name === "user" ? tt.you : name === AGENT_TEAM_ALL ? tt.everyone : name;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-px text-[11px] text-fg">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: memberColor(team, name) }} aria-hidden />
      {label}
    </span>
  );
}

const KIND_ICON: Record<AgentTeamMessage["kind"], typeof MessageSquare> = {
  message: MessageSquare,
  task: ClipboardList,
  idle: CheckCircle2,
  shutdown: Power,
  plan: FileText,
  other: MessageSquare,
};

function MessageTimeline({ team }: { team: AgentTeam }) {
  const tt = t.workspace.teams;
  const [open, setOpen] = useState<string | null>(null);
  const shown = team.messages.slice(-60).reverse();
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">{tt.messages}</h4>
      {shown.length === 0 ? (
        <p className="text-xs text-subtle">{team.active ? tt.noMessages : tt.noMessagesEnded}</p>
      ) : (
        <ol className="flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1">
          {shown.map((m) => {
            const Icon = KIND_ICON[m.kind];
            const expanded = open === m.id;
            return (
              <li
                key={m.id}
                className="animate-rise-in rounded-md border border-border bg-surface-2/40 px-2.5 py-1.5"
                onContextMenu={contextItems(() => [{ label: tt.copyMessage, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(m.text) }])}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  <Icon className="h-3.5 w-3.5 shrink-0 text-muted" aria-label={tt.kind[m.kind]} />
                  <MemberChip team={team} name={m.from} />
                  <span className="text-subtle">→</span>
                  <MemberChip team={team} name={m.to} />
                  <span className="truncate text-subtle">{tt.kind[m.kind]}</span>
                  <span className="ml-auto shrink-0 text-subtle" title={new Date(m.ts).toLocaleString()}>
                    {relativeTime(m.ts)}
                  </span>
                </div>
                {m.text && (
                  <button
                    type="button"
                    className={cn("mt-1 block w-full whitespace-pre-wrap break-words text-left text-xs text-fg", !expanded && "line-clamp-3")}
                    onClick={() => setOpen(expanded ? null : m.id)}
                    title={expanded ? tt.collapse : tt.expand}
                  >
                    {m.text}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function TeamComposer({ team, to, onTo }: { team: AgentTeam; to: string; onTo: (name: string) => void }) {
  const tt = t.workspace.teams;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const options = [
    ...team.members.map((m) => ({ value: m.name, label: m.lead ? tt.lead : m.name })),
    ...(team.members.some((m) => !m.lead) ? [{ value: AGENT_TEAM_ALL, label: tt.allTeammates }] : []),
  ];
  const target = options.some((o) => o.value === to) ? to : AGENT_TEAM_LEAD;
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await call("teams.message", { team: team.name, to: target, text });
      setText("");
      toast.success(tt.sent(r.recipients.map((x) => (x === AGENT_TEAM_LEAD ? tt.lead : x)).join(", ")));
    } catch (e) {
      toast.error(tt.notSent, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-subtle">{tt.writeTitle}</h4>
      <Select value={target} onChange={onTo} options={options} size="sm" aria-label={tt.recipient} disabled={!team.active} />
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={team.active ? tt.writePlaceholder : tt.endedNoMessages}
        disabled={!team.active || busy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-subtle">{tt.writeHint}</span>
        <Button size="sm" variant="primary" loading={busy} disabled={!team.active || !text.trim()} onClick={() => void send()}>
          <Send className="h-3.5 w-3.5" /> {tt.send}
        </Button>
      </div>
    </div>
  );
}

function StartTeamDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project }) {
  const tt = t.workspace.teams;
  const [prompt, setPrompt] = useState("");
  const start = () => {
    startTeamTerminal(project.id, prompt);
    setPrompt("");
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tt.startTitle}
      description={tt.startDescription(project.name)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tt.cancel}
          </Button>
          <Button variant="primary" onClick={start}>
            <Users className="h-3.5 w-3.5" /> {tt.startButton}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={tt.firstTask}>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder={tt.firstTaskPlaceholder} autoFocus />
        </Field>
        <p className="text-xs text-muted">{tt.startNote}</p>
        <LimitForecastWarning />
      </div>
    </Dialog>
  );
}

/** The time, ticking every `ms` while set; fresh links fade without new data. */
function useNow(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** One team card as TeamCard renders it: header, graph next to member cards, task columns. */
function TeamSkeleton() {
  return (
    <SkeletonRegion label={t.workspace.teams.loading} className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-2">
        <Skeleton className="h-2.5 w-2.5 rounded-full" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-14 rounded-full" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-28" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Skeleton className="aspect-square w-full rounded-lg" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
    </SkeletonRegion>
  );
}

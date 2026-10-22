import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, CheckCircle2, ChevronDown, Circle, CircleDashed, Copy, Crown, FileText, ListChecks, MessageSquare, PanelTopOpen, Power, X } from "lucide-react";
import type { AgentTeam, Session, TeamMember, TeamTask } from "@forge/protocol";
import { useAgentTeam } from "@/lib/queries";
import { leadState, modelMeta, openMember, ROLE_META, shortDuration, stopTeam, teamBusy } from "@/lib/agent-teams";
import { contextItems, copyText } from "@/lib/context-menu";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

/** collapsed boards per session, for this run of the app */
const collapsed = new Set<string>();

/**
 * The team over its lead's chat: the lead with its state and the plan, then one card per member
 * with role, model and what it is doing right now. A click opens the member's own history.
 */
export function TeamBoard({ session }: { session: Session }) {
  const team = useAgentTeam(session.id);
  const [open, setOpen] = useState(() => !collapsed.has(session.id));
  const toggle = () => {
    if (open) collapsed.add(session.id);
    else collapsed.delete(session.id);
    setOpen(!open);
  };
  if (!team.data) return team.isError ? null : <TeamBoardSkeleton />;
  return (
    <div className="shrink-0 border-b border-border bg-surface/60" aria-label={t.workspace.teams.board}>
      <LeadBar team={team.data} open={open} onToggle={toggle} />
      <Collapse open={open}>
        <div className="max-h-[46vh] overflow-y-auto px-4 pb-3">
          <TeamGrid team={team.data} />
        </div>
      </Collapse>
    </div>
  );
}

export function ModelChip({ model, className }: { model: string | null; className?: string }) {
  const m = modelMeta(model);
  if (!m) return null;
  return (
    <span
      className={cn("inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full border px-1.5 text-caption font-medium", className)}
      style={{ color: m.color, borderColor: `${m.color}55`, background: `${m.color}14` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

/** Round avatar of a member in its role's color; pulses while it works. */
export function RoleAvatar({ member, size = "md" }: { member: Pick<TeamMember, "role" | "state">; size?: "sm" | "md" }) {
  const meta = ROLE_META[member.role ?? "other"];
  const Icon = meta.icon;
  const working = member.state === "working";
  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full", size === "sm" ? "h-6 w-6" : "h-8 w-8", working && "team-ping")}
      style={{ background: `${meta.color}22`, color: meta.color, "--team-color": meta.color } as CSSProperties}
    >
      <Icon className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} />
      {size === "md" && member.state === "done" && <StateDot className="bg-success" icon={<Check className="h-2 w-2" strokeWidth={4} />} />}
      {size === "md" && member.state === "failed" && <StateDot className="bg-danger" icon={<X className="h-2 w-2" strokeWidth={4} />} />}
    </span>
  );
}

function StateDot({ className, icon }: { className: string; icon: ReactNode }) {
  return <span className={cn("absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full text-white ring-2 ring-surface", className)}>{icon}</span>;
}

export function LeadAvatar({ busy, ended = false, size = "md" }: { busy: boolean; ended?: boolean; size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        ended ? "bg-surface-3 text-muted" : "bg-accent text-accent-fg",
        size === "sm" ? "h-6 w-6" : "h-8 w-8",
        busy && "team-ping",
      )}
      style={{ "--team-color": "var(--color-accent)" } as CSSProperties}
    >
      <Crown className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} />
    </span>
  );
}

/** Plan progress as a thin ring, with done/total next to it. */
export function PlanProgress({ tasks, className }: { tasks: TeamTask[]; className?: string }) {
  const done = tasks.filter((x) => x.status === "completed").length;
  const total = tasks.length;
  if (!total) return null;
  const pct = done / total;
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-caption-lg text-muted", className)} title={t.workspace.teams.progress(done, total)}>
      <svg viewBox="0 0 18 18" className="h-4 w-4 -rotate-90" aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--color-border-strong)" strokeWidth="2.5" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={pct === 1 ? "var(--color-success)" : "var(--color-accent)"} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} className="transition-[stroke-dasharray] duration-500" />
      </svg>
      <span className="tabular-nums">
        {done}/{total}
      </span>
    </span>
  );
}

function LeadBar({ team, open, onToggle }: { team: AgentTeam; open: boolean; onToggle: () => void }) {
  const tt = t.workspace.teams;
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const busy = teamBusy(team);
  const state = leadState(team);
  const lead = modelMeta(team.leadModel);
  const working = team.members.filter((m) => m.state === "working");
  return (
    <div className="flex h-11 items-center gap-2.5 px-4">
      <LeadAvatar busy={busy} ended={!team.live} size="sm" />
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-body font-semibold">{tt.board}</span>
        <span className="truncate text-small text-muted">
          {lead ? tt.leadOn(lead.label) : tt.lead} · {tt.leadState[state]}
        </span>
      </div>
      {!open && team.members.length > 0 && (
        <button type="button" onClick={onToggle} className="flex items-center -space-x-1.5 rounded-full px-1 hover:bg-surface-3" title={tt.expandBoard}>
          {team.members.slice(-6).map((m) => (
            <span key={m.id} className="rounded-full bg-surface ring-2 ring-surface">
              <RoleAvatar member={m} size="sm" />
            </span>
          ))}
        </button>
      )}
      <div className="flex-1" />
      {working.length > 0 && (
        <span className="hidden items-center gap-1.5 text-caption-lg text-muted sm:inline-flex">
          <span className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-accent" />
          {working.length} {tt.working}
        </span>
      )}
      <PlanProgress tasks={team.tasks} />
      {busy && (
        <Button size="sm" variant="danger-ghost" onClick={() => setConfirm(true)}>
          <Power className="h-3.5 w-3.5" /> {tt.stop}
        </Button>
      )}
      <Button size="icon-sm" variant="ghost" onClick={onToggle} title={open ? tt.collapseBoard : tt.expandBoard} aria-expanded={open}>
        <ChevronDown className={cn("h-4 w-4 transition-transform", !open && "-rotate-90")} />
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={tt.stopTitle}
        description={tt.stopDescription(team.title ?? "")}
        confirmLabel={tt.stopConfirm}
        danger
        onConfirm={async () => {
          await stopTeam(qc, team);
        }}
      />
    </div>
  );
}

/** Members and plan side by side when there is room, else one under the other. */
export function TeamGrid({ team }: { team: AgentTeam }) {
  const tt = t.workspace.teams;
  // Running members first, then the newest; a finished team reads top down as it happened.
  const members = [...team.members].sort((a, b) => Number(b.state === "working") - Number(a.state === "working") || b.startedAt.localeCompare(a.startedAt));
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0">
        {members.length ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
            {members.map((m) => (
              <MemberCard key={m.id} sessionId={team.sessionId} member={m} />
            ))}
          </div>
        ) : (
          <p className="flex h-full items-center rounded-lg border border-dashed border-border px-3 py-4 text-small text-muted">{teamBusy(team) ? tt.noMembers : tt.noMembersIdle}</p>
        )}
        {members.length > 0 && <p className="mt-2 text-caption-lg text-subtle">{tt.boardHint}</p>}
      </div>
      <PlanList tasks={team.tasks} />
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function MemberCard({ sessionId, member: m }: { sessionId: string; member: TeamMember }) {
  const tt = t.workspace.teams;
  const meta = ROLE_META[m.role ?? "other"];
  const working = m.state === "working";
  const now = useNow(working);
  const ms = (m.endedAt ? Date.parse(m.endedAt) : now) - Date.parse(m.startedAt);
  return (
    <button
      type="button"
      onClick={() => openMember(sessionId, m)}
      onContextMenu={contextItems(() => [
        { label: tt.openMember, icon: <PanelTopOpen className="h-3.5 w-3.5" />, onSelect: () => openMember(sessionId, m) },
        { label: tt.messageMember, icon: <MessageSquare className="h-3.5 w-3.5" />, onSelect: () => openMember(sessionId, m, true) },
        { label: tt.copyPrompt, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(m.prompt) },
        ...(m.result ? [{ label: tt.copyResult, icon: <FileText className="h-3.5 w-3.5" />, onSelect: () => copyText(m.result!) }] : []),
      ])}
      title={tt.openMember}
      className={cn(
        "group relative flex min-w-0 flex-col gap-2 overflow-hidden rounded-lg border bg-surface p-2.5 text-left transition-colors hover:border-border-strong hover:bg-surface-2",
        working ? "border-border-strong" : "border-border",
        m.state === "failed" && "border-danger/40",
      )}
      style={{ "--team-color": meta.color } as CSSProperties}
    >
      {working && <span className="team-scan absolute inset-x-0 top-0 h-0.5" aria-hidden />}
      <div className="flex min-w-0 items-center gap-2">
        <RoleAvatar member={m} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-medium leading-tight">{m.title}</div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className="text-caption-lg font-medium" style={{ color: meta.color }}>
              {tt.role[m.role ?? "other"]}
            </span>
            <ModelChip model={m.model} />
          </div>
        </div>
      </div>
      <div className={cn("min-h-4 truncate font-mono text-caption-lg", working ? "text-fg/80" : "text-muted")}>
        {working ? (
          m.activity ? (
            <>
              {m.activity}
              <span className="ml-0.5 inline-block h-3 w-1 translate-y-0.5 animate-soft-pulse bg-current" />
            </>
          ) : (
            <span className="text-subtle">…</span>
          )
        ) : (
          (m.result?.split("\n").find((l) => l.trim()) ?? tt.state[m.state])
        )}
      </div>
      <div className="flex items-center gap-2 text-caption text-subtle">
        <span className={cn("font-medium", m.state === "done" && "text-success", m.state === "failed" && "text-danger", working && "text-fg/70")}>{tt.state[m.state]}</span>
        <span>·</span>
        <span className="tabular-nums">{working ? tt.elapsed(shortDuration(ms)) : tt.took(shortDuration(ms))}</span>
        {m.toolUses > 0 && (
          <>
            <span>·</span>
            <span className="tabular-nums">{tt.tools(m.toolUses)}</span>
          </>
        )}
        {m.files.length > 0 && (
          <>
            <span>·</span>
            <span className="tabular-nums" title={m.files.join("\n")}>
              {tt.files(m.files.length)}
            </span>
          </>
        )}
      </div>
    </button>
  );
}

const TASK_ICON = { completed: CheckCircle2, in_progress: CircleDashed, pending: Circle } as const;

export function PlanList({ tasks, className }: { tasks: TeamTask[]; className?: string }) {
  const tt = t.workspace.teams;
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-surface p-2.5", className)}>
      <div className="mb-1.5 flex items-center gap-1.5 text-caption-lg font-semibold uppercase tracking-wide text-muted">
        <ListChecks className="h-3.5 w-3.5" /> {tt.plan}
        <div className="flex-1" />
        <PlanProgress tasks={tasks} />
      </div>
      {tasks.length ? (
        <ul className="flex flex-col gap-1">
          {tasks.map((task) => {
            const Icon = TASK_ICON[task.status];
            return (
              <li key={task.id} className="flex items-start gap-1.5 text-small" onContextMenu={contextItems(() => [{ label: t.workspace.teams.copyGoal, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(task.subject) }])}>
                <Icon
                  className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0",
                    task.status === "completed" ? "text-success" : task.status === "in_progress" ? "animate-spin-slow text-accent" : "text-subtle",
                  )}
                />
                <span className={cn("min-w-0", task.status === "completed" && "text-muted line-through decoration-border-strong", task.status === "in_progress" && "text-fg")}>
                  {task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-small text-muted">{tt.noPlan}</p>
      )}
    </div>
  );
}

/** Lead bar and three member cards in their final sizes. */
function TeamBoardSkeleton() {
  return (
    <SkeletonRegion label={t.workspace.teams.loading} className="shrink-0 border-b border-border px-4 pb-3">
      <div className="flex h-11 items-center gap-2.5">
        <Skeleton className="h-6 w-6 rounded-full" />
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-3 w-44" />
        <div className="flex-1" />
        <Skeleton className="h-4 w-10" />
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[94px] rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-[94px] rounded-lg" />
      </div>
    </SkeletonRegion>
  );
}


import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownToLine,
  Bot,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  Crown,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Hand,
  Hourglass,
  KeyRound,
  ListPlus,
  LogIn,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Play,
  Radio,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { CREW_INVITE_PREFIX, type Crew, type CrewFeedItem, type CrewJoinRequest, type CrewMember, type CrewTask, type CrewTaskStatus, type Project } from "@forge/protocol";
import { call, keys, useCrew, useProjects } from "@/lib/queries";
import { useTeamsAllowed } from "@/lib/agent-teams";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { crewChanged, memberName, openCrew, others, pullCrew, respondCrew, startCrewTask } from "@/lib/crew";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, type MenuItem } from "@/components/ui/dropdown";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { CrewSettingsDialog, InviteDialog, MemberAvatar, TaskDialog } from "./CrewDialogs";
import { t } from "@/i18n";

const m = t.crew;
const ic = "h-3.5 w-3.5";
/** id of the message field, so the palette and the member menu can put the cursor there */
export const CREW_MESSAGE_INPUT = "crew-message-input";
const EVERYONE = "*";

/**
 * Crew tab of a project: live collaboration with other FORGE installations. Without a crew it offers
 * to start or join one; while a join request waits it shows the check code; as a member the crew's
 * members with their agents, the shared task board and the activity with the message field.
 */
export function CrewTab({ project }: { project: Project }) {
  const rootId = project.parentId ?? project.id;
  const q = useCrew(rootId);
  if (q.isPending) return <CrewSkeleton />;
  if (q.isError)
    return (
      <div className="p-5">
        <ErrorBanner title={m.notLoaded}>{errorMessage(q.error)}</ErrorBanner>
      </div>
    );
  const crew = q.crew;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-5">
        {!crew ? <CrewWelcome project={project} rootId={rootId} /> : crew.membership === "member" ? <CrewBoard crew={crew} /> : <CrewWaiting crew={crew} />}
      </div>
    </div>
  );
}

/** A dialog asked for by the palette, a toast or the header; taken once the tab shows. */
function useCrewRequest(handle: (kind: NonNullable<ReturnType<typeof useUi.getState>["crewRequest"]>["kind"]) => boolean) {
  const request = useUi((s) => s.crewRequest);
  const handled = useRef(0);
  useEffect(() => {
    if (!request || request.n === handled.current) return;
    if (handle(request.kind)) {
      handled.current = request.n;
      useUi.getState().clearCrewRequest();
    }
  });
}

// ---------- without a crew

function CrewWelcome({ project, rootId }: { project: Project; rootId: string }) {
  const createRef = useRef<HTMLInputElement>(null);
  const joinRef = useRef<HTMLTextAreaElement>(null);
  // Only start and join belong here; an invite asked for right after creating waits for the board.
  useCrewRequest((kind) => {
    if (kind === "join") joinRef.current?.focus();
    else if (kind === "create") createRef.current?.focus();
    else return false;
    return true;
  });
  const features: Array<{ icon: ReactNode; text: string }> = [
    { icon: <Radio className="h-4 w-4" />, text: m.featureLive },
    { icon: <ClipboardList className="h-4 w-4" />, text: m.featureTasks },
    { icon: <ArrowDownToLine className="h-4 w-4" />, text: m.featureGit },
    { icon: <ShieldCheck className="h-4 w-4" />, text: m.featureSecure },
  ];
  return (
    <>
      <section className="flex flex-col items-center gap-3 px-4 pt-4 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
          <Users className="h-6 w-6" />
        </span>
        <h2 className="text-title-sm font-semibold">{m.welcomeTitle}</h2>
        <p className="max-w-2xl text-body text-muted">{m.welcomeText}</p>
        <ul className="mt-1 grid w-full max-w-3xl gap-2 text-left sm:grid-cols-2">
          {features.map((f) => (
            <li key={f.text} className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-fg">
              <span className="text-accent">{f.icon}</span>
              {f.text}
            </li>
          ))}
        </ul>
      </section>
      <div className="grid gap-4 md:grid-cols-2">
        <CreateCard project={project} rootId={rootId} inputRef={createRef} />
        <JoinCard project={project} rootId={rootId} inputRef={joinRef} />
      </div>
    </>
  );
}

function Card({ icon, title, text, children }: { icon: ReactNode; title: string; text: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <span className="text-accent">{icon}</span>
        <h3 className="text-body font-semibold">{title}</h3>
      </div>
      <p className="text-xs text-muted">{text}</p>
      {children}
    </section>
  );
}

function CreateCard({ project, rootId, inputRef }: { project: Project; rootId: string; inputRef: React.RefObject<HTMLInputElement | null> }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const crew = await call("crew.create", { projectId: rootId, name: name.trim() || undefined });
      qc.setQueryData(keys.crews(rootId), [crew]);
      crewChanged(qc, crew);
      toast.success(m.created, crew.name);
      // The invite is what comes next.
      useUi.getState().openCrew("invite");
    } catch (e) {
      toast.error(m.notCreated, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card icon={<UserPlus className="h-4 w-4" />} title={m.createTitle} text={m.createText}>
      <Field label={m.createName}>
        <Input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} placeholder={project.name} maxLength={60} onKeyDown={(e) => e.key === "Enter" && void create()} />
      </Field>
      <div className="mt-auto flex justify-end">
        <Button variant="primary" loading={busy} disabled={!project.exists} onClick={() => void create()}>
          <Users className={ic} /> {m.createButton}
        </Button>
      </div>
    </Card>
  );
}

function JoinCard({ project, rootId, inputRef }: { project: Project; rootId: string; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = code.trim().replace(/\s+/g, "");
  const looksValid = trimmed.includes(CREW_INVITE_PREFIX) && trimmed.length > CREW_INVITE_PREFIX.length + 10;
  const info = useQuery({ queryKey: ["crewInvite", trimmed], queryFn: () => call("crew.inspect", { code: trimmed }), enabled: looksValid, retry: false, staleTime: 60_000 });
  const fits = info.data?.projectIds.includes(rootId) ?? false;
  const elsewhere = info.data && !fits ? (info.data.projectIds[0] ?? null) : null;
  const join = async (projectId: string) => {
    setBusy(true);
    try {
      const crew = await call("crew.join", { projectId, code: trimmed });
      crewChanged(qc, crew);
      toast.success(m.joinSent, m.joinSentBody);
      setCode("");
      if (projectId !== rootId) openCrew(projectId);
    } catch (e) {
      toast.error(m.notJoined, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const d = info.data;
  return (
    <Card icon={<LogIn className="h-4 w-4" />} title={m.joinTitle} text={m.joinText}>
      <Field label={m.joinCode}>
        <Textarea ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} rows={3} placeholder={m.joinCodePlaceholder} className="font-mono text-[11px]" spellCheck={false} />
      </Field>
      {looksValid && info.isPending && (
        <SkeletonRegion label={m.loading} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3.5 w-1/3" />
        </SkeletonRegion>
      )}
      {info.isError && <ErrorBanner title={m.notChecked}>{errorMessage(info.error)}</ErrorBanner>}
      {d && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg/40 p-3 text-xs">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-subtle">{m.inviteCrew}</dt>
            <dd className="truncate font-medium text-fg">{d.crewName}</dd>
            <dt className="text-subtle">{m.inviteFrom}</dt>
            <dd className="truncate text-fg">{d.from}</dd>
            <dt className="text-subtle">{m.inviteProject}</dt>
            <dd className="truncate text-fg" title={d.remote ?? undefined}>
              {d.projectName}
              {d.remote && <span className="text-subtle"> · {d.remote}</span>}
            </dd>
            <dt className="text-subtle">{m.inviteExpires}</dt>
            <dd className={cn(d.expired ? "text-danger" : "text-fg")}>{d.expired ? m.inviteExpired : m.inviteUntil(relativeTime(d.expiresAt))}</dd>
          </dl>
          {d.joined ? (
            <p className="text-warning">{m.inviteJoined}</p>
          ) : fits ? (
            <p className="flex items-center gap-1.5 text-success">
              <CheckCircle2 className={ic} /> {m.inviteMatches}
            </p>
          ) : d.remote ? (
            <p className="flex items-start gap-1.5 text-warning">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" /> {m.inviteOtherProject(d.remote)}
            </p>
          ) : (
            <p className="text-muted">{m.inviteNoRemote}</p>
          )}
        </div>
      )}
      <div className="mt-auto flex flex-wrap justify-end gap-2">
        {elsewhere && !d?.joined && !d?.expired && (
          <Button variant="primary" loading={busy} onClick={() => void join(elsewhere)}>
            <LogIn className={ic} /> {m.openMatching}
          </Button>
        )}
        <Button
          variant={elsewhere || (d?.remote && !fits) ? "outline" : "primary"}
          loading={busy && !elsewhere}
          disabled={!d || d.expired || d.joined || !project.exists}
          onClick={() => void join(rootId)}
        >
          <LogIn className={ic} /> {d?.remote && !fits ? m.joinAnyway : m.joinButton}
        </Button>
      </div>
    </Card>
  );
}

/** Asked to join (pending) or turned down: the check code to read out, or the way out. */
function CrewWaiting({ crew }: { crew: Crew }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    setBusy(true);
    try {
      await call("crew.leave", { crewId: crew.id });
      crewChanged(qc, crew);
    } catch (e) {
      toast.error(m.notLeft, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (crew.membership === "rejected") {
    return (
      <EmptyState
        icon={<X className="h-9 w-9" />}
        title={m.rejectedTitle}
        action={
          <Button size="sm" variant="outline" loading={busy} onClick={() => void leave()}>
            {m.dismiss}
          </Button>
        }
      >
        {m.rejectedText(crew.name)}
      </EmptyState>
    );
  }
  return (
    <section className="mx-auto mt-6 flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border border-border bg-surface p-6 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <Hourglass className="h-6 w-6 animate-soft-pulse" />
      </span>
      <h2 className="text-title-sm font-semibold">{m.pendingTitle}</h2>
      <p className="text-body text-muted">{m.pendingText(crew.name)}</p>
      <div className="flex flex-col items-center gap-1">
        <span className="text-xs uppercase tracking-wide text-subtle">{m.pendingCode}</span>
        <span className="font-mono text-3xl font-semibold tracking-widest text-fg" data-testid="crew-join-code">
          {crew.joinCode ?? "—"}
        </span>
      </div>
      <p className="text-xs text-muted">{m.pendingHint}</p>
      <ConnectionState crew={crew} />
      <Button size="sm" variant="ghost" loading={busy} onClick={() => void leave()}>
        <X className={ic} /> {m.cancelJoin}
      </Button>
    </section>
  );
}

function ConnectionState({ crew }: { crew: Crew }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={crew.error ?? crew.relayUrl}>
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          crew.connection === "online" ? "bg-success" : crew.connection === "connecting" ? "animate-soft-pulse bg-warning" : "bg-danger",
        )}
        aria-hidden
      />
      {m.connection[crew.connection]}
      {crew.connection !== "online" && crew.error && <span className="max-w-60 truncate text-subtle">· {crew.error}</span>}
    </span>
  );
}

// ---------- as a member

function CrewBoard({ crew }: { crew: Crew }) {
  const qc = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [taskDialog, setTaskDialog] = useState<{ task: CrewTask | null; assignee?: string | null } | null>(null);
  const [to, setTo] = useState<string>(EVERYONE);
  const focusMessage = (memberId: string | null) => {
    setTo(memberId ?? EVERYONE);
    requestAnimationFrame(() => document.getElementById(CREW_MESSAGE_INPUT)?.focus());
  };
  useCrewRequest((kind) => {
    if (kind === "invite") setInviteOpen(true);
    else if (kind === "task") setTaskDialog({ task: null });
    else if (kind === "leave") setLeaveOpen(true);
    else if (kind === "message") focusMessage(null);
    return true;
  });
  const leave = async () => {
    try {
      await call("crew.leave", { crewId: crew.id });
      crewChanged(qc, crew);
      toast.success(m.left, crew.name);
    } catch (e) {
      toast.error(m.notLeft, errorMessage(e));
      throw e;
    }
  };
  const online = crew.members.filter((x) => x.online).length;
  const menu: MenuItem[] = [
    { label: m.invite, icon: <UserPlus className={ic} />, onSelect: () => setInviteOpen(true) },
    { label: m.addTaskTitle, icon: <ListPlus className={ic} />, onSelect: () => setTaskDialog({ task: null }) },
    { label: m.settings, icon: <Settings2 className={ic} />, onSelect: () => setSettingsOpen(true) },
    { label: m.profile, icon: <Pencil className={ic} />, onSelect: () => useUi.getState().openSettings("general") },
    ...(crew.behind > 0 ? [{ label: m.pull, icon: <ArrowDownToLine className={ic} />, onSelect: () => void pullCrew(qc, crew) }] : []),
    { label: m.leave, icon: <LogOut className={ic} />, onSelect: () => setLeaveOpen(true), danger: true },
  ];
  return (
    <>
      <header className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3" onContextMenu={contextItems(() => menu)}>
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15 text-accent">
          <Users className="h-5 w-5" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-title-sm font-semibold">{crew.name}</h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <ConnectionState crew={crew} />
            <span className="text-xs text-subtle">{m.memberCount(online, crew.members.length)}</span>
          </div>
        </div>
        <div className="flex -space-x-1 pl-1">
          {crew.members.map((x) => (
            <MemberAvatar key={x.id} name={x.name} color={x.color} size={26} className={cn("ring-2 ring-surface", !x.online && "opacity-45")} />
          ))}
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => setTaskDialog({ task: null })}>
          <ListPlus className={ic} /> {m.addTask}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setInviteOpen(true)}>
          <UserPlus className={ic} /> {m.invite}
        </Button>
        <DropdownMenu
          trigger={
            <Button size="icon-sm" variant="ghost" aria-label={m.menu} title={m.menu}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
          items={menu}
        />
      </header>

      {crew.requests.map((r) => (
        <RequestBanner key={r.id} crew={crew} request={r} />
      ))}

      {crew.behind > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-body">
          <GitCommitHorizontal className="h-4 w-4 shrink-0 text-warning" />
          <span className="flex-1">{m.behind(crew.behind)}</span>
          <Button size="sm" variant="outline" onClick={() => void pullCrew(qc, crew)}>
            <ArrowDownToLine className={ic} /> {m.pull}
          </Button>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">{m.membersTitle}</h3>
          {crew.members.map((x) => (
            <MemberCard key={x.id} crew={crew} member={x} onMessage={() => focusMessage(x.id)} onTask={() => setTaskDialog({ task: null, assignee: x.id })} />
          ))}
        </section>
        <div className="flex min-w-0 flex-col gap-5">
          <TaskBoard crew={crew} onEdit={(task) => setTaskDialog({ task })} onAdd={() => setTaskDialog({ task: null })} />
          <Feed crew={crew} to={to} onTo={setTo} />
        </div>
      </div>

      <InviteDialog crew={crew} open={inviteOpen} onOpenChange={setInviteOpen} />
      <CrewSettingsDialog crew={crew} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <TaskDialog crew={crew} task={taskDialog?.task ?? null} assignee={taskDialog?.assignee ?? null} open={!!taskDialog} onOpenChange={(o) => !o && setTaskDialog(null)} />
      <ConfirmDialog open={leaveOpen} onOpenChange={setLeaveOpen} title={m.leaveTitle} description={m.leaveDescription(crew.name)} confirmLabel={m.leave} danger onConfirm={leave} />
    </>
  );
}

function RequestBanner({ crew, request }: { crew: Crew; request: CrewJoinRequest }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const answer = async (accept: boolean) => {
    setBusy(accept ? "accept" : "decline");
    await respondCrew(qc, crew, request, accept);
    setBusy(null);
  };
  const menu = (): MenuItem[] => [
    { label: m.accept, icon: <Check className={ic} />, onSelect: () => void answer(true) },
    { label: m.decline, icon: <X className={ic} />, onSelect: () => void answer(false), danger: true },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/50 bg-accent/10 px-4 py-3 animate-rise-in" onContextMenu={contextItems(menu)} role="alert">
      <KeyRound className="h-5 w-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-body font-medium">{m.requestTitle(request.name)}</div>
        <div className="text-xs text-muted">
          {m.requestText} <span className="font-mono text-sm font-semibold tracking-wider text-fg">{request.code}</span>
          <span className="text-subtle"> · {relativeTime(request.at)}</span>
        </div>
      </div>
      <Button size="sm" variant="ghost" loading={busy === "decline"} disabled={!!busy} onClick={() => void answer(false)}>
        {m.decline}
      </Button>
      <Button size="sm" variant="primary" loading={busy === "accept"} disabled={!!busy} onClick={() => void answer(true)}>
        <Check className={ic} /> {m.accept}
      </Button>
    </div>
  );
}

function MemberCard({ crew, member, onMessage, onTask }: { crew: Crew; member: CrewMember; onMessage: () => void; onTask: () => void }) {
  const qc = useQueryClient();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const self = crew.members.find((x) => x.self);
  const canRemove = !!self?.owner && !member.self;
  const remove = async () => {
    try {
      await call("crew.removeMember", { crewId: crew.id, memberId: member.id });
      crewChanged(qc, crew);
      toast.success(m.removed(member.name));
    } catch (e) {
      toast.error(m.notRemoved, errorMessage(e));
      throw e;
    }
  };
  const menu = (): MenuItem[] => [
    ...(!member.self ? [{ label: m.messageTo(member.name), icon: <MessageSquare className={ic} />, onSelect: onMessage }] : []),
    { label: m.giveTask(member.name), icon: <ListPlus className={ic} />, onSelect: onTask },
    ...(member.files.length ? [{ label: m.copyFiles, icon: <Copy className={ic} />, onSelect: () => copyText(member.files.join("\n")) }] : []),
    ...(canRemove ? [{ label: m.removeMember, icon: <UserMinus className={ic} />, onSelect: () => setRemoveOpen(true), danger: true }] : []),
  ];
  const files = showFiles ? member.files : member.files.slice(0, 5);
  return (
    <article className={cn("flex flex-col gap-2.5 rounded-xl border bg-surface p-3", member.self ? "border-accent/40" : "border-border")} onContextMenu={contextItems(menu)}>
      <div className="flex items-center gap-2.5">
        <MemberAvatar name={member.name} color={member.color} online={member.online} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-body font-medium">{member.name}</span>
            {member.self && <span className="text-xs text-subtle">({m.you})</span>}
            {member.owner && (
              <span title={m.owner} className="text-warning">
                <Crown className={ic} aria-label={m.owner} />
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span className={member.online ? "text-success" : undefined}>{member.online ? m.online : member.lastSeen ? m.lastSeen(relativeTime(member.lastSeen)) : m.offline}</span>
            {member.branch && (
              <span className="inline-flex items-center gap-1">
                <GitBranch className="h-3 w-3" /> {member.branch}
              </span>
            )}
            {member.ahead > 0 && <span className="text-warning">{m.ahead(member.ahead)}</span>}
          </div>
        </div>
        <DropdownMenu
          trigger={
            <Button size="icon-sm" variant="ghost" aria-label={m.menu} title={m.menu}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          }
          items={menu()}
        />
      </div>

      {member.agents.length === 0 ? (
        <p className="text-xs text-subtle">{m.noAgents}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {member.agents.map((a) => (
            <li key={a.id} className="rounded-lg bg-surface-2/60 px-2.5 py-2 text-xs">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn("h-1.5 w-1.5 shrink-0 rounded-full", a.status === "working" ? "animate-pulse bg-accent" : a.status === "waiting" ? "bg-warning" : "bg-success")}
                  aria-hidden
                />
                {a.team ? <Users className="h-3 w-3 shrink-0 text-accent" aria-label={m.team} /> : <Bot className="h-3 w-3 shrink-0 text-muted" />}
                <span className="min-w-0 flex-1 truncate font-medium text-fg" title={a.team ? `${m.team}: ${a.title}` : a.title}>
                  {a.title}
                </span>
                <span className="shrink-0 text-subtle">{a.team && a.team.working > 0 ? m.teamWorking(a.team.working) : m.agentStatus[a.status]}</span>
              </div>
              {a.branch && <div className="mt-0.5 text-subtle">{m.worktree(a.branch)}</div>}
              {a.task && (
                <p className="mt-1 line-clamp-2 text-fg" title={a.task}>
                  {a.task}
                </p>
              )}
              {a.files.length > 0 && <FileChips files={a.files} max={4} />}
              {a.status === "idle" && a.lastResult && (
                <p className="mt-1 line-clamp-2 text-muted" title={a.lastResult}>
                  → {a.lastResult}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {member.files.length > 0 && (
        <div className="text-xs">
          <button type="button" className="flex items-center gap-1 text-muted hover:text-fg" onClick={() => setShowFiles(!showFiles)} aria-expanded={showFiles}>
            <FileText className="h-3 w-3" /> {m.filesInWork(member.files.length)}
          </button>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-subtle">
            {files.map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
            {!showFiles && member.files.length > files.length && (
              <li>
                <button type="button" className="text-accent hover:underline" onClick={() => setShowFiles(true)}>
                  +{member.files.length - files.length}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
      <ConfirmDialog open={removeOpen} onOpenChange={setRemoveOpen} title={m.removeTitle(member.name)} description={m.removeDescription(member.name)} confirmLabel={m.removeMember} danger onConfirm={remove} />
    </article>
  );
}

function FileChips({ files, max }: { files: string[]; max: number }) {
  const shown = files.slice(0, max);
  return (
    <div className="mt-1 flex flex-wrap gap-1" title={files.join("\n")}>
      {shown.map((f) => (
        <span key={f} className="max-w-48 truncate rounded bg-surface-3 px-1.5 py-px font-mono text-[10px] text-muted">
          {f.split("/").pop()}
        </span>
      ))}
      {files.length > max && <span className="text-[10px] text-subtle">+{files.length - max}</span>}
    </div>
  );
}

// ---------- tasks

const COLUMNS: CrewTaskStatus[] = ["open", "in_progress", "done"];

function TaskBoard({ crew, onEdit, onAdd }: { crew: Crew; onEdit: (task: CrewTask) => void; onAdd: () => void }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">{m.tasksTitle}</h3>
        <Button size="sm" variant="ghost" onClick={onAdd}>
          <ListPlus className={ic} /> {m.addTask}
        </Button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {COLUMNS.map((status) => {
          const tasks = crew.tasks.filter((x) => x.status === status);
          const shown = status === "done" ? [...tasks].reverse().slice(0, 25) : tasks;
          return (
            <div key={status} className="flex min-h-28 flex-col gap-2 rounded-xl bg-surface-2/50 p-2" data-testid={`crew-column-${status}`}>
              <div className="flex items-center justify-between px-1 text-xs text-muted">
                <span>{m.column[status]}</span>
                <span className="tabular-nums">{tasks.length}</span>
              </div>
              {shown.map((task) => (
                <TaskCard key={task.id} crew={crew} task={task} onEdit={() => onEdit(task)} />
              ))}
              {status === "open" && tasks.length === 0 && <p className="px-1 py-2 text-xs text-subtle">{m.noTasks}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TaskCard({ crew, task, onEdit }: { crew: Crew; task: CrewTask; onEdit: () => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      crewChanged(qc, crew);
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const setStatus = (status: CrewTaskStatus) => void run(() => call("crew.taskUpdate", { crewId: crew.id, taskId: task.id, status }));
  const remove = () =>
    void run(async () => {
      await call("crew.taskRemove", { crewId: crew.id, taskId: task.id });
      toast.success(m.taskDeleted);
    });
  const project = useProjects().data?.find((p) => p.id === crew.projectId) ?? null;
  const teams = useTeamsAllowed(project);
  const start = async (team = false) => {
    setBusy(true);
    await startCrewTask(qc, crew, task.id, team);
    setBusy(false);
  };
  const forOther = task.assignee && task.assignee !== crew.selfId;
  const items = (): MenuItem[] => [
    ...(task.status === "open" ? [{ label: m.start, icon: <Play className={ic} />, onSelect: () => void start(), hint: forOther ? m.forMember(memberName(crew, task.assignee)) : undefined }] : []),
    ...(task.status === "open" && teams.allowed ? [{ label: m.startTeam, icon: <Users className={ic} />, onSelect: () => void start(true), hint: m.startTeamHint }] : []),
    ...(task.status === "open" ? [{ label: m.take, icon: <Hand className={ic} />, onSelect: () => setStatus("in_progress") }] : []),
    ...(task.status !== "done" ? [{ label: m.markDone, icon: <Check className={ic} />, onSelect: () => setStatus("done") }] : []),
    ...(task.status !== "open" ? [{ label: m.reopen, icon: <RotateCcw className={ic} />, onSelect: () => setStatus("open") }] : []),
    { label: m.edit, icon: <Pencil className={ic} />, onSelect: onEdit },
    { label: m.copyTask, icon: <Copy className={ic} />, onSelect: () => copyText(`${task.title}${task.detail ? `\n\n${task.detail}` : ""}`) },
    { label: m.deleteTask, icon: <Trash2 className={ic} />, onSelect: remove, danger: true },
  ];
  const owner = task.owner ? `${memberName(crew, task.owner.member)}${task.owner.agent ? ` · ${task.owner.agent}` : ""}` : null;
  return (
    <div
      className={cn("group animate-rise-in rounded-lg border border-border bg-surface p-2.5 text-xs", task.status === "done" && "opacity-75")}
      onContextMenu={contextItems(items)}
      data-testid="crew-task"
    >
      <div className="flex items-start gap-1.5">
        {task.status === "done" ? (
          <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
        ) : task.status === "in_progress" ? (
          <span className="mt-1 h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden />
        ) : (
          <ClipboardList className="mt-px h-3.5 w-3.5 shrink-0 text-muted" />
        )}
        <span className={cn("min-w-0 flex-1 text-body text-fg", task.status === "done" && "line-through decoration-subtle")} title={task.detail || undefined}>
          {task.title}
        </span>
        <DropdownMenu
          trigger={
            <button type="button" className="-m-0.5 rounded p-0.5 text-subtle opacity-0 hover:bg-surface-3 hover:text-fg focus:opacity-100 group-hover:opacity-100" aria-label={m.menu}>
              <MoreHorizontal className={ic} />
            </button>
          }
          items={items()}
        />
      </div>
      {task.detail && task.status !== "done" && <p className="mt-1 line-clamp-2 text-muted">{task.detail}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {task.assignee && <MemberChip crew={crew} id={task.assignee} prefix={m.forMember("")} />}
        {owner && <span className="truncate text-subtle">{owner}</span>}
        {task.source === "agent" && (
          <span title={m.byAgent} className="text-subtle">
            <Bot className="h-3 w-3" aria-label={m.byAgent} />
          </span>
        )}
      </div>
      {task.note && <p className="mt-1 line-clamp-3 text-muted">→ {task.note}</p>}
      {task.status === "open" && (
        <div className="mt-2 flex gap-1.5">
          <Button size="sm" variant="outline" className="h-6 flex-1 text-[11px]" loading={busy} onClick={() => void start()}>
            <Play className="h-3 w-3" /> {m.start}
          </Button>
          {teams.allowed && (
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy} title={`${m.startTeam} (${m.startTeamHint})`} aria-label={m.startTeam} onClick={() => void start(true)}>
              <Users className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function MemberChip({ crew, id, prefix = "" }: { crew: Crew; id: string; prefix?: string }) {
  const member = crew.members.find((x) => x.id === id);
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 px-1.5 py-px text-[11px] text-fg">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: member?.color ?? "var(--color-subtle)" }} aria-hidden />
      <span className="truncate">
        {prefix.trim() ? `${prefix.trim()} ` : ""}
        {member?.self ? m.you : (member?.name ?? "?")}
      </span>
    </span>
  );
}

// ---------- feed

function feedText(crew: Crew, f: CrewFeedItem): string {
  if (f.kind === "pulled") return m.pulledText(f.text);
  if (f.kind === "joined") return m.joinedText(f.text || memberName(crew, f.from));
  if (f.kind === "left") return m.leftText(f.text || memberName(crew, f.from));
  return f.text;
}

function Feed({ crew, to, onTo }: { crew: Crew; to: string; onTo: (id: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = [...crew.feed].reverse().slice(0, 80);
  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-subtle">{m.feedTitle}</h3>
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-xs text-subtle">{m.noFeed}</p>
        ) : (
          <ol className="flex max-h-[28rem] flex-col gap-1.5 overflow-y-auto pr-1">
            {items.map((f) => {
              const from = crew.members.find((x) => x.id === f.from);
              const text = feedText(crew, f);
              const expanded = open === f.id;
              return (
                <li
                  key={f.id}
                  className={cn("animate-rise-in rounded-lg border px-3 py-2", f.kind === "message" ? "border-accent/30 bg-accent/5" : "border-border bg-surface-2/40")}
                  onContextMenu={contextItems(() => [
                    { label: m.copyMessage, icon: <Copy className={ic} />, onSelect: () => copyText(text) },
                    ...(f.files.length ? [{ label: m.copyFiles, icon: <FileText className={ic} />, onSelect: () => copyText(f.files.join("\n")) }] : []),
                    ...(from && !from.self ? [{ label: m.messageTo(from.name), icon: <MessageSquare className={ic} />, onSelect: () => onTo(from.id) }] : []),
                  ])}
                >
                  <div className="flex items-center gap-1.5 text-xs">
                    <MemberAvatar name={from?.name ?? "?"} color={from?.color ?? "var(--color-subtle)"} size={18} />
                    <span className="font-medium text-fg">{from?.self ? m.you : (from?.name ?? "?")}</span>
                    {f.agent && <span className="truncate text-subtle">· {f.agent}</span>}
                    <Badge tone={f.kind === "message" ? "accent" : f.kind === "push" ? "warning" : f.kind === "turn" ? "success" : "neutral"}>{m.kind[f.kind]}</Badge>
                    {f.to && <span className="text-subtle">{m.toMember(memberName(crew, f.to))}</span>}
                    <span className="ml-auto shrink-0 text-subtle" title={new Date(f.ts).toLocaleString()}>
                      {relativeTime(f.ts)}
                    </span>
                  </div>
                  {text && (
                    <button
                      type="button"
                      className={cn("mt-1 block w-full whitespace-pre-wrap break-words text-left text-xs text-fg", !expanded && "line-clamp-3")}
                      onClick={() => setOpen(expanded ? null : f.id)}
                    >
                      {text}
                    </button>
                  )}
                  {f.files.length > 0 && <FileChips files={f.files} max={6} />}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <Composer crew={crew} to={to} onTo={onTo} />
    </section>
  );
}

function Composer({ crew, to, onTo }: { crew: Crew; to: string; onTo: (id: string) => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const options = [{ value: EVERYONE, label: m.everyone }, ...others(crew).map((x) => ({ value: x.id, label: x.name }))];
  const target = options.some((o) => o.value === to) ? to : EVERYONE;
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await call("crew.message", { crewId: crew.id, text: text.trim(), to: target === EVERYONE ? null : target });
      setText("");
      crewChanged(qc, crew);
    } catch (e) {
      toast.error(m.notSent, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-subtle">{m.send}</h3>
      <Select value={target} onChange={onTo} options={options} size="sm" aria-label={m.recipient} />
      <Textarea
        id={CREW_MESSAGE_INPUT}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={2000}
        placeholder={m.messagePlaceholder}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[11px] text-subtle">{m.sendHint}</span>
        <Button size="sm" variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void send()}>
          <Send className={ic} /> {m.send}
        </Button>
      </div>
    </div>
  );
}

/** Header, member column and task columns at the sizes of the board, so nothing jumps when the crew arrives. */
export function CrewSkeleton() {
  return (
    <SkeletonRegion label={m.loading} className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-5">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <Skeleton className="h-9 w-9 rounded-xl" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className="flex-1" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-7 w-24" />
      </div>
      <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <div className="flex flex-col gap-5">
          <div className="grid gap-3 md:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-48 rounded-xl" />
        </div>
      </div>
    </SkeletonRegion>
  );
}

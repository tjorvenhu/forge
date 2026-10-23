import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowDownToLine,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Copy,
  Crown,
  Download,
  Eye,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Globe,
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
  Settings2,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  CREW_INVITE_PREFIX,
  type Crew,
  type CrewAgent,
  type CrewJoinRequest,
  type CrewMember,
  type CrewShare,
  type CrewShareMode,
  type CrewShareRequest,
  type CrewTask,
  type CrewTaskStatus,
  type Project,
} from "@forge/protocol";
import { call, keys, useCrew, useProjects } from "@/lib/queries";
import { useTeamsAllowed } from "@/lib/agent-teams";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { askShare, crewChanged, memberName, openCrew, openShared, pullCrew, respondCrew, respondShare, startCrewTask, stopShare } from "@/lib/crew";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, type MenuItem } from "@/components/ui/dropdown";
import { Field, Input, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { CrewSettingsDialog, InviteDialog, MemberAvatar, TaskDialog } from "./CrewDialogs";
import { CREW_MESSAGE_INPUT, CrewChat } from "./CrewChat";
import { t } from "@/i18n";

const m = t.crew;
const ic = "h-3.5 w-3.5";

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
  // The board fills the tab (chat with its field at the bottom); welcome and waiting scroll.
  if (crew?.membership === "member") return <CrewBoard crew={crew} />;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-5">{!crew ? <CrewWelcome project={project} rootId={rootId} /> : <CrewWaiting crew={crew} />}</div>
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
  const [to, setTo] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("chat");
  const focusMessage = (memberId: string | null) => {
    setTo(memberId);
    setPane("chat");
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
  const openTasks = crew.tasks.filter((x) => x.status !== "done").length;
  const menu: MenuItem[] = [
    { label: m.invite, icon: <UserPlus className={ic} />, onSelect: () => setInviteOpen(true) },
    { label: m.addTaskTitle, icon: <ListPlus className={ic} />, onSelect: () => setTaskDialog({ task: null }) },
    { label: m.settings, icon: <Settings2 className={ic} />, onSelect: () => setSettingsOpen(true) },
    { label: m.profile, icon: <Pencil className={ic} />, onSelect: () => useUi.getState().openSettings("general") },
    ...(crew.behind > 0 ? [{ label: m.pull, icon: <ArrowDownToLine className={ic} />, onSelect: () => void pullCrew(qc, crew) }] : []),
    { label: m.leave, icon: <LogOut className={ic} />, onSelect: () => setLeaveOpen(true), danger: true },
  ];
  const panes: Array<{ id: Pane; label: string; count: number | null }> = [
    { id: "chat", label: m.panes.chat, count: null },
    { id: "people", label: m.panes.people, count: online },
    { id: "tasks", label: m.panes.tasks, count: openTasks },
  ];
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5" onContextMenu={contextItems(() => menu)}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent">
          <Users className="h-4 w-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-body font-semibold leading-tight">{crew.name}</h2>
          <div className="flex flex-wrap items-center gap-x-2.5">
            <ConnectionState crew={crew} />
            <span className="text-caption-lg text-subtle">{m.memberCount(online, crew.members.length)}</span>
          </div>
        </div>
        <div className="hidden -space-x-1 pl-1 @md:flex">
          {crew.members.map((x) => (
            <MemberAvatar key={x.id} name={x.name} color={x.color} avatar={x.avatar} size={24} className={cn("ring-2 ring-bg", !x.online && "opacity-45")} />
          ))}
        </div>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="hidden @lg:inline-flex" onClick={() => setTaskDialog({ task: null })}>
          <ListPlus className={ic} /> {m.addTask}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setInviteOpen(true)}>
          <UserPlus className={ic} /> <span className="hidden @md:inline">{m.invite}</span>
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

      {(crew.requests.length > 0 || crew.shareRequests.length > 0 || crew.behind > 0) && (
        <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
          {crew.requests.map((r) => (
            <RequestBanner key={r.id} crew={crew} request={r} />
          ))}
          {crew.shareRequests.map((r) => (
            <ShareRequestBanner key={r.id} crew={crew} request={r} />
          ))}
          {crew.behind > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-small">
              <GitCommitHorizontal className="h-4 w-4 shrink-0 text-warning" />
              <span className="flex-1">{m.behind(crew.behind)}</span>
              <Button size="sm" variant="outline" onClick={() => void pullCrew(qc, crew)}>
                <ArrowDownToLine className={ic} /> {m.pull}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex shrink-0 gap-1 border-b border-border px-3 py-1.5 @3xl:hidden" role="tablist">
        {panes.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={pane === p.id}
            onClick={() => setPane(p.id)}
            className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-small font-medium transition-colors", pane === p.id ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}
          >
            {p.label}
            {p.count !== null && p.count > 0 && <span className="rounded-full bg-surface-2 px-1.5 text-caption tabular-nums text-muted">{p.count}</span>}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1">
        <CrewChat crew={crew} to={to} onTo={setTo} inputId={CREW_MESSAGE_INPUT} className={cn("min-w-0 flex-1", pane !== "chat" ? "hidden @3xl:flex" : "flex")} />
        <aside className={cn("min-h-0 w-full shrink-0 overflow-y-auto border-border @3xl:w-80 @3xl:border-l @5xl:w-96", pane === "chat" && "hidden @3xl:block")}>
          <div className={cn("flex flex-col gap-1 p-3", pane === "tasks" && "hidden @3xl:flex")}>
            <SideTitle>{m.membersTitle}</SideTitle>
            {crew.members.map((x) => (
              <MemberRow key={x.id} crew={crew} member={x} onMessage={() => focusMessage(x.id)} onTask={() => setTaskDialog({ task: null, assignee: x.id })} />
            ))}
            {crew.shares.length > 0 && (
              <>
                <SideTitle className="mt-3">{m.sharesTitle}</SideTitle>
                {[...crew.shares].reverse().map((s) => (
                  <ShareRow key={s.id} crew={crew} share={s} />
                ))}
              </>
            )}
          </div>
          <div className={cn("flex flex-col gap-2 p-3 @3xl:border-t @3xl:border-border", pane === "people" && "hidden @3xl:flex")}>
            <TaskList crew={crew} onEdit={(task) => setTaskDialog({ task })} onAdd={() => setTaskDialog({ task: null })} />
          </div>
        </aside>
      </div>

      <InviteDialog crew={crew} open={inviteOpen} onOpenChange={setInviteOpen} />
      <CrewSettingsDialog crew={crew} open={settingsOpen} onOpenChange={setSettingsOpen} />
      <TaskDialog crew={crew} task={taskDialog?.task ?? null} assignee={taskDialog?.assignee ?? null} open={!!taskDialog} onOpenChange={(o) => !o && setTaskDialog(null)} />
      <ConfirmDialog open={leaveOpen} onOpenChange={setLeaveOpen} title={m.leaveTitle} description={m.leaveDescription(crew.name)} confirmLabel={m.leave} danger onConfirm={leave} />
    </div>
  );
}

type Pane = "chat" | "people" | "tasks";

function SideTitle({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn("flex items-center justify-between px-1 pb-0.5", className)}>
      <h3 className="text-caption-lg font-semibold uppercase tracking-wide text-subtle">{children}</h3>
      {action}
    </div>
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
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/50 bg-accent/10 px-3 py-2 animate-rise-in" onContextMenu={contextItems(menu)} role="alert">
      <KeyRound className="h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-small font-medium">{m.requestTitle(request.name)}</div>
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

/** Someone wants to watch or take over one of our sessions. */
function ShareRequestBanner({ crew, request }: { crew: Crew; request: CrewShareRequest }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"allow" | "always" | "deny" | null>(null);
  const name = memberName(crew, request.from);
  const from = crew.members.find((x) => x.id === request.from);
  const takeover = request.mode === "takeover";
  const answer = async (accept: boolean, always = false) => {
    setBusy(accept ? (always ? "always" : "allow") : "deny");
    await respondShare(qc, crew, request, name, accept, always);
    setBusy(null);
  };
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-accent/50 bg-accent/10 px-3 py-2 animate-rise-in"
      role="alert"
      onContextMenu={contextItems(() => [
        { label: m.allow, icon: <Check className={ic} />, onSelect: () => void answer(true) },
        { label: m.allowAlways, icon: <ShieldCheck className={ic} />, onSelect: () => void answer(true, true) },
        { label: m.deny, icon: <X className={ic} />, onSelect: () => void answer(false), danger: true },
      ])}
    >
      <MemberAvatar name={name} color={from?.color ?? "var(--color-subtle)"} avatar={from?.avatar} size={26} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-small font-medium">
          {takeover ? <Download className={cn(ic, "text-accent")} /> : <Eye className={cn(ic, "text-accent")} />}
          {m.shareRequestTitle(name, takeover)}
        </div>
        <div className="text-xs text-muted">
          <span className="font-medium text-fg">{request.agentTitle}</span> · {m.shareRequestText(takeover)}
        </div>
      </div>
      <Button size="sm" variant="ghost" loading={busy === "deny"} disabled={!!busy} onClick={() => void answer(false)}>
        {m.deny}
      </Button>
      <Button size="sm" variant="outline" loading={busy === "always"} disabled={!!busy} onClick={() => void answer(true, true)}>
        {m.allowAlways}
      </Button>
      <Button size="sm" variant="primary" loading={busy === "allow"} disabled={!!busy} onClick={() => void answer(true)}>
        <Check className={ic} /> {m.allow}
      </Button>
    </div>
  );
}

const STATUS_DOT: Record<CrewAgent["status"], string> = { working: "animate-pulse bg-accent", waiting: "bg-warning", idle: "bg-success" };

function MemberRow({ crew, member, onMessage, onTask }: { crew: Crew; member: CrewMember; onMessage: () => void; onTask: () => void }) {
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
  return (
    <div className="rounded-lg px-1.5 py-1.5 hover:bg-surface-2/60" onContextMenu={contextItems(menu)}>
      <div className="group flex items-center gap-2">
        <MemberAvatar name={member.name} color={member.color} avatar={member.avatar} online={member.online} size={26} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-small font-medium">{member.name}</span>
            {member.self && <span className="text-caption text-subtle">({m.you})</span>}
            {member.owner && <Crown className="h-3 w-3 shrink-0 text-warning" aria-label={m.owner} />}
            {member.web && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-caption text-subtle" title={m.webMemberHint}>
                <Globe className="h-3 w-3" /> {m.webMember}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted">
            <span className={member.online ? "text-success" : undefined}>{member.online ? m.online : member.lastSeen ? m.lastSeen(relativeTime(member.lastSeen)) : m.offline}</span>
            {member.branch && (
              <span className="inline-flex items-center gap-0.5">
                <GitBranch className="h-2.5 w-2.5" /> {member.branch}
              </span>
            )}
            {member.ahead > 0 && <span className="text-warning">{m.ahead(member.ahead)}</span>}
          </div>
        </div>
        <div className="flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {!member.self && (
            <Button size="icon-sm" variant="ghost" onClick={onMessage} aria-label={m.messageTo(member.name)} title={m.messageTo(member.name)}>
              <MessageSquare className={ic} />
            </Button>
          )}
          <DropdownMenu
            trigger={
              <Button size="icon-sm" variant="ghost" aria-label={m.menu} title={m.menu}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            }
            items={menu()}
          />
        </div>
      </div>

      {member.agents.length > 0 && (
        <ul className="ml-3.5 mt-1 flex flex-col border-l border-border pl-2.5">
          {member.agents.map((a) => (
            <AgentRow key={a.id} crew={crew} member={member} agent={a} />
          ))}
        </ul>
      )}

      {member.files.length > 0 && (
        <div className="ml-9 mt-1 text-caption">
          <button type="button" className="flex items-center gap-1 text-muted hover:text-fg" onClick={() => setShowFiles(!showFiles)} aria-expanded={showFiles}>
            <FileText className="h-3 w-3" /> {m.filesInWork(member.files.length)}
          </button>
          {showFiles && (
            <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-subtle">
              {member.files.map((f) => (
                <li key={f} className="truncate" title={f}>
                  {f}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog open={removeOpen} onOpenChange={setRemoveOpen} title={m.removeTitle(member.name)} description={m.removeDescription(member.name)} confirmLabel={m.removeMember} danger onConfirm={remove} />
    </div>
  );
}

/** A session of a member; another member's can be watched live or taken over from here. */
function AgentRow({ crew, member, agent: a }: { crew: Crew; member: CrewMember; agent: CrewAgent }) {
  const qc = useQueryClient();
  const canShare = !member.self && member.online;
  const ask = (mode: CrewShareMode) => void askShare(qc, crew, member.id, a.id, mode);
  const items = (): MenuItem[] => [
    ...(canShare
      ? [
          { label: m.viewSession, icon: <Eye className={ic} />, onSelect: () => ask("view"), hint: m.viewSessionHint },
          { label: m.takeoverSession, icon: <Download className={ic} />, onSelect: () => ask("takeover"), hint: m.takeoverSessionHint },
        ]
      : []),
    ...(a.task ? [{ label: m.copyTask, icon: <Copy className={ic} />, onSelect: () => copyText(a.task!) }] : []),
    ...(a.files.length ? [{ label: m.copyFiles, icon: <FileText className={ic} />, onSelect: () => copyText(a.files.join("\n")) }] : []),
  ];
  return (
    <li className="group/agent rounded-md px-1.5 py-1 hover:bg-surface-3/50" onContextMenu={contextItems(items)}>
      <div className="flex items-center gap-1.5 text-caption-lg">
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_DOT[a.status])} aria-hidden />
        {a.team ? <Users className="h-3 w-3 shrink-0 text-accent" aria-label={m.team} /> : <Bot className="h-3 w-3 shrink-0 text-muted" />}
        <span className="min-w-0 flex-1 truncate font-medium text-fg" title={a.team ? `${m.team}: ${a.title}` : a.title}>
          {a.title}
        </span>
        {canShare ? (
          <span className="flex shrink-0 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/agent:opacity-100">
            <button type="button" className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-fg" onClick={() => ask("view")} title={`${m.viewSession}: ${m.viewSessionHint}`} aria-label={m.viewSession}>
              <Eye className="h-3.5 w-3.5" />
            </button>
            <button type="button" className="rounded p-0.5 text-muted hover:bg-surface-3 hover:text-fg" onClick={() => ask("takeover")} title={`${m.takeoverSession}: ${m.takeoverSessionHint}`} aria-label={m.takeoverSession}>
              <Download className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : null}
        <span className="shrink-0 text-caption text-subtle group-hover/agent:hidden">{a.team && a.team.working > 0 ? m.teamWorking(a.team.working) : m.agentStatus[a.status]}</span>
      </div>
      {a.task && (
        <p className="ml-3 mt-0.5 line-clamp-1 text-caption text-muted" title={a.task}>
          {a.task}
        </p>
      )}
      {a.status === "idle" && a.lastResult && (
        <p className="ml-3 mt-0.5 line-clamp-1 text-caption text-subtle" title={a.lastResult}>
          → {a.lastResult}
        </p>
      )}
      {a.files.length > 0 && (
        <div className="ml-3">
          <FileChips files={a.files} max={3} />
        </div>
      )}
    </li>
  );
}

/** A session of another member we asked for: how far it got, and the copy to open. */
function ShareRow({ crew, share: s }: { crew: Crew; share: CrewShare }) {
  const qc = useQueryClient();
  const from = crew.members.find((x) => x.id === s.member);
  const running = s.state === "asking" || s.state === "transferring" || s.state === "importing" || s.state === "live";
  const pct = s.total ? Math.round((s.received / s.total) * 100) : 0;
  const tone = s.state === "failed" || s.state === "declined" ? "text-danger" : s.state === "live" ? "text-accent" : s.state === "done" ? "text-success" : "text-muted";
  return (
    <div className="rounded-lg border border-border bg-surface px-2.5 py-2 text-caption-lg">
      <div className="flex items-center gap-1.5">
        {s.mode === "view" ? <Eye className="h-3.5 w-3.5 shrink-0 text-muted" /> : <Download className="h-3.5 w-3.5 shrink-0 text-muted" />}
        <span className="min-w-0 flex-1 truncate font-medium text-fg" title={s.agentTitle}>
          {s.agentTitle}
        </span>
        <span className={cn("shrink-0 font-medium", tone)}>
          {s.state === "live" && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle" />}
          {m.shareState[s.state]}
          {s.state === "transferring" && s.total ? ` ${pct} %` : ""}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-caption text-subtle">
        <MemberAvatar name={from?.name ?? "?"} color={from?.color ?? "var(--color-subtle)"} avatar={from?.avatar} size={14} />
        {from?.name ?? "?"} · {relativeTime(s.at)}
      </div>
      {s.state === "transferring" && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}
      {s.error && <p className="mt-1 text-caption text-danger">{s.error}</p>}
      {(s.sessionId || running) && (
        <div className="mt-1.5 flex gap-1.5">
          {s.sessionId && s.projectId && (
            <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => openShared(s.projectId!, s.sessionId!)}>
              {m.openCopy}
            </Button>
          )}
          {running && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void stopShare(qc, crew, s.id)}>
              {m.stopShare}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function FileChips({ files, max }: { files: string[]; max: number }) {
  const shown = files.slice(0, max);
  return (
    <div className="mt-1 flex flex-wrap gap-1" title={files.join("\n")}>
      {shown.map((f) => (
        <span key={f} className="max-w-40 truncate rounded bg-surface-3 px-1.5 py-px font-mono text-[10px] text-muted">
          {f.split("/").pop()}
        </span>
      ))}
      {files.length > max && <span className="text-[10px] text-subtle">+{files.length - max}</span>}
    </div>
  );
}

// ---------- tasks

function TaskList({ crew, onEdit, onAdd }: { crew: Crew; onEdit: (task: CrewTask) => void; onAdd: () => void }) {
  const [showDone, setShowDone] = useState(false);
  const running = crew.tasks.filter((x) => x.status === "in_progress");
  const open = crew.tasks.filter((x) => x.status === "open");
  const done = [...crew.tasks.filter((x) => x.status === "done")].reverse();
  const group = (status: CrewTaskStatus, tasks: CrewTask[]) =>
    tasks.length > 0 && (
      <div className="flex flex-col gap-1.5" data-testid={`crew-column-${status}`}>
        <div className="flex items-center gap-1.5 px-1 text-caption text-muted">
          {m.column[status]} <span className="tabular-nums text-subtle">{tasks.length}</span>
        </div>
        {tasks.map((task) => (
          <TaskCard key={task.id} crew={crew} task={task} onEdit={() => onEdit(task)} />
        ))}
      </div>
    );
  return (
    <>
      <SideTitle
        action={
          <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={onAdd}>
            <ListPlus className={ic} /> {m.addTask}
          </Button>
        }
      >
        {m.tasksTitle}
      </SideTitle>
      {running.length + open.length === 0 && <p className="px-1 text-xs text-subtle">{m.noTasks}</p>}
      {group("in_progress", running)}
      {group("open", open)}
      {done.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="crew-column-done">
          <button type="button" className="flex items-center gap-1 px-1 text-left text-caption text-muted hover:text-fg" onClick={() => setShowDone(!showDone)} aria-expanded={showDone}>
            <ChevronRight className={cn("h-3 w-3 transition-transform", showDone && "rotate-90")} /> {m.column.done} <span className="tabular-nums text-subtle">{done.length}</span>
          </button>
          {showDone && done.slice(0, 25).map((task) => <TaskCard key={task.id} crew={crew} task={task} onEdit={() => onEdit(task)} />)}
        </div>
      )}
    </>
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

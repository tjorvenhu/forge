import { useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Copy, Crown, MessageSquareText, Power, Users } from "lucide-react";
import { TEAM_LEAD_MODELS, type AgentTeam, type Project, type TeamLeadModel, type TeamRoleModels } from "@forge/protocol";
import { useAgentTeams, useSettings, useUsage } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { contextItems, copyText } from "@/lib/context-menu";
import { leadState, MODEL_META, openTeam, saveTeamRoleModels, startTeam, stopTeam, teamBusy, useTeamDialog, useTeamsAllowed } from "@/lib/agent-teams";
import { cn, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/input";
import { Checkbox, EmptyState, ErrorBanner, SectionTitle } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { LimitForecastWarning } from "@/components/usage/UsageWindows";
import { LeadAvatar, ModelChip, PlanProgress, RoleAvatar } from "./TeamBoard";
import { RoleModelsEditor } from "./TeamModels";
import { t } from "@/i18n";

/**
 * Agent teams of the project: sessions whose lead plans a goal and staffs subagents with roles and
 * models. Each card opens the lead's chat, where the team board shows every member live.
 */
export function AgentTeamsSection({ project }: { project: Project }) {
  const teams = useAgentTeams(project.id);
  const allowed = useTeamsAllowed(project);
  const dialogFor = useTeamDialog((s) => s.projectId);
  const openDialog = () => useTeamDialog.getState().open(project.id);
  const tt = t.workspace.teams;
  // Switched off: nothing to see, unless a team still works and needs stopping.
  if (!allowed.allowed && !teams.data?.some(teamBusy)) return null;
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
          <Button size="sm" variant="primary" onClick={openDialog} disabled={!project.exists || !allowed.allowed}>
            <Users className="h-3.5 w-3.5" /> {tt.start}
          </Button>
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
      {teams.isLoading && <TeamListSkeleton />}
      {teams.isError && <ErrorBanner title={tt.notLoaded}>{errorMessage(teams.error)}</ErrorBanner>}
      {teams.isSuccess && teams.data.length === 0 && (
        <EmptyState
          icon={<Users className="h-9 w-9" />}
          title={tt.emptyTitle}
          action={
            <Button size="sm" variant="outline" onClick={openDialog} disabled={!project.exists || !allowed.allowed}>
              {tt.start}
            </Button>
          }
        >
          {tt.emptyText}
        </EmptyState>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
        {teams.data?.map((team) => <TeamCard key={team.sessionId} team={team} />)}
      </div>
      <StartTeamDialog open={dialogFor === project.id} onOpenChange={(o) => !o && useTeamDialog.getState().close()} project={project} />
    </section>
  );
}

function TeamCard({ team }: { team: AgentTeam }) {
  const tt = t.workspace.teams;
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const busy = teamBusy(team);
  const state = leadState(team);
  const working = team.members.filter((m) => m.state === "working").length;
  const done = team.tasks.filter((x) => x.status === "completed").length;
  const pct = team.tasks.length ? Math.round((done / team.tasks.length) * 100) : 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openTeam(team)}
      onKeyDown={(e) => {
        if (e.key === "Enter") openTeam(team);
      }}
      title={tt.openTitle}
      onContextMenu={contextItems(() => [
        { label: tt.open, icon: <MessageSquareText className="h-3.5 w-3.5" />, onSelect: () => openTeam(team) },
        ...(busy ? [{ label: tt.stop, icon: <Power className="h-3.5 w-3.5" />, danger: true, onSelect: () => setConfirm(true) }] : []),
        ...(team.title ? [{ label: tt.copyGoal, icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(team.title!) }] : []),
      ])}
      className={cn(
        "group relative flex cursor-pointer flex-col gap-3 overflow-hidden rounded-xl border bg-surface p-3.5 transition-colors hover:border-border-strong hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent",
        busy ? "border-accent/40" : "border-border",
      )}
    >
      {busy && <span className="team-scan absolute inset-x-0 top-0 h-0.5" style={{ "--team-color": "var(--color-accent)" } as CSSProperties} aria-hidden />}
      <div className="flex items-start gap-2.5">
        <LeadAvatar busy={busy} ended={!team.live} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-body font-medium leading-snug">{team.title ?? "—"}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption-lg text-muted">
            <ModelChip model={team.leadModel} />
            <span className={cn(busy && "text-accent", state === "approval" && "text-warning")}>{tt.leadState[state]}</span>
            <span>·</span>
            <span>{relativeTime(team.createdAt)}</span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center -space-x-1.5">
          {team.members.slice(-7).map((m) => (
            <span key={m.id} className="rounded-full bg-surface ring-2 ring-surface" title={`${tt.role[m.role ?? "other"]}: ${m.title}`}>
              <RoleAvatar member={m} size="sm" />
            </span>
          ))}
        </div>
        <span className="min-w-0 truncate text-caption-lg text-muted">
          {tt.counts(team.members.length)}
          {working > 0 && <span className="text-accent"> · {working} {tt.working}</span>}
        </span>
        <div className="flex-1" />
        <PlanProgress tasks={team.tasks} />
      </div>
      {team.tasks.length > 0 && (
        <div className="h-1 overflow-hidden rounded-full bg-surface-3">
          <div className={cn("h-full rounded-full transition-[width] duration-500", pct === 100 ? "bg-success" : "bg-accent")} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={(e) => (e.stopPropagation(), openTeam(team))}>
          <MessageSquareText className="h-3.5 w-3.5" /> {tt.open}
        </Button>
        {busy && (
          <Button size="sm" variant="danger-ghost" onClick={(e) => (e.stopPropagation(), setConfirm(true))}>
            <Power className="h-3.5 w-3.5" /> {tt.stop}
          </Button>
        )}
      </div>
      <div onClick={(e) => e.stopPropagation()}>
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
    </div>
  );
}

function StartTeamDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange: (o: boolean) => void; project: Project }) {
  const tt = t.workspace.teams;
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [lead, setLead] = useState<TeamLeadModel>(TEAM_LEAD_MODELS[0]);
  const [busy, setBusy] = useState(false);
  const usage = useUsage();
  const settings = useSettings();
  const defaults = settings.data?.teamRoleModels ?? {};
  // The dialog starts with the defaults from the settings each time it opens.
  const [roleModels, setRoleModels] = useState<TeamRoleModels>(defaults);
  const [remember, setRemember] = useState(false);
  const [openedWith, setOpenedWith] = useState<boolean>(false);
  if (open !== openedWith) {
    setOpenedWith(open);
    if (open) {
      setRoleModels(defaults);
      setRemember(false);
    }
  }
  const changed = JSON.stringify(roleModels) !== JSON.stringify(defaults);
  const start = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    if (changed && remember) await saveTeamRoleModels(qc, roleModels);
    const s = await startTeam(qc, project.id, prompt.trim(), lead, roleModels);
    setBusy(false);
    if (s) {
      setPrompt("");
      onOpenChange(false);
    }
  };
  const windows = usage.data?.available ? usage.data.windows.slice(0, 2) : [];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={tt.startTitle}
      description={tt.startDescription(project.name)}
      className="w-180"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {tt.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={!prompt.trim()} onClick={() => void start()}>
            <Users className="h-3.5 w-3.5" /> {tt.startButton}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={tt.goal} hint={tt.goalHint}>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void start();
              }
            }}
            rows={4}
            placeholder={tt.goalPlaceholder}
            autoFocus
          />
        </Field>

        <div>
          <div className="mb-1.5 text-small font-medium">{tt.leadModel}</div>
          <div role="radiogroup" aria-label={tt.leadModel} className="grid grid-cols-3 gap-2">
            {TEAM_LEAD_MODELS.map((m) => {
              const meta = MODEL_META[m];
              const checked = lead === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setLead(m)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left transition-colors",
                    checked ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong hover:bg-surface-2",
                  )}
                >
                  <span className="flex items-center gap-1.5 text-body font-medium">
                    <Crown className="h-3.5 w-3.5" style={{ color: meta.color }} /> {tt.leadModels[m].label}
                  </span>
                  <span className="text-caption-lg text-muted">{tt.leadModels[m].note}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-baseline gap-2">
            <span className="shrink-0 text-small font-medium">{tt.roster}</span>
            <span className="text-caption-lg text-muted">
              {tt.rosterHint} {tt.roleModelsHint}
            </span>
          </div>
          <RoleModelsEditor value={roleModels} onChange={setRoleModels} compact />
          {changed && (
            <div className="mt-2">
              <Checkbox checked={remember} onChange={setRemember} label={tt.saveAsDefault} />
            </div>
          )}
        </div>

        <div role="note" className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-small">
            <div className="font-medium">{tt.usageTitle}</div>
            <div className="text-muted">{tt.usageText}</div>
            {windows.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-caption-lg">
                {windows.map((w) => (
                  <span key={w.key} className={cn("tabular-nums", w.utilization >= 80 ? "text-danger" : w.utilization >= 50 ? "text-warning" : "text-muted")}>
                    {tt.usageNow(w.label, Math.round(w.utilization))}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <LimitForecastWarning />
      </div>
    </Dialog>
  );
}

/** Two team cards in their final sizes. */
function TeamListSkeleton() {
  return (
    <SkeletonRegion label={t.workspace.teams.loading} className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3.5">
          <div className="flex items-start gap-2.5">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-1 w-full rounded-full" />
          <Skeleton className="h-7 w-20" />
        </div>
      ))}
    </SkeletonRegion>
  );
}

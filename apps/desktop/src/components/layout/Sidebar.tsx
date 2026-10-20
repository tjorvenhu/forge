import { Download, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { UsageWindow } from "@forge/protocol";
import { usageItems } from "@/components/usage/UsageWindows";
import { forecastLabel, forecastSentence } from "@/lib/usage-forecast";
import { call,useClaudeSetup, useClaudeUpdate, useDiagnostics, useGitHubAccount, useLiveSessions, useProjects, useUsage } from "@/lib/queries";
import { AuthorAvatar } from "@/components/git/AuthorAvatar";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { DropdownMenu } from "@/components/ui/dropdown";
import { claudeAccountItems } from "@/components/settings/ClaudeLoginDialog";
import { contextItems } from "@/lib/context-menu";
import { useUi, type View } from "@/stores/ui";
import { cn, planLabel, relativeTime } from "@/lib/utils";
import { Logo } from "./Logo";
import { AppUpdateCard } from "./AppUpdate";
import { splitProjects } from "@/lib/project-tree";
import { NAV } from "./nav";
import { OpenSessions, SplitViewEntry } from "./OpenSessions";
import { SearchField } from "./SearchField";
import { DevChannelBadge } from "./DevChannelBadge";
import { SupportButton } from "@/components/settings/SupportSettings";
import { ErrorBoundary } from "./ErrorBoundary";
import { TokenRate } from "./TokenRate";
import { locale, t } from "@/i18n";

export function Sidebar() {
  const view = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const setNewProject = useUi((s) => s.setNewProject);
  const projects = useProjects();
  const live = useLiveSessions();
  const liveCount = live.data?.length ?? 0;
  // Agents (worktrees) belong to their project and are not counted on their own.
  const list = splitProjects(projects.data ?? []).roots;
  const activeProjectId = useUi((s) => s.activeProjectId);
  const hasSplit = useUi((s) => s.splitPanes.length > 0);
  const hasOpen = liveCount > 0 || (activeProjectId !== null && (view === "workspace" || hasSplit));
  const counts: Partial<Record<View, { n: number; label: string }>> = {
    projects: { n: list.length, label: t.layout.sidebar.projectCount(list.length) },
    sessions: { n: liveCount, label: t.layout.sidebar.openSessionCount(liveCount) },
  };

  return (
    <aside className="flex w-64 shrink-0 select-none flex-col border-r border-border bg-sidebar">
      <div className="flex items-center px-5 pb-4 pt-5">
        <Logo height={36} />
      </div>
      <DevChannelBadge />

      <div className="flex items-center gap-1.5 px-3">
        <div className="min-w-0 flex-1">
          <SearchField />
        </div>
        <SupportButton />
      </div>

      <nav className="flex flex-col gap-1 px-3 pt-2" aria-label={t.layout.sidebar.mainNav}>
        {NAV.map((n) => {
          const active = view === n.view || (n.view === "projects" && view === "workspace");
          const count = counts[n.view];
          const badge = count && count.n > 0 ? count : null;
          return (
            <button
              key={n.view}
              onClick={() => setView(n.view)}
              aria-current={active ? "page" : undefined}
              title={badge?.label}
              className={cn(
                // Same weight active or not: a bolder label would make the text jump.
                "flex h-10 items-center gap-3 rounded-lg px-3 text-ui transition-[color,background-color,transform] duration-120 active:scale-[0.98]",
                active ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <span className={active ? "text-accent" : ""}>
                <n.Icon className="h-4.5 w-4.5" />
              </span>
              <span className="flex-1 text-left">{n.label}</span>
              {badge && (
                <span className={cn("rounded-md px-2 py-0.5 text-caption tabular-nums", active ? "bg-accent/25 text-fg" : "bg-surface-3 text-muted")}>{badge.n}</span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mx-4 mt-3 border-t border-border" />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3">
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="text-body text-muted">{t.layout.sidebar.opened}</span>
          <Button size="icon-sm" variant="ghost" onClick={() => setNewProject("import")} className="h-6 w-6 text-subtle hover:bg-surface-2" aria-label={t.layout.sidebar.addProject} title={t.layout.sidebar.addProject}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <ErrorBoundary>
          <SplitViewEntry />
          <OpenSessions />
        </ErrorBoundary>
        {/* While these load, OpenSessions shows its skeleton in place of the hint. */}
        {!hasOpen && !live.isPending && !projects.isPending && (
          <>
            <p className="px-3 pb-2 text-small text-subtle">{t.layout.sidebar.noneOpen}</p>
            <Button
              variant="outline"
              onClick={() => setNewProject("import")}
              className="h-11 w-full justify-start gap-2.5 rounded-lg border-dashed px-3 text-body-lg font-normal text-muted hover:border-border-strong hover:bg-transparent hover:text-fg"
            >
              <Plus className="h-4 w-4" /> {t.layout.sidebar.addProject}
            </Button>
          </>
        )}
      </div>

      <ClaudeStatusCard />
    </aside>
  );
}

function ClaudeStatusCard() {
  const diag = useDiagnostics();
  const setup = useClaudeSetup().data;
  const usage = useUsage();
  const qc = useQueryClient();
  const openSettings = useUi((s) => s.openSettings);
  const d = diag.data;
  let tone = "bg-danger";
  let line = t.layout.sidebar.statusUnknown;
  if (d) {
    if (!d.claude.found && setup?.task === "install" && setup.phase === "running") {
      tone = "bg-warning animate-soft-pulse";
      line = t.layout.sidebar.installing;
    } else if (!d.claude.found) {
      tone = "bg-danger";
      line = t.layout.sidebar.cliMissing;
    } else if (!d.auth.loggedIn) {
      tone = "bg-danger";
      line = t.layout.sidebar.notLoggedIn;
    } else {
      tone = d.apiKeyEnvPresent && !d.apiKeyStripped ? "bg-warning" : "bg-success";
      line = planLabel(d.auth) ?? d.auth.authMethod ?? t.layout.sidebar.loggedIn;
    }
  }
  const windows = usage.data?.available ? usage.data.windows.slice(0, 3) : [];
  const items = () => [...(d?.auth.loggedIn ? usageItems(qc, () => openSettings("claude")) : []), ...claudeAccountItems(d, () => openSettings("claude"))];
  const summary = (
    // The menu hands focus back to the button when it closes; the global focus outline would frame the card.
    <button className="flex flex-col gap-2 text-left focus-visible:outline-none" title={t.layout.sidebar.cardTitle}>
      <div className="flex w-full items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-body">Claude Code</div>
          {diag.isPending ? (
            <SkeletonRegion label={t.layout.sidebar.loadingClaude} className="flex h-4 items-center">
              <Skeleton className="h-2.5 w-24" />
            </SkeletonRegion>
          ) : (
            <div className="flex items-center gap-1.5 text-caption text-muted">
              <span className={cn("h-1.5 w-1.5 rounded-full", tone)} />
              {line}
            </div>
          )}
        </div>
        <GitHubAvatar />
      </div>
      {usage.isPending ? (
        <SkeletonRegion label={t.layout.sidebar.loadingUsage} className="flex w-full flex-col gap-1.5">
          {[0, 1].map((i) => (
            <div key={i}>
              <div className="mb-0.5 flex h-4 items-center justify-between">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-2.5 w-8" />
              </div>
              <Skeleton className="h-1 rounded-full" />
            </div>
          ))}
        </SkeletonRegion>
      ) : (
        windows.length > 0 && (
          <div className="flex w-full flex-col gap-1.5" aria-label={t.layout.sidebar.usageLabel}>
            {windows.map((w) => (
              <UsageBar key={w.key} w={w} />
            ))}
          </div>
        )
      )}
      <TokenRate />
    </button>
  );
  return (
    <>
      <AppUpdateCard />
      <div className="m-3 flex flex-col gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 hover:border-border-strong" onContextMenu={contextItems(items)}>
        <DropdownMenu align="start" header={d?.auth.loggedIn ? `Claude Code · ${line}` : "Claude Code"} items={items()} trigger={summary} />
        <ClaudeUpdateButton />
      </div>
    </>
  );
}

/** Picture of the signed-in GitHub account; nothing without a login. */
function GitHubAvatar() {
  const account = useGitHubAccount();
  if (account.isPending) return <Skeleton className="h-6 w-6 shrink-0 rounded-full" />;
  const a = account.data;
  if (!a) return null;
  return (
    <span title={t.layout.sidebar.githubAs(a.login)}>
      <AuthorAvatar name={a.name ?? a.login} url={a.avatarUrl} className="h-6 w-6" />
    </span>
  );
}

function ClaudeUpdateButton() {
  const update = useClaudeUpdate();
  const setup = useClaudeSetup();
  const updating = setup.data?.task === "update" && setup.data.phase === "running";
  const info = update.data;
  if (!updating && !info?.available) return null;
  return (
    <Button
      size="sm"
      variant="primary"
      className="w-full"
      loading={updating}
      disabled={setup.data?.phase === "running"}
      title={info ? t.layout.sidebar.claudeUpdateTitle(info.installed ?? t.layout.sidebar.unknown, info.latest ?? "", info.channel) : undefined}
      onClick={() => call("claude.update", {}).catch((e: unknown) => toast.error(t.layout.sidebar.updateNotStarted, errorMessage(e)))}
    >
      {updating ? t.layout.sidebar.claudeUpdating : (
        <>
          <Download className="h-3.5 w-3.5" /> {t.layout.sidebar.claudeUpdate(info?.latest ?? "")}
        </>
      )}
    </Button>
  );
}

/** Tooltip of a usage bar; the stored reset time can already lie in the past until the next update. */
export function resetText(resetsAt: string, now = Date.now()): string {
  const at = new Date(resetsAt).toLocaleString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const when = relativeTime(resetsAt, now);
  const left = new Date(resetsAt).getTime() - now;
  if (left <= 0) return t.layout.sidebar.wasReset(when, at);
  // relativeTime says "just now" below 45 seconds, for a reset ahead that reads as "soon".
  return left < 45_000 ? t.layout.sidebar.resetSoon(at) : t.layout.sidebar.willReset(when, at);
}

function UsageBar({ w }: { w: UsageWindow }) {
  const { label, utilization: value, resetsAt } = w;
  const tone = value >= 95 ? "bg-danger" : value >= 80 ? "bg-warning" : "bg-accent";
  const width = Math.min(100, Math.max(0, value));
  const forecast = forecastLabel(w);
  const title = [resetsAt ? resetText(resetsAt) : null, forecastSentence(w)].filter(Boolean).join("\n");
  return (
    <div title={title}>
      <div className="mb-0.5 flex justify-between gap-2 whitespace-nowrap text-caption">
        <span className="min-w-0 truncate text-muted">{label}</span>
        <span className="shrink-0 tabular-nums text-subtle">{value} %</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={width} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={cn("h-full rounded-full", tone)} style={{ width: `${width}%` }} />
      </div>
      {forecast?.limit && <div className="mt-0.5 truncate text-caption tabular-nums text-warning">{forecast.text}</div>}
    </div>
  );
}

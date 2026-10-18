import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Download, RefreshCw, Sparkles, Workflow } from "lucide-react";
import type { AppUpdateState } from "@forge/protocol";
import { installUpdate, isWorkingSession, sessionsNote, useInstall } from "@/lib/app-install";
import { call, keys, useAppChangelog, useAppUpdate, useLiveSessions, useSettings } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner, Tooltip } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Markdown } from "@/components/workspace/Markdown";
import { useDictationQuiet } from "@/stores/dictation";
import { useUi } from "@/stores/ui";
import { Logo } from "./Logo";
import { t } from "@/i18n";

/** "kleines Update · 4 MB", "vollständiger Installer · 92 MB" or, in two steps, "erst Installer 0.1.9 · 92 MB, dann kleines Update". */
function sizeLabel(latest: NonNullable<AppUpdateState["latest"]>): string {
  const kind = latest.via ? t.layout.update.viaInstaller(latest.via) : latest.kind === "patch" ? t.layout.update.smallUpdate : t.layout.update.fullInstaller;
  const sized = latest.size ? `${kind} · ${Math.max(1, Math.round(latest.size / 1048576))} MB` : kind;
  return latest.via ? t.layout.update.thenSmallUpdate(sized) : sized;
}

/** Downloads the installer if needed, then lets the desktop shell run it; FORGE restarts on its own. */
function useInstallAction() {
  const qc = useQueryClient();
  const installing = useInstall((s) => s.installing);
  return { install: () => installUpdate(qc), installing };
}

/** What the restart means for the open sessions; nothing without any. */
export function RestartNote({ className }: { className?: string }) {
  const live = useLiveSessions().data ?? [];
  const note = sessionsNote(live.length, live.filter(isWorkingSession).length);
  if (!note) return null;
  return (
    <div className={cn("flex items-start gap-2 text-caption text-muted", className)}>
      <Workflow className="mt-px h-3.5 w-3.5 shrink-0 text-accent" />
      <span>{note}</span>
    </div>
  );
}

/** "Update available" above the Claude Code card in the sidebar; nothing when FORGE is up to date. */
export function AppUpdateCard() {
  const s = useAppUpdate().data;
  const { install, installing } = useInstallAction();
  if (!s?.latest || !["available", "downloading", "ready"].includes(s.phase)) return null;
  const busy = installing || s.phase === "downloading";
  const details = (
    <div className="flex max-w-64 flex-col gap-1.5 text-xs">
      <span>{t.layout.update.installedLine(s.currentVersion, sizeLabel(s.latest))}</span>
      {s.installable ? <RestartNote /> : <span>{t.layout.update.devOnly}</span>}
    </div>
  );
  return (
    <div className="mx-3 mt-3 flex h-9 items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft pl-2.5 pr-1 animate-slide-up-in">
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-accent" />
      <Tooltip content={details}>
        <span className="min-w-0 flex-1 cursor-default truncate text-caption">{t.layout.update.available(s.latest.version)}</span>
      </Tooltip>
      {s.installable && (
        <Button size="sm" variant="primary" className="h-6 px-2" loading={busy} onClick={() => void install()}>
          {busy ? (s.phase === "downloading" ? t.layout.update.loadingShort : t.layout.update.installingShort) : t.layout.update.install}
        </Button>
      )}
    </div>
  );
}

const OFFERED = ["available", "downloading", "ready"];

/**
 * Asks to update as soon as a new release is found (shortly after the start), but never during a
 * dictation. Each release is offered once per run; "Später" leaves the card in the sidebar.
 */
export function AppUpdateDialog() {
  const s = useAppUpdate().data;
  const settings = useSettings().data;
  const reopened = useUi((u) => u.setupWizard);
  const setupOpen = settings?.setupDone === false || reopened;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { install, installing } = useInstallAction();
  // The dialog takes the focus and the install restarts FORGE: both would cut a dictation off mid-sentence.
  const quiet = useDictationQuiet();
  // Second step of an update the user started before the restart: no second click.
  const autoStarted = useRef(false);
  const autoInstall = !!s?.autoInstall && s.installable && OFFERED.includes(s.phase);
  useEffect(() => {
    if (!autoInstall || !quiet || autoStarted.current) return;
    autoStarted.current = true;
    void install();
  }, [autoInstall, quiet, install]);
  const openSettings = useUi((u) => u.openSettings);
  const tag = s?.latest && OFFERED.includes(s.phase) ? s.latest.tag : null;
  // Not on top of the setup assistant; the offer comes once it is done. An install already asked for still runs.
  // Not during a dictation either; it comes two seconds after the last one.
  if (!s?.latest || !tag || dismissed === tag || (setupOpen && !autoInstall) || !quiet) return null;
  const busy = installing || s.phase === "downloading";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && setDismissed(tag)}
      title={t.layout.update.dialogTitle(s.latest.version)}
      description={t.layout.update.dialogDescription(s.currentVersion, s.latest.publishedAt ? relativeTime(s.latest.publishedAt) : null, sizeLabel(s.latest))}
      className="w-150"
      footer={
        <>
          {!s.installable && <span className="mr-auto self-center text-xs text-subtle">{t.layout.update.installedOnly}</span>}
          <Button variant="ghost" onClick={() => setDismissed(tag)}>
            {t.layout.update.later}
          </Button>
          <Button variant="primary" loading={busy} disabled={!s.installable} onClick={() => void install()}>
            {busy ? (s.phase === "downloading" ? t.layout.update.downloading : t.layout.update.installing) : (
              <>
                <Download className="h-3.5 w-3.5" /> {t.layout.update.updateNow}
              </>
            )}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Logo height={30} />
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted">
            <Sparkles className="h-3.5 w-3.5 text-accent" /> {t.layout.update.changesSince(s.latest.since)}
          </div>
          {s.latest.since !== s.currentVersion && (
            <div className="-mt-1 mb-2 text-caption text-subtle">{t.layout.update.olderNotListed(s.currentVersion)}</div>
          )}
          <Changelog
            tag={tag}
            notes={s.latest.notes}
            onSetup={() => {
              setDismissed(tag);
              openSettings("claude");
            }}
          />
        </div>
        {s.installable && <RestartNote className="rounded-md border border-border bg-surface-2 px-3 py-2" />}
      </div>
    </Dialog>
  );
}

/**
 * Claude's summary when it is there. Until then (and when there is none) the commit messages or the
 * release notes, so the dialog never waits on Claude.
 */
function Changelog({ tag, notes, onSetup }: { tag: string; notes: string; onSetup: () => void }) {
  const log = useAppChangelog(tag);
  const c = log.data;
  if (c?.status === "ready" && c.text)
    return (
      <div className="max-h-80 overflow-y-auto text-body animate-fade-in">
        <Markdown text={c.text} />
        <div className="mt-2 text-caption text-subtle">{t.layout.update.summarizedBy}</div>
      </div>
    );
  const raw = c?.commits.length ? c.commits.map((m) => `- ${m}`).join("\n") : notes;
  const noLogin = c?.unavailable === "no-login" || c?.unavailable === "no-claude";
  return (
    <div className="flex flex-col gap-2.5 text-body">
      {noLogin && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2">
          <p className="text-muted">{t.layout.update.noChangelog}</p>
          <Button size="sm" variant="outline" onClick={onSetup}>
            {t.layout.update.setupClaude}
          </Button>
        </div>
      )}
      {raw ? (
        <div className="max-h-60 overflow-y-auto text-muted">
          <Markdown text={raw} />
        </div>
      ) : (
        !c || c.status === "writing" ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-11/12" />
            <Skeleton className="h-3.5 w-4/5" />
          </div>
        ) : null
      )}
      {(!c || c.status === "writing") && (
        <div className="flex items-center gap-1.5 text-caption text-subtle" role="status">
          <Spinner className="h-3 w-3" /> {t.layout.update.summarizing}
        </div>
      )}
      {c?.unavailable === "error" && <div className="text-caption text-subtle">{t.layout.update.summaryUnavailable}</div>}
      {log.isError && <div className="text-caption text-subtle">{t.layout.update.changesNotLoaded(errorMessage(log.error))}</div>}
    </div>
  );
}

/** Version, last check and "check now" for the settings. */
export function AppUpdateSettings() {
  const update = useAppUpdate();
  const s = update.data;
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const { install, installing } = useInstallAction();
  const check = async () => {
    setChecking(true);
    try {
      const next = await call("app.checkUpdate", {});
      qc.setQueryData(keys.appUpdate, next);
      if (next.phase === "uptodate") toast.success(t.layout.update.upToDate, next.message ?? t.layout.update.version(next.currentVersion));
      if (next.phase === "error") toast.error(t.layout.update.checkFailed, next.message ?? "");
    } catch (e) {
      toast.error(t.layout.update.checkFailed, errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  if (update.isPending)
    return (
      <SkeletonRegion label={t.layout.update.loadingStatus} className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-2.5 w-48" />
        </div>
        <Skeleton className="h-7 w-28" />
      </SkeletonRegion>
    );
  if (!s) return null;
  const status =
    s.phase === "available" || s.phase === "ready"
      ? t.layout.update.versionAvailable(s.latest?.version ?? "")
      : s.phase === "downloading"
        ? t.layout.update.downloadingUpdate
        : s.phase === "error"
          ? (s.message ?? t.layout.update.checkFailedDot)
          : s.checkedAt
            ? (s.message ?? t.layout.update.upToDateChecked(relativeTime(s.checkedAt)))
            : t.layout.update.notChecked;
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-body">FORGE {s.currentVersion}</div>
        <div className={s.phase === "error" ? "text-xs text-danger" : "text-xs text-muted"}>{status}</div>
      </div>
      {(s.phase === "available" || s.phase === "ready") && s.installable ? (
        <Button size="sm" variant="primary" loading={installing} onClick={() => void install()}>
          <Download className="h-3.5 w-3.5" /> {t.layout.update.update}
        </Button>
      ) : (
        <Button size="sm" variant="outline" loading={checking || s.phase === "checking"} onClick={() => void check()}>
          <RefreshCw className="h-3.5 w-3.5" /> {t.layout.update.checkNow}
        </Button>
      )}
    </div>
  );
}

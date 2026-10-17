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
import { useUi } from "@/stores/ui";
import { Logo } from "./Logo";

/** "kleines Update · 4 MB", "vollständiger Installer · 92 MB" or, in two steps, "erst Installer 0.1.9 · 92 MB, dann kleines Update". */
function sizeLabel(latest: NonNullable<AppUpdateState["latest"]>): string {
  const kind = latest.via ? `erst Installer ${latest.via}` : latest.kind === "patch" ? "kleines Update" : "vollständiger Installer";
  const sized = latest.size ? `${kind} · ${Math.max(1, Math.round(latest.size / 1048576))} MB` : kind;
  return latest.via ? `${sized}, dann kleines Update` : sized;
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
      <span>
        Installiert: {s.currentVersion} · {sizeLabel(s.latest)}
      </span>
      {s.installable ? <RestartNote /> : <span>Nur in der installierten App, nicht im Entwicklungsmodus.</span>}
    </div>
  );
  return (
    <div className="mx-3 mt-3 flex h-9 items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft pl-2.5 pr-1 animate-slide-up-in">
      <ArrowUpCircle className="h-3.5 w-3.5 shrink-0 text-accent" />
      <Tooltip content={details}>
        <span className="min-w-0 flex-1 cursor-default truncate text-caption">Update auf {s.latest.version} verfügbar</span>
      </Tooltip>
      {s.installable && (
        <Button size="sm" variant="primary" className="h-6 px-2" loading={busy} onClick={() => void install()}>
          {busy ? (s.phase === "downloading" ? "Lädt …" : "Installiert …") : "Installieren"}
        </Button>
      )}
    </div>
  );
}

const OFFERED = ["available", "downloading", "ready"];

/**
 * Asks to update as soon as a new release is found (shortly after the start). Each release is
 * offered once per run; "Später" leaves the card in the sidebar.
 */
export function AppUpdateDialog() {
  const s = useAppUpdate().data;
  const settings = useSettings().data;
  const reopened = useUi((u) => u.setupWizard);
  const setupOpen = settings?.setupDone === false || reopened;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { install, installing } = useInstallAction();
  // Second step of an update the user started before the restart: no second click.
  const autoStarted = useRef(false);
  const autoInstall = !!s?.autoInstall && s.installable && OFFERED.includes(s.phase);
  useEffect(() => {
    if (!autoInstall || autoStarted.current) return;
    autoStarted.current = true;
    void install();
  }, [autoInstall, install]);
  const openSettings = useUi((u) => u.openSettings);
  const tag = s?.latest && OFFERED.includes(s.phase) ? s.latest.tag : null;
  // Not on top of the setup assistant; the offer comes once it is done. An install already asked for still runs.
  if (!s?.latest || !tag || dismissed === tag || (setupOpen && !autoInstall)) return null;
  const busy = installing || s.phase === "downloading";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && setDismissed(tag)}
      title={`FORGE ${s.latest.version} ist verfügbar`}
      description={`Installiert ist ${s.currentVersion}${s.latest.publishedAt ? `. Veröffentlicht ${relativeTime(s.latest.publishedAt)}` : ""}. ${sizeLabel(s.latest)}.`}
      className="w-150"
      overlayClassName="backdrop-blur-sm"
      footer={
        <>
          {!s.installable && <span className="mr-auto self-center text-xs text-subtle">Aktualisieren geht nur in der installierten App.</span>}
          <Button variant="ghost" onClick={() => setDismissed(tag)}>
            Später
          </Button>
          <Button variant="primary" loading={busy} disabled={!s.installable} onClick={() => void install()}>
            {busy ? (s.phase === "downloading" ? "Wird geladen …" : "Wird installiert …") : (
              <>
                <Download className="h-3.5 w-3.5" /> Jetzt aktualisieren
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
            <Sparkles className="h-3.5 w-3.5 text-accent" /> Änderungen seit {s.latest.since}
          </div>
          {s.latest.since !== s.currentVersion && (
            <div className="-mt-1 mb-2 text-caption text-subtle">Installiert ist {s.currentVersion}. Ältere Änderungen sind hier nicht aufgeführt.</div>
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
        <div className="mt-2 text-caption text-subtle">Von Claude aus Release-Notizen und Commit-Messages zusammengefasst.</div>
      </div>
    );
  const raw = c?.commits.length ? c.commits.map((m) => `- ${m}`).join("\n") : notes;
  const noLogin = c?.unavailable === "no-login" || c?.unavailable === "no-claude";
  return (
    <div className="flex flex-col gap-2.5 text-body">
      {noLogin && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 py-2">
          <p className="text-muted">Kein Changelog verfügbar, weil noch kein Claude-Login eingerichtet ist.</p>
          <Button size="sm" variant="outline" onClick={onSetup}>
            Claude einrichten
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
          <Spinner className="h-3 w-3" /> Claude fasst die Änderungen zusammen …
        </div>
      )}
      {c?.unavailable === "error" && <div className="text-caption text-subtle">Die Zusammenfassung von Claude ist gerade nicht verfügbar.</div>}
      {log.isError && <div className="text-caption text-subtle">Änderungen nicht geladen: {errorMessage(log.error)}</div>}
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
      if (next.phase === "uptodate") toast.success("FORGE ist aktuell", next.message ?? `Version ${next.currentVersion}`);
      if (next.phase === "error") toast.error("Prüfung fehlgeschlagen", next.message ?? "");
    } catch (e) {
      toast.error("Prüfung fehlgeschlagen", errorMessage(e));
    } finally {
      setChecking(false);
    }
  };
  if (update.isPending)
    return (
      <SkeletonRegion label="Lädt Update-Status" className="flex items-center gap-3">
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
      ? `Version ${s.latest?.version} ist verfügbar.`
      : s.phase === "downloading"
        ? "Update wird geladen …"
        : s.phase === "error"
          ? (s.message ?? "Prüfung fehlgeschlagen.")
          : s.checkedAt
            ? (s.message ?? `Aktuell, geprüft ${relativeTime(s.checkedAt)}.`)
            : "Noch nicht geprüft.";
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-body">FORGE {s.currentVersion}</div>
        <div className={s.phase === "error" ? "text-xs text-danger" : "text-xs text-muted"}>{status}</div>
      </div>
      {(s.phase === "available" || s.phase === "ready") && s.installable ? (
        <Button size="sm" variant="primary" loading={installing} onClick={() => void install()}>
          <Download className="h-3.5 w-3.5" /> Aktualisieren
        </Button>
      ) : (
        <Button size="sm" variant="outline" loading={checking || s.phase === "checking"} onClick={() => void check()}>
          <RefreshCw className="h-3.5 w-3.5" /> Jetzt prüfen
        </Button>
      )}
    </div>
  );
}

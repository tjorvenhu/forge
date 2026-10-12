import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Download, RefreshCw, Sparkles } from "lucide-react";
import type { AppUpdateState } from "@forge/protocol";
import { call, keys, useAppChangelog, useAppUpdate } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner, Tooltip } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/components/workspace/Markdown";
import { useUi } from "@/stores/ui";
import { Logo } from "./Logo";

/** Downloads the installer if needed, then lets the desktop shell run it; FORGE restarts on its own. */
function useInstall() {
  const qc = useQueryClient();
  const [installing, setInstalling] = useState(false);
  const install = async () => {
    setInstalling(true);
    try {
      let s = qc.getQueryData<AppUpdateState>(keys.appUpdate);
      if (s?.phase !== "ready") {
        s = await call("app.downloadUpdate", {});
        qc.setQueryData(keys.appUpdate, s);
      }
      if (s.phase !== "ready" || !s.installerPath) throw new Error(s.message ?? "Der Installer ist nicht bereit.");
      toast.info("Update wird installiert", "FORGE schließt sich kurz und startet danach von selbst neu.");
      await invoke("install_update", { path: s.installerPath });
    } catch (e) {
      toast.error("Update nicht installiert", errorMessage(e));
      setInstalling(false);
    }
  };
  return { install, installing };
}

/** "Update available" above the Claude Code card in the sidebar; nothing when FORGE is up to date. */
export function AppUpdateCard() {
  const s = useAppUpdate().data;
  const { install, installing } = useInstall();
  if (!s?.latest || !["available", "downloading", "ready"].includes(s.phase)) return null;
  const busy = installing || s.phase === "downloading";
  return (
    <div className="mx-3 mt-3 flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent-soft px-3.5 py-3 animate-slide-up-in">
      <div className="flex items-start gap-2.5">
        <ArrowUpCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium">FORGE {s.latest.version} ist da</div>
          <div className="text-caption text-muted">
            Installiert: {s.currentVersion}
            {s.latest.publishedAt ? ` · veröffentlicht ${relativeTime(s.latest.publishedAt)}` : ""}
          </div>
        </div>
      </div>
      {s.latest.notes && (
        <Tooltip content={<div className="max-w-80 whitespace-pre-wrap text-xs">{s.latest.notes.slice(0, 1200)}</div>}>
          <div className="line-clamp-2 cursor-default text-caption text-muted">{s.latest.notes.replace(/^[-*]\s*/gm, "").split("\n").filter(Boolean).join(" · ")}</div>
        </Tooltip>
      )}
      {s.installable ? (
        <Button size="sm" variant="primary" className="w-full" loading={busy} onClick={() => void install()}>
          {busy ? (s.phase === "downloading" ? "Wird geladen …" : "Wird installiert …") : (
            <>
              <Download className="h-3.5 w-3.5" /> Jetzt aktualisieren
            </>
          )}
        </Button>
      ) : (
        <div className="text-caption text-subtle">Nur in der installierten App, nicht im Entwicklungsmodus.</div>
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
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { install, installing } = useInstall();
  const openSettings = useUi((u) => u.openSettings);
  const tag = s?.latest && OFFERED.includes(s.phase) ? s.latest.tag : null;
  if (!s?.latest || !tag || dismissed === tag) return null;
  const busy = installing || s.phase === "downloading";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && setDismissed(tag)}
      title={`FORGE ${s.latest.version} ist verfügbar`}
      description={`Installiert ist ${s.currentVersion}${s.latest.publishedAt ? `. Veröffentlicht ${relativeTime(s.latest.publishedAt)}.` : "."}`}
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
            <Sparkles className="h-3.5 w-3.5 text-accent" /> Was ist neu
          </div>
          <Changelog
            tag={tag}
            notes={s.latest.notes}
            onSetup={() => {
              setDismissed(tag);
              openSettings("claude");
            }}
          />
        </div>
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
  const s = useAppUpdate().data;
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const { install, installing } = useInstall();
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
  if (!s) return null;
  const status =
    s.phase === "available" || s.phase === "ready"
      ? `Version ${s.latest?.version} ist verfügbar.`
      : s.phase === "downloading"
        ? "Update wird geladen …"
        : s.phase === "error"
          ? (s.message ?? "Prüfung fehlgeschlagen.")
          : s.checkedAt
            ? `Aktuell, geprüft ${relativeTime(s.checkedAt)}.`
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

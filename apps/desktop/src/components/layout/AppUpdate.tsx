import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Download, RefreshCw } from "lucide-react";
import type { AppUpdateState } from "@forge/protocol";
import { call, keys, useAppUpdate } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";

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

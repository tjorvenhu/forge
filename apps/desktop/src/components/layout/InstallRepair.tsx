import { useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, FileUp, PackageCheck, RefreshCw } from "lucide-react";
import type { AppInstallState } from "@forge/protocol";
import { checkInstall, installFromFile, installFull, problemText, useInstall } from "@/lib/app-install";
import { contextItems, type ContextGroup } from "@/lib/context-menu";
import { openExternal } from "@/lib/native";
import { useAppInstall } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { RestartNote } from "./AppUpdate";

/** Release page for a manual download (the repository is private: only with access). */
export const RELEASES_URL = "https://github.com/tjorvenhu/forge/releases";

const mb = (bytes: number) => Math.max(1, Math.round(bytes / 1048576));

/** Which installer FORGE would run, for the banner and the settings. */
export function installerText(s: AppInstallState): string | null {
  const i = s.installer;
  if (!i) return null;
  if (i.source === "local") return `Installer ${i.version} aus deinem Downloads-Ordner`;
  return `Installer ${i.version}${i.size ? ` · ${mb(i.size)} MB` : ""}${i.then ? `, danach Update auf ${i.then}` : ""}`;
}

/** Shown when FORGE cannot fix the installation by itself: the release page and a downloaded setup.exe. */
const canInstall = (s: AppInstallState) => !!s.installer || s.phase === "ready";

/** The actions for the banner, the settings card and the right click. */
function menuItems(qc: QueryClient, s: AppInstallState, dismiss?: () => void): ContextGroup {
  return [
    canInstall(s) && { label: "Vollständig installieren", icon: <PackageCheck className="h-3.5 w-3.5" />, onSelect: () => void installFull(qc) },
    { label: "Heruntergeladene setup.exe auswählen", icon: <FileUp className="h-3.5 w-3.5" />, onSelect: () => void installFromFile(qc) },
    { label: "Release-Seite öffnen", icon: <ExternalLink className="h-3.5 w-3.5" />, onSelect: () => void openExternal(RELEASES_URL) },
    { label: "Erneut prüfen", icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: () => void checkInstall(qc) },
    dismiss && { label: "Für jetzt ausblenden", onSelect: dismiss },
  ].filter((x): x is Exclude<typeof x, false | undefined> => !!x);
}

/** Bar while the installer downloads: "34 von 92 MB". */
function Progress({ s }: { s: AppInstallState }) {
  const total = s.installer?.size ?? null;
  const got = s.received ?? 0;
  const pct = total ? Math.min(100, Math.round((got / total) * 100)) : null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct ?? undefined} aria-valuemin={0} aria-valuemax={100} aria-label="Download des Installers">
        <div className={cn("h-full rounded-full bg-accent transition-[width] duration-300", pct === null && "w-1/3 animate-pulse")} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <span className="shrink-0 text-caption tabular-nums text-muted">{total ? `${mb(got)} von ${mb(total)} MB` : `${mb(got)} MB`}</span>
    </div>
  );
}

/** Second line: what FORGE found, what it does right now, or why it cannot help by itself. */
function StatusLine({ s }: { s: AppInstallState }) {
  if (s.phase === "searching")
    return (
      <SkeletonRegion label="Lädt Installer-Suche" className="flex h-4 items-center">
        <Skeleton className="h-2.5 w-56" />
      </SkeletonRegion>
    );
  if (s.phase === "downloading") return <Progress s={s} />;
  if (s.phase === "ready") return <span className="truncate text-caption text-muted">{installerText(s)}. Heruntergeladen und geprüft.</span>;
  if (s.installer) return <span className="truncate text-caption text-muted">{installerText(s)}</span>;
  return <span className={cn("text-caption", s.phase === "error" ? "text-danger" : "text-muted")}>{s.message}</span>;
}

/**
 * Hint at the top when the installation lacks parts of its bundled runtime (an update zip unpacked
 * instead of the installer, or an older runtime than this version needs). Does not block; "Später"
 * hides it until the next start, the settings keep showing it.
 */
export function InstallRepairBanner() {
  const s = useAppInstall().data;
  const qc = useQueryClient();
  const installing = useInstall((u) => u.installing);
  const [dismissed, setDismissed] = useState(false);
  if (!s?.checkable || s.complete !== false || dismissed) return null;
  const busy = installing || s.phase === "downloading";
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-3 border-b border-warning/40 bg-warning-soft px-5 py-2.5 animate-slide-up-in"
      onContextMenu={contextItems(() => menuItems(qc, s, () => setDismissed(true)))}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-body">
          <span className="font-medium">FORGE ist nicht vollständig installiert.</span> <span className="text-muted">{problemText(s)}</span>
        </div>
        <StatusLine s={s} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {!canInstall(s) && s.phase !== "searching" && (
          <>
            <Button size="sm" variant="ghost" onClick={() => void openExternal(RELEASES_URL)}>
              <ExternalLink className="h-3.5 w-3.5" /> Release-Seite
            </Button>
            <Button size="sm" variant="outline" onClick={() => void installFromFile(qc)}>
              <FileUp className="h-3.5 w-3.5" /> setup.exe auswählen
            </Button>
          </>
        )}
        {canInstall(s) && (
          <Button size="sm" variant="primary" loading={busy} onClick={() => void installFull(qc)}>
            {busy ? (s.phase === "downloading" ? "Lädt …" : "Installiert …") : (
              <>
                <PackageCheck className="h-3.5 w-3.5" /> Vollständig installieren
              </>
            )}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
          Später
        </Button>
      </div>
    </div>
  );
}

/** State of the installation and the repair, in Einstellungen, Über FORGE. */
export function InstallRepairSettings() {
  const q = useAppInstall();
  const s = q.data;
  const qc = useQueryClient();
  const installing = useInstall((u) => u.installing);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    await checkInstall(qc);
    setChecking(false);
  };
  if (q.isPending)
    return (
      <SkeletonRegion label="Lädt Installationsstatus" className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-2.5 w-64" />
        </div>
        <Skeleton className="h-7 w-28" />
      </SkeletonRegion>
    );
  if (!s) return <div className="text-xs text-danger">{q.isError ? errorMessage(q.error) : "Status nicht verfügbar."}</div>;
  const recheck = (
    <Button size="sm" variant="outline" loading={checking || s.phase === "searching"} onClick={() => void check()}>
      <RefreshCw className="h-3.5 w-3.5" /> Neu prüfen
    </Button>
  );
  if (!s.checkable || s.complete !== false) {
    const text = !s.checkable
      ? "Im Entwicklungsmodus gibt es keine Installation zu prüfen."
      : s.complete
        ? `Alle mitgelieferten Programme passen zu dieser Version${s.checkedAt ? `, geprüft ${relativeTime(s.checkedAt)}` : ""}.`
        : "Noch nicht geprüft.";
    return (
      <div className="flex items-center gap-3" onContextMenu={s.checkable ? contextItems(() => menuItems(qc, s)) : undefined}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-body">
            {s.complete && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
            {s.complete ? "Vollständig installiert" : "Installation"}
          </div>
          <div className="text-xs text-muted">{text}</div>
        </div>
        {s.checkable && recheck}
      </div>
    );
  }
  const busy = installing || s.phase === "downloading";
  return (
    <div className="flex flex-col gap-3" onContextMenu={contextItems(() => menuItems(qc, s))}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-body">Nicht vollständig installiert</div>
          <ul className="list-disc pl-4 text-xs text-muted">
            {s.problems.map((p) => (
              <li key={`${p.part}:${p.label}`}>{p.label}</li>
            ))}
          </ul>
          <StatusLine s={s} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {recheck}
        <Button size="sm" variant="ghost" onClick={() => void openExternal(RELEASES_URL)}>
          <ExternalLink className="h-3.5 w-3.5" /> Release-Seite
        </Button>
        <Button size="sm" variant="outline" onClick={() => void installFromFile(qc)}>
          <FileUp className="h-3.5 w-3.5" /> setup.exe auswählen
        </Button>
        {canInstall(s) && (
          <Button size="sm" variant="primary" loading={busy} onClick={() => void installFull(qc)}>
            <PackageCheck className="h-3.5 w-3.5" /> Vollständig installieren
          </Button>
        )}
      </div>
      <RestartNote />
    </div>
  );
}

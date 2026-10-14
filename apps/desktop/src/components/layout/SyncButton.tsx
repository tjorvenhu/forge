import type { ReactNode } from "react";
import { Cloud } from "lucide-react";
import type { SyncStatus } from "@forge/protocol";
import { useSettings, useSyncStatus } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
import { formatBackupDate } from "@/components/settings/BackupSettings";

type Tone = "ok" | "busy" | "warn" | "bad";

/** What the cloud says at a glance: colour of cloud and dot, and the headline of the tooltip. */
export function syncLook(st: SyncStatus): { tone: Tone; title: string } {
  if (st.phase === "syncing") return { tone: "busy", title: "Wird gerade abgeglichen" };
  if (st.phase === "error") return { tone: "bad", title: "Abgleich fehlgeschlagen" };
  if (st.phase === "needs-passphrase") return { tone: "warn", title: "Sync-Passwort nötig" };
  if (st.phase === "no-github") return { tone: "warn", title: "Nicht bei GitHub angemeldet" };
  if (st.pending) return { tone: "busy", title: "Änderungen werden gleich hochgeladen" };
  if (!st.lastSyncAt) return { tone: "busy", title: "Noch nicht abgeglichen" };
  return { tone: "ok", title: "Alles aktuell" };
}

const DOT: Record<Tone, string> = { ok: "bg-success", busy: "animate-soft-pulse bg-graph-blue", warn: "bg-warning", bad: "bg-danger" };
const CLOUD: Record<Tone, string> = {
  ok: "fill-graph-blue/15 text-graph-blue",
  busy: "fill-graph-blue/15 text-graph-blue",
  warn: "fill-warning/15 text-warning",
  bad: "fill-danger/15 text-danger",
};

/**
 * Header cloud while the GitHub sync is on, next to the pin and the phone: a tinted cloud with a
 * status dot (green, pulsing blue while it syncs, yellow or red when something needs attention);
 * the tooltip tells when it last synced and what waits.
 */
export function SyncButton() {
  const enabled = useSettings().data?.syncEnabled;
  const st = useSyncStatus().data;
  const openSettings = useUi((u) => u.openSettings);
  if (!enabled || !st?.enabled) return null;
  const { tone, title } = syncLook(st);
  return (
    <Tooltip content={<SyncTip st={st} title={title} tone={tone} />} delay={150}>
      <Button size="icon" variant="ghost" onClick={() => openSettings("github")} aria-label={`GitHub-Synchronisierung: ${title}`} className="relative h-9 w-9 rounded-lg">
        <Cloud className={cn("h-4.5 w-4.5", CLOUD[tone])} strokeWidth={1.75} />
        <span className={cn("absolute bottom-2 right-1.5 h-2 w-2 rounded-full ring-2 ring-bg", DOT[tone])} aria-hidden />
      </Button>
    </Tooltip>
  );
}

function SyncTip({ st, title, tone }: { st: SyncStatus; title: string; tone: Tone }) {
  const rows: Array<[string, ReactNode]> = [];
  if (st.lastSyncAt) rows.push(["Zuletzt abgeglichen", `${relativeTime(st.lastSyncAt)}, ${formatBackupDate(st.lastSyncAt)}`]);
  if (st.remote) rows.push(["Zuletzt geschrieben von", `${st.remote.device}, ${relativeTime(st.remote.updatedAt)}`]);
  if (st.repo) rows.push(["Repository", <span className="font-mono">{st.repo}</span>]);
  if (st.localOnly.length) rows.push(["Nur auf diesem PC", `${st.localOnly.length} ${st.localOnly.length === 1 ? "Eintrag" : "Einträge"}`]);
  if (st.available.length) rows.push(["Von anderen PCs", `${st.available.length} ${st.available.length === 1 ? "Projekt" : "Projekte"} zum Holen`]);
  return (
    <div className="flex w-64 flex-col gap-2 py-0.5">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[tone])} aria-hidden />
        <span className="text-body font-semibold">{title}</span>
      </div>
      {(st.phase === "error" || st.phase === "needs-passphrase") && st.error && <p className="text-xs text-muted">{st.error}</p>}
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-subtle">{k}</dt>
              <dd className="min-w-0 truncate text-right text-fg">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="border-t border-border pt-1.5 text-caption text-subtle">Verschlüsselt über GitHub. Klicken für die Einstellungen.</p>
    </div>
  );
}

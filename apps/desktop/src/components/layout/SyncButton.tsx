import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { SyncStatus } from "@forge/protocol";
import { useSettings, useSyncStatus } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
import { formatBackupDate } from "@/components/settings/BackupSettings";
import { t } from "@/i18n";

type Tone = "ok" | "busy" | "warn" | "bad";

/** What the sync symbol says at a glance: colour of symbol and dot, and the headline of the tooltip. */
export function syncLook(st: SyncStatus): { tone: Tone; title: string } {
  if (st.phase === "syncing") return { tone: "busy", title: t.layout.sync.syncing };
  if (st.phase === "error") return { tone: "bad", title: t.layout.sync.failed };
  if (st.phase === "needs-passphrase") return { tone: "warn", title: t.layout.sync.needsPassphrase };
  if (st.phase === "no-github") return { tone: "warn", title: t.layout.sync.noGithub };
  if (st.pending) return { tone: "busy", title: t.layout.sync.pending };
  if (!st.lastSyncAt) return { tone: "busy", title: t.layout.sync.never };
  return { tone: "ok", title: t.layout.sync.ok };
}

const DOT: Record<Tone, string> = { ok: "bg-success", busy: "animate-soft-pulse bg-graph-blue", warn: "bg-warning", bad: "bg-danger" };
const ICON: Record<Tone, string> = { ok: "text-muted", busy: "text-graph-blue", warn: "text-warning", bad: "text-danger" };

/**
 * Header sync symbol while the GitHub sync is on, next to the pin and the phone: two arrows in a
 * circle that turn while FORGE syncs, with a status dot (green, pulsing blue while it syncs, yellow or
 * red when something needs attention); the tooltip tells when it last synced and what waits.
 */
export function SyncButton() {
  const enabled = useSettings().data?.syncEnabled;
  const st = useSyncStatus().data;
  const openSettings = useUi((u) => u.openSettings);
  if (!enabled || !st?.enabled) return null;
  const { tone, title } = syncLook(st);
  return (
    <Tooltip content={<SyncTip st={st} title={title} tone={tone} />} delay={150}>
      <Button size="icon" variant="ghost" onClick={() => openSettings("github")} aria-label={t.layout.sync.label(title)} className="relative h-9 w-9 rounded-lg">
        <RefreshCw className={cn("h-4 w-4", ICON[tone], st.phase === "syncing" && "animate-spin [animation-duration:1.6s]")} strokeWidth={2} />
        <span className={cn("absolute bottom-2 right-1.5 h-2 w-2 rounded-full ring-2 ring-bg", DOT[tone])} aria-hidden />
      </Button>
    </Tooltip>
  );
}

function SyncTip({ st, title, tone }: { st: SyncStatus; title: string; tone: Tone }) {
  const rows: Array<[string, ReactNode]> = [];
  if (st.lastSyncAt) rows.push([t.layout.sync.lastSync, `${relativeTime(st.lastSyncAt)}, ${formatBackupDate(st.lastSyncAt)}`]);
  if (st.remote) rows.push([t.layout.sync.lastWrittenBy, `${st.remote.device}, ${relativeTime(st.remote.updatedAt)}`]);
  if (st.repo) rows.push([t.layout.sync.repository, <span className="font-mono">{st.repo}</span>]);
  if (st.localOnly.length) rows.push([t.layout.sync.localOnly, t.layout.sync.entries(st.localOnly.length)]);
  if (st.available.length) rows.push([t.layout.sync.fromOthers, t.layout.sync.toFetch(st.available.length)]);
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
      <p className="border-t border-border pt-1.5 text-caption text-subtle">{t.layout.sync.footer}</p>
    </div>
  );
}

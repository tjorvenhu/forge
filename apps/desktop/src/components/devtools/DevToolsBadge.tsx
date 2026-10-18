import type { Project } from "@forge/protocol";
import { useDevServer, useTestDb } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

/**
 * State at the Dev-Tools tab, so it shows from every tab: green dot while the dev server runs, amber
 * while it starts, red after a crash; a second dot for a running test database.
 */
export function DevToolsBadge({ project }: { project: Project }) {
  const dev = useDevServer(project.id).data;
  const db = useTestDb(project.id).data;
  const devTone = !dev
    ? null
    : dev.status === "running"
      ? dev.url
        ? "bg-success"
        : "bg-warning animate-soft-pulse"
      : (dev.status === "exited" && dev.exitCode !== 0 && dev.exitCode !== null) || dev.status === "failed"
        ? "bg-danger"
        : null;
  const dbTone = !db ? null : db.status === "running" ? "bg-success" : db.status === "installing" || db.status === "starting" ? "bg-warning animate-soft-pulse" : db.status === "failed" ? "bg-danger" : null;
  if (!devTone && !dbTone) return null;
  const m = t.devtools.badge;
  const label = [devTone && (dev?.status === "running" ? (dev.url ? m.devRunning : m.devStarting) : m.devCrashed), dbTone && (db?.status === "running" ? m.dbRunning : db?.status === "failed" ? m.dbFailed : m.dbStarting)]
    .filter(Boolean)
    .join(", ");
  return (
    <span className="flex items-center gap-1" title={label} aria-label={label}>
      {devTone && <span className={cn("h-1.5 w-1.5 rounded-full", devTone)} />}
      {dbTone && <span className={cn("h-1.5 w-1.5 rounded-sm", dbTone)} />}
    </span>
  );
}

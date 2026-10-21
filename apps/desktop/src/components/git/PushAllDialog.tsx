import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, GitBranch } from "lucide-react";
import type { PushAllResult, UnpushedProject } from "@forge/protocol";
import { call, keys } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { closeMainWindow, usePushAll } from "@/lib/push-on-close";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Badge, Spinner, ToggleRow } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const tp = t.git.pushAll;

/** Commits and pushes the open work of all projects; asked when FORGE closes, or from the command palette. */
export function PushAllDialog() {
  const s = usePushAll();
  if (!s.open) return null;
  return <PushAll mode={s.mode} projects={s.projects} />;
}

function PushAll({ mode, projects }: { mode: "close" | "manual"; projects: UnpushedProject[] | null }) {
  const qc = useQueryClient();
  const [dontAsk, setDontAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Map<string, PushAllResult>>(new Map());
  const closing = mode === "close";
  const failed = [...results.values()].some((r) => !r.pushed);
  const open = projects?.filter((p) => !results.get(p.projectId)?.pushed) ?? [];

  const dismiss = () => usePushAll.setState({ open: false });

  const leave = async () => {
    if (dontAsk) {
      try {
        qc.setQueryData(keys.settings, await call("settings.update", { askPushOnClose: false }));
      } catch {
        // FORGE closes anyway; the question comes again next time.
      }
    }
    closeMainWindow();
  };

  const push = async () => {
    if (!open.length) return;
    setBusy(true);
    try {
      // The list shows every branch, main included, before the user confirms.
      const done = await call("git.pushAll", { projectIds: open.map((p) => p.projectId), allowProtected: true });
      const next = new Map(results);
      for (const r of done) next.set(r.projectId, r);
      setResults(next);
      if (done.every((r) => r.pushed)) {
        if (closing) return void (await leave());
        toast.success(tp.allPushed);
        dismiss();
      }
    } catch (e) {
      toast.error(tp.failed, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const empty = projects !== null && projects.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !busy && dismiss()}
      dismissable={!busy}
      title={closing ? tp.closeTitle : tp.title}
      description={empty ? tp.nothing : tp.description}
      className="w-150"
      bodyClassName="flex flex-col gap-3"
      footer={
        empty ? (
          <Button variant="ghost" onClick={dismiss}>
            {t.ui.close}
          </Button>
        ) : (
          <>
            <Button variant="ghost" className={closing ? "mr-auto" : undefined} onClick={dismiss} disabled={busy}>
              {t.ui.cancel}
            </Button>
            {closing && (
              <Button variant="ghost" onClick={() => void leave()} disabled={busy}>
                {failed ? tp.closeAnyway : tp.closeWithout}
              </Button>
            )}
            <Button variant="primary" loading={busy} disabled={projects === null || !open.length} onClick={() => void push()}>
              {closing ? tp.pushAndClose : tp.push}
            </Button>
          </>
        )
      }
    >
      {empty ? null : (
        <>
          {projects === null ? (
            <RowsSkeleton />
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {projects.map((p) => (
                <Row key={p.projectId} project={p} result={results.get(p.projectId)} busy={busy} />
              ))}
            </ul>
          )}
          {failed && !busy && <p className="text-body text-danger">{tp.someFailed}</p>}
          <p className="text-caption text-muted">{tp.skippedHint}</p>
          {closing && (
            <ToggleRow checked={dontAsk} onChange={setDontAsk} label={tp.dontAsk} disabled={busy}>
              {tp.dontAskHint}
            </ToggleRow>
          )}
        </>
      )}
    </Dialog>
  );
}

function Row({ project: p, result: r, busy }: { project: UnpushedProject; result: PushAllResult | undefined; busy: boolean }) {
  const parts = [p.changed ? tp.changed(p.changed) : "", p.ahead ? tp.ahead(p.ahead) : ""].filter(Boolean).join(" · ");
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
        {r?.pushed ? (
          <Check className="h-4 w-4 text-success" />
        ) : busy ? (
          <Spinner className="h-4 w-4" />
        ) : r ? (
          <AlertTriangle className="h-4 w-4 text-danger" />
        ) : (
          <GitBranch className="h-4 w-4 text-muted" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium">{p.name}</span>
          <Badge className="font-mono">{p.branch}</Badge>
        </div>
        <div className="mt-0.5 text-caption text-muted">{busy && !r?.pushed ? tp.running : parts}</div>
        {r?.pushed && <div className="mt-0.5 truncate text-caption text-success">{r.committed ? tp.committed(r.committed) : tp.pushed}</div>}
        {r && !r.pushed && !busy && <div className="mt-1 whitespace-pre-wrap break-words text-caption text-danger">{r.error ?? tp.failed}</div>}
      </div>
    </li>
  );
}

function RowsSkeleton() {
  return (
    <SkeletonRegion label={tp.loading} className="flex flex-col divide-y divide-border rounded-lg border border-border">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-2.5">
          <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-3.5" style={{ width: `${30 + i * 8}%` }} />
              <Skeleton className="h-4 w-14" />
            </div>
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

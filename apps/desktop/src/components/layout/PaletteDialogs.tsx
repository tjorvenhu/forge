import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call, keys } from "@/lib/queries";
import { modelLabel } from "@/lib/models";
import { errorMessage } from "@/lib/rpc";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { CreatePrDialog } from "@/components/git/Sync";
import { NewBranchDialog } from "@/components/git/GitCenter";
import { NewAgentDialog } from "@/components/workspace/AgentsTab";
import { DeleteSessionDialog } from "@/components/workspace/DeleteSessionDialog";
import { Markdown } from "@/components/workspace/Markdown";
import { UiCompareDialog } from "@/components/workspace/UiCompareCard";
import type { PaletteDialog } from "./palette-actions";
import { t } from "@/i18n";

/** The dialog an entry of the command palette asked for; shown after the palette has closed. */
export function PaletteDialogs({ dialog, onClose }: { dialog: PaletteDialog | null; onClose: () => void }) {
  const qc = useQueryClient();
  const close = (o: boolean) => !o && onClose();
  if (!dialog) return null;
  switch (dialog.kind) {
    case "delete-session":
      return <DeleteSessionDialog session={dialog.session} onClose={onClose} />;
    case "summary":
      return <SummaryDialog key={dialog.session.id} sessionId={dialog.session.id} title={dialog.session.title} onClose={onClose} />;
    case "new-agent":
      return <NewAgentDialog open onOpenChange={close} root={dialog.root} />;
    case "new-branch":
      return <NewBranchDialog open onOpenChange={close} projectId={dialog.projectId} />;
    case "create-pr": {
      const id = dialog.project.id;
      return (
        <CreatePrDialog
          open
          onOpenChange={close}
          project={dialog.project}
          onDone={() => {
            void qc.invalidateQueries({ queryKey: keys.git(id) });
            void qc.invalidateQueries({ queryKey: ["pr", id] });
            void qc.invalidateQueries({ queryKey: keys.log(id) });
          }}
        />
      );
    }
    case "ui-compare":
      return <LatestUiCompare sessionId={dialog.sessionId} projectId={dialog.projectId} onClose={onClose} />;
  }
}

/** The newest comparison of the open session, else of the project; a note when there is none yet. */
function LatestUiCompare({ sessionId, projectId, onClose }: { sessionId: string | null; projectId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: keys.uiCompareLatest(sessionId, projectId),
    queryFn: async () => (sessionId ? await call("uiCompare.latest", { sessionId }) : null) ?? (await call("uiCompare.latest", { projectId })),
  });
  if (q.data) return <UiCompareDialog sessionId={q.data.sessionId} compareId={q.data.id} initialMode="side" onClose={onClose} />;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t.layout.paletteDialogs.compareTitle}>
      {q.isPending ? (
        <SkeletonRegion label={t.layout.paletteDialogs.loadingCompare} className="grid grid-cols-2 gap-2">
          <Skeleton className="aspect-[16/10] w-full" />
          <Skeleton className="aspect-[16/10] w-full" />
        </SkeletonRegion>
      ) : q.isError ? (
        <ErrorBanner>{errorMessage(q.error)}</ErrorBanner>
      ) : (
        <p className="text-body text-muted">{t.layout.paletteDialogs.noCompare}</p>
      )}
    </Dialog>
  );
}

/** "Wo war ich?" like the button in the session bar, started from the palette. */
function SummaryDialog({ sessionId, title, onClose }: { sessionId: string; title: string | null; onClose: () => void }) {
  const m = useMutation({ mutationFn: () => call("sessions.summarize", { sessionId }) });
  const { mutate } = m;
  // Once per dialog, also when StrictMode runs effects twice: each run is a Claude call.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate();
  }, [mutate]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t.layout.paletteDialogs.summaryTitle} description={title ?? undefined}>
      {m.isPending && (
        <div className="flex flex-col gap-2" role="status" aria-label={t.layout.paletteDialogs.summarizing}>
          <Skeleton className="h-3 w-[90%]" />
          <Skeleton className="h-3 w-[75%]" />
          <Skeleton className="h-3 w-[82%]" />
          <Skeleton className="h-3 w-[40%]" />
        </div>
      )}
      {m.isError && <ErrorBanner>{errorMessage(m.error)}</ErrorBanner>}
      {m.data && (
        <>
          <Markdown text={m.data.summary} />
          <p className="mt-3 text-caption text-subtle">{t.layout.paletteDialogs.summaryBy(modelLabel(m.data.model))}</p>
        </>
      )}
    </Dialog>
  );
}

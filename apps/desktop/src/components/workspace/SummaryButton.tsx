import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { NotebookText } from "lucide-react";
import { call } from "@/lib/queries";
import { modelLabel } from "@/lib/models";
import { errorMessage } from "@/lib/rpc";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner } from "@/components/ui/misc";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Markdown } from "./Markdown";

/** "Where was I?": a Claude-written summary built only from the recorded session. */
export function SummaryButton({ sessionId, title, size = "sm" }: { sessionId: string; title: string | null; size?: "sm" | "icon-sm" }) {
  const [open, setOpen] = useState(false);
  const m = useMutation({ mutationFn: () => call("sessions.summarize", { sessionId }) });
  return (
    <>
      <Button
        size={size}
        variant="ghost"
        title="Zusammenfassung für den Wiedereinstieg"
        aria-label="Session zusammenfassen"
        onClick={() => {
          setOpen(true);
          if (!m.data) m.mutate();
        }}
      >
        <NotebookText className="h-3.5 w-3.5" />
        {size === "sm" && "Zusammenfassen"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Wo war ich?" description={title ?? undefined}>
        {m.isPending && (
          <>
            <SkeletonRegion label="Zusammenfassung lädt" className="flex flex-col gap-4 py-1">
              <Skeleton className="h-3.5 w-40" />
              {[[92, 85, 88, 45], [80, 90, 35]].map((paragraph, p) => (
                <div key={p} className="flex flex-col gap-2">
                  {paragraph.map((w, i) => (
                    <Skeleton key={i} className="h-3 rounded-sm" style={{ width: `${w}%` }} />
                  ))}
                </div>
              ))}
            </SkeletonRegion>
            <p className="mt-3 text-caption text-subtle">Claude fasst die Session zusammen …</p>
          </>
        )}
        {m.isError && <ErrorBanner>{errorMessage(m.error)}</ErrorBanner>}
        {m.data && (
          <>
            <Markdown text={m.data.summary} />
            <p className="mt-3 text-caption text-subtle">Von Claude ({modelLabel(m.data.model)}) aus dem gespeicherten Verlauf dieser Session erstellt.</p>
          </>
        )}
      </Dialog>
    </>
  );
}

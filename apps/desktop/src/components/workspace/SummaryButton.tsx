import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { NotebookText } from "lucide-react";
import { call } from "@/lib/queries";
import { modelLabel } from "@/lib/models";
import { errorMessage } from "@/lib/rpc";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ErrorBanner, Spinner } from "@/components/ui/misc";
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
          <div className="flex items-center gap-2 text-body text-muted">
            <Spinner className="h-4 w-4" /> Claude fasst die Session zusammen …
          </div>
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

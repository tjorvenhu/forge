import { useQuery } from "@tanstack/react-query";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { call } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { cardKey, useCardState } from "@/stores/card-state";

/**
 * The screenshot of a preview tool, read back from the Claude Code transcript (the chat event only
 * keeps the text). The result reaches the transcript a moment after the event, hence the retries.
 */
export function PreviewShot({ sessionId, seq, size }: { sessionId: string; seq: number; size: { width: number; height: number } }) {
  const [wide, setWide] = useCardState(cardKey(sessionId, `shot${seq}`, "wide"), false);
  const q = useQuery({
    queryKey: ["toolImages", sessionId, seq],
    queryFn: () => call("sessions.images", { sessionId, seq }),
    staleTime: Infinity,
    retry: 4,
    retryDelay: 1_000,
  });
  const img = q.data?.[0];
  const box = cn("mt-2 w-full overflow-hidden rounded-md border border-border", wide ? "max-w-none" : "max-w-md");
  const ratio = { aspectRatio: `${size.width} / ${size.height}` };

  if (q.isPending)
    return (
      <SkeletonRegion label="Lädt Screenshot" className={box} style={ratio}>
        <Skeleton className="h-full w-full rounded-none" />
      </SkeletonRegion>
    );
  if (!img) return <p className="mt-1.5 text-small text-subtle">Screenshot nicht im Verlauf von Claude Code gefunden.</p>;
  return (
    <button type="button" className={cn(box, "block cursor-zoom-in", wide && "cursor-zoom-out")} style={ratio} onClick={() => setWide(!wide)} title={wide ? "Verkleinern" : "Vergrößern"}>
      <img src={`data:${img.mediaType};base64,${img.base64}`} alt="Screenshot der Vorschau" className="block h-full w-full object-contain" />
    </button>
  );
}

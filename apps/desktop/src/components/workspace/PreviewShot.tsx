import { useQuery } from "@tanstack/react-query";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { call } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { cardKey, useCardState } from "@/stores/card-state";
import { t } from "@/i18n";

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
  const images = q.data ?? [];
  const box = cn("mt-2 w-full overflow-hidden rounded-md border border-border", wide ? "max-w-none" : "max-w-md");
  const ratio = { aspectRatio: `${size.width} / ${size.height}` };

  if (q.isPending)
    return (
      <SkeletonRegion label={t.chat.previewShot.loading} className={box} style={ratio}>
        <Skeleton className="h-full w-full rounded-none" />
      </SkeletonRegion>
    );
  if (!images.length) return <p className="mt-1.5 text-small text-subtle">{t.chat.previewShot.notFound}</p>;
  // A full page comes in parts from top to bottom; they are shown as one picture.
  return (
    <button type="button" className={cn(box, "flex cursor-zoom-in flex-col", wide && "cursor-zoom-out")} onClick={() => setWide(!wide)} title={wide ? t.chat.previewShot.zoomOut : t.chat.previewShot.zoomIn}>
      {images.map((img, i) => (
        <img
          key={i}
          src={`data:${img.mediaType};base64,${img.base64}`}
          alt={images.length > 1 ? t.chat.previewShot.altPart(i + 1, images.length) : t.chat.previewShot.alt}
          className="block h-auto w-full"
          style={i === 0 ? ratio : undefined}
        />
      ))}
    </button>
  );
}

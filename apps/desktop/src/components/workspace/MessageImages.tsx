import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { call, keys } from "@/lib/queries";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

type Image = { mediaType: string; base64: string };

/** The images of a sent user message; ends in an error when the transcript no longer has them (e.g. after /clear). */
export function useMessageImages(sessionId: string, seq: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.sessionImages(sessionId, seq),
    queryFn: () => call("sessions.images", { sessionId, seq }),
    staleTime: Infinity,
    // Right after sending, the CLI has not written the message to its transcript yet.
    retry: 4,
    retryDelay: (n) => 1000 * 2 ** n,
    enabled,
  });
}

const src = (img: Image) => `data:${img.mediaType};base64,${img.base64}`;

/** Thumbnails of a message's images, larger in a dialog on click; placeholders while `images` is undefined. */
export function MessageImages({ images, names }: { images: Image[] | undefined; names: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!images) {
    return (
      <div className="mt-2 flex flex-wrap gap-2" role="status" aria-label="Bilder laden">
        {names.map((_, i) => (
          <Skeleton key={i} className="h-28 w-36 bg-surface-3" />
        ))}
      </div>
    );
  }
  const name = (i: number) => names[i] ?? `Bild ${i + 1}`;
  const current = open === null ? undefined : images[open];
  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {images.map((img, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(i)}
            className="overflow-hidden rounded-md border border-border bg-surface transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={`${name(i)} vergrößern`}
          >
            <img src={src(img)} alt={name(i)} className="block max-h-40 max-w-72 object-contain" />
          </button>
        ))}
      </div>
      <Dialog open={current !== undefined} onOpenChange={(o) => !o && setOpen(null)} title={open === null ? "Bild" : name(open)} className="w-auto">
        {current && <img src={src(current)} alt={open === null ? "Bild" : name(open)} className="mx-auto max-h-[70vh] max-w-full object-contain" />}
      </Dialog>
    </>
  );
}

import { FileText, ImageIcon, X } from "lucide-react";
import type { PendingFile } from "@/stores/drafts";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import type { PreparingFile } from "./useAttachments";

const CHIP = "flex items-center gap-2 rounded-lg border border-border bg-surface-3 py-1 pl-1 pr-1.5 text-xs";

/** Attachments waiting in the composer, each with a preview and a remove button; pasted files still uploading as placeholders. */
export function AttachmentList({ files, preparing = [], onRemove }: { files: PendingFile[]; preparing?: PreparingFile[]; onRemove: (f: PendingFile) => void }) {
  if (!files.length && !preparing.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {files.map((f) => (
        <div key={f.id} className={CHIP}>
          {f.preview ? (
            <img src={f.preview} alt="" className="h-8 w-8 rounded object-cover" />
          ) : (
            <span className="flex h-8 w-8 items-center justify-center rounded bg-surface-2 text-muted">
              {f.isImage ? <ImageIcon className="h-4 w-4" /> : <FileText className="h-4 w-4" />}
            </span>
          )}
          <span className="max-w-40 truncate" title={f.attachment.kind === "path" ? f.attachment.path : f.name}>
            {f.name}
          </span>
          <Button size="icon-sm" variant="ghost" className="h-5 w-5" aria-label={`${f.name} entfernen`} onClick={() => onRemove(f)}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {preparing.map((p) => (
        <SkeletonRegion key={p.id} label={`Lädt ${p.name}`} className={CHIP}>
          <Skeleton className="h-8 w-8 rounded" />
          <span className="max-w-40 truncate text-muted">{p.name}</span>
          <span className="h-5 w-5" />
        </SkeletonRegion>
      ))}
    </div>
  );
}

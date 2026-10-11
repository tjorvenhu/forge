import { FileText, ImageIcon, X } from "lucide-react";
import type { PendingFile } from "@/stores/drafts";
import { Button } from "@/components/ui/button";

/** Attachments waiting in the composer, each with a preview and a remove button. */
export function AttachmentList({ files, onRemove }: { files: PendingFile[]; onRemove: (f: PendingFile) => void }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {files.map((f) => (
        <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-3 py-1 pl-1 pr-1.5 text-xs">
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
    </div>
  );
}

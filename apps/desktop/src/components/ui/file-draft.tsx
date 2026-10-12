import { useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "./button";

/**
 * Draft state for an editor over a file that can change on disk (queries refetch on window focus).
 * A clean editor follows the file; a dirty one keeps the draft and reports `externalChange` instead
 * of silently dropping it. `expectedVersion` is the mtime the draft is based on: pass it to the
 * write so the sidecar rejects the save with CONFLICT if the file changed again.
 */
export function useFileDraft(content: string | undefined, version: number | null | undefined, resetKey?: string) {
  const [draft, setDraft] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState(version);
  const [key, setKey] = useState(resetKey);
  const dirty = draft !== null && draft !== (content ?? "");

  // Adjusting state during render (instead of an effect) avoids one frame with the stale draft.
  if (key !== resetKey) {
    setKey(resetKey);
    setDraft(null);
    setBaseVersion(version);
  } else if (version !== baseVersion && !dirty) {
    setBaseVersion(version);
    if (draft !== null) setDraft(null);
  }

  return {
    draft,
    setDraft,
    dirty,
    externalChange: dirty && version !== baseVersion,
    expectedVersion: baseVersion ?? null,
    /** drop the draft and show the file as it is on disk */
    reload: () => {
      setDraft(null);
      setBaseVersion(version);
    },
    /** keep the draft; the next save overwrites the outside change */
    keepEditing: () => setBaseVersion(version),
    /** after an own save: the new version on disk is no outside change */
    markSaved: (saved: number) => setBaseVersion(saved),
  };
}

export function ExternalChangeBanner({ onReload, onKeep }: { onReload: () => void; onKeep: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-body">
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Die Datei wurde außerhalb von FORGE geändert.</div>
        <div className="text-xs text-muted">Neu laden verwirft deine Änderungen. Wenn du weiter bearbeitest, überschreibt Speichern die Datei.</div>
      </div>
      <Button size="sm" onClick={onReload}>
        <RotateCcw className="h-3.5 w-3.5" /> Neu laden
      </Button>
      <Button size="sm" variant="ghost" onClick={onKeep}>
        Weiter bearbeiten
      </Button>
    </div>
  );
}

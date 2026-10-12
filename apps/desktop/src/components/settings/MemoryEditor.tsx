import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FilePlus2, Pencil } from "lucide-react";
import type { MemoryScope } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ExternalChangeBanner, useFileDraft } from "@/components/ui/file-draft";
import { ErrorBanner, Loading } from "@/components/ui/misc";
import { Markdown } from "@/components/workspace/Markdown";

const AUTOSAVE_MS = 1000;

const EMPTY_HINT: Record<MemoryScope, string> = {
  global: "# Globale Regeln\n\nGilt für alle Projekte.\n",
  project: "# Projektregeln\n\n",
  "project-dir": "# Projektregeln\n\n",
  local: "# Persönliche Regeln für dieses Projekt\n\nWird nicht committet.\n",
};

/**
 * Edit CLAUDE.md files. `scopes` decides which files are offered (global only in the app settings,
 * project + local + global inside a project).
 */
export function MemoryEditor({ projectId, scopes, height = "h-105" }: { projectId?: string; scopes: MemoryScope[]; height?: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["memory", projectId ?? "global"], queryFn: () => call("config.memoryList", { projectId }) });
  const files = (list.data ?? []).filter((f) => scopes.includes(f.scope));
  const [scope, setScope] = useState<MemoryScope>(scopes[0]!);
  const current = files.find((f) => f.scope === scope) ?? files[0];

  const doc = useQuery({
    queryKey: ["memoryDoc", projectId ?? "global", current?.scope],
    queryFn: () => call("config.memoryRead", { projectId, scope: current!.scope }),
    enabled: !!current,
  });
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const { draft, setDraft, dirty, externalChange, expectedVersion, reload, keepEditing, markSaved } = useFileDraft(doc.data?.content, doc.data?.mtimeMs, current?.scope);

  const text = draft ?? doc.data?.content ?? "";

  const save = useCallback(async () => {
    if (!current || draft === null || externalChange || saving) return;
    setSaving(true);
    try {
      const written = await call("config.memoryWrite", { projectId, scope: current.scope, content: draft, expectedMtimeMs: expectedVersion });
      // The file now holds the draft; typing on meanwhile stays a draft on top of it, not an outside change.
      markSaved(written.mtimeMs);
      if (doc.data) qc.setQueryData(["memoryDoc", projectId ?? "global", current.scope], { ...doc.data, content: draft, mtimeMs: written.mtimeMs });
      toast.saved();
      void qc.invalidateQueries({ queryKey: ["memory", projectId ?? "global"] });
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
      if (e instanceof RpcCallError && e.code === "CONFLICT") void doc.refetch();
    } finally {
      setSaving(false);
    }
  }, [current, draft, externalChange, saving, expectedVersion, projectId, qc, doc, markSaved]);

  // Saves a second after the last key; leaving the editor saves what is still pending.
  const latestSave = useRef(save);
  /** unsaved changes that may be saved (not against an outside change) */
  const pending = useRef(false);
  useEffect(() => {
    latestSave.current = save;
    pending.current = dirty && !externalChange;
  }, [save, dirty, externalChange]);
  useEffect(() => {
    if (!dirty || externalChange || saving) return;
    const timer = setTimeout(() => void latestSave.current(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, externalChange, saving]);
  useEffect(
    () => () => {
      if (pending.current) void latestSave.current();
    },
    [],
  );

  if (list.isLoading) return <Loading />;
  if (list.isError) return <ErrorBanner>{errorMessage(list.error)}</ErrorBanner>;
  if (!current) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {files.length > 1 &&
          files.map((f) => (
            <button
              key={f.scope}
              onClick={async () => {
                if (dirty) await save();
                setScope(f.scope);
              }}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs disabled:opacity-40",
                f.scope === current.scope ? "border-accent bg-accent-soft text-fg" : "border-border text-muted hover:text-fg",
              )}
              aria-pressed={f.scope === current.scope}
            >
              {f.label}
              {!f.exists && <span className="ml-1 text-subtle">(neu)</span>}
            </button>
          ))}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)} aria-pressed={preview}>
          {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {preview ? "Bearbeiten" : "Vorschau"}
        </Button>
      </div>
      <div className="truncate font-mono text-caption text-subtle" title={current.path}>{current.path}</div>
      {externalChange && <ExternalChangeBanner onReload={reload} onKeep={keepEditing} />}
      {doc.isLoading ? (
        <Loading />
      ) : !current.exists && draft === null ? (
        <div className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border", height)}>
          <p className="text-body text-muted">Diese Datei gibt es noch nicht.</p>
          <Button onClick={() => setDraft(EMPTY_HINT[current.scope])}>
            <FilePlus2 className="h-3.5 w-3.5" /> Anlegen
          </Button>
        </div>
      ) : preview ? (
        <div className={cn("overflow-y-auto rounded-lg border border-border bg-bg p-4", height)}>
          <Markdown text={text} />
        </div>
      ) : (
        <div className={height}>
          <CodeEditor value={text} onChange={setDraft} language="markdown" onSave={() => void save()} ariaLabel={current.label} />
        </div>
      )}
    </div>
  );
}

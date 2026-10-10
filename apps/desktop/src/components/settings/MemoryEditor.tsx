import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, FilePlus2, Pencil, RotateCcw, Save } from "lucide-react";
import type { MemoryScope } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ErrorBanner, Spinner } from "@/components/ui/misc";
import { Markdown } from "@/components/workspace/Markdown";

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
export function MemoryEditor({ projectId, scopes, height = "h-[420px]" }: { projectId?: string; scopes: MemoryScope[]; height?: string }) {
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
  const [draft, setDraft] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setDraft(null);
  }, [current?.scope, doc.data?.mtimeMs]);

  const text = draft ?? doc.data?.content ?? "";
  const dirty = draft !== null && draft !== (doc.data?.content ?? "");

  const save = useCallback(async () => {
    if (!current || draft === null) return;
    setSaving(true);
    try {
      await call("config.memoryWrite", { projectId, scope: current.scope, content: draft, expectedMtimeMs: doc.data?.mtimeMs ?? null });
      toast.success("Gespeichert", current.path);
      await qc.invalidateQueries({ queryKey: ["memory", projectId ?? "global"] });
      await qc.invalidateQueries({ queryKey: ["memoryDoc", projectId ?? "global", current.scope] });
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [current, draft, doc.data?.mtimeMs, projectId, qc]);

  if (list.isLoading) return <Spinner />;
  if (list.isError) return <ErrorBanner>{errorMessage(list.error)}</ErrorBanner>;
  if (!current) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {files.length > 1 &&
          files.map((f) => (
            <button
              key={f.scope}
              onClick={() => setScope(f.scope)}
              disabled={dirty && f.scope !== current.scope}
              title={dirty && f.scope !== current.scope ? "Erst speichern oder verwerfen" : undefined}
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
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
            <RotateCcw className="h-3.5 w-3.5" /> Verwerfen
          </Button>
        )}
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty} loading={saving} title="Speichern (Strg+S)">
          <Save className="h-3.5 w-3.5" /> Speichern
        </Button>
      </div>
      <div className="truncate font-mono text-[11px] text-subtle" title={current.path}>{current.path}</div>
      {doc.isLoading ? (
        <Spinner />
      ) : !current.exists && draft === null ? (
        <div className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border", height)}>
          <p className="text-[13px] text-muted">Diese Datei gibt es noch nicht.</p>
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

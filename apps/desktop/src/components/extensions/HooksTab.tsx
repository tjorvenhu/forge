import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { call } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ExternalChangeBanner, useFileDraft } from "@/components/ui/file-draft";
import { ErrorBanner, SectionTitle } from "@/components/ui/misc";
import { EditorSkeleton, Skeleton } from "@/components/ui/skeleton";
import { Select } from "@/components/ui/select";

export function HooksTab({ projectId }: { projectId?: string }) {
  const [scope, setScope] = useState<"user" | "project" | "local">("user");
  const q = useQuery({ queryKey: ["hooks", scope, projectId], queryFn: () => call("config.hooksRead", { scope, projectId }) });
  const [saving, setSaving] = useState(false);
  const { draft, setDraft, dirty, externalChange, expectedVersion, reload, keepEditing } = useFileDraft(q.data?.hooks, q.data?.mtimeMs, scope);
  const save = useCallback(async () => {
    if (draft === null || externalChange) return;
    setSaving(true);
    try {
      await call("config.hooksWrite", { scope, projectId, hooks: draft, expectedMtimeMs: expectedVersion });
      toast.success("Hooks gespeichert", q.data?.path);
      await q.refetch();
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
      if (e instanceof RpcCallError && e.code === "CONFLICT") void q.refetch();
    } finally {
      setSaving(false);
    }
  }, [draft, externalChange, scope, projectId, expectedVersion, q]);
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <SectionTitle>Hooks</SectionTitle>
      <p className="mb-3 text-xs text-muted">
        Befehle, die Claude Code bei Ereignissen ausführt (z. B. Lint nach jeder Dateiänderung). FORGE ändert nur den Schlüssel „hooks“ in der gewählten settings.json und
        prüft die Struktur vor dem Speichern.
      </p>
      <div className="mb-2 flex items-center gap-2">
        <Select
          value={scope}
          onChange={setScope}
          className="w-64"
          aria-label="Bereich"
          options={[
            { value: "user", label: "Global (~/.claude/settings.json)" },
            ...(projectId
              ? [
                  { value: "project" as const, label: "Projekt (.claude/settings.json)" },
                  { value: "local" as const, label: "Lokal (.claude/settings.local.json)" },
                ]
              : []),
          ]}
        />
        {q.isLoading ? (
          <div className="min-w-0 flex-1">
            <Skeleton className="h-2.5 w-64 max-w-full rounded-sm" />
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-subtle">{q.data?.path}</span>
        )}
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || externalChange} loading={saving}>
          <Save className="h-3.5 w-3.5" /> Speichern
        </Button>
      </div>
      {externalChange && (
        <div className="mb-2">
          <ExternalChangeBanner onReload={reload} onKeep={keepEditing} />
        </div>
      )}
      {q.isError && <ErrorBanner>{errorMessage(q.error)}</ErrorBanner>}
      {q.isLoading ? (
        <EditorSkeleton className="h-105" />
      ) : (
        <div className="h-105">
          <CodeEditor value={draft ?? q.data?.hooks ?? "{}"} onChange={setDraft} language="json" onSave={() => void save()} ariaLabel="Hooks (JSON)" />
        </div>
      )}
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">Beispiel</summary>
        <pre className="mt-2 rounded-md bg-bg p-2 font-mono">{`{
  "PostToolUse": [
    { "matcher": "Write|Edit", "hooks": [{ "type": "command", "command": "pnpm lint --fix" }] }
  ]
}`}</pre>
      </details>
    </section>
  );
}

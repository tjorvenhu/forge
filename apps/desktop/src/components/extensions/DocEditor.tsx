import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Save, Trash2 } from "lucide-react";
import type { ConfigDoc } from "@forge/protocol";
import { call } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ExternalChangeBanner, useFileDraft } from "@/components/ui/file-draft";
import { ErrorBanner } from "@/components/ui/misc";
import { EditorSkeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";

const m = t.extensions.docEditor;

export function DocEditor({ doc, projectId, onDelete }: { doc: ConfigDoc; projectId?: string; onDelete: () => void }) {
  const q = useQuery({
    queryKey: ["doc", doc.kind, doc.scope, doc.name, projectId],
    queryFn: () => call("config.docRead", { kind: doc.kind, scope: doc.scope, name: doc.name, projectId }),
  });
  const [saving, setSaving] = useState(false);
  const { draft, setDraft, dirty, externalChange, expectedVersion, reload, keepEditing } = useFileDraft(q.data?.content, q.data?.mtimeMs);
  const save = useCallback(async () => {
    if (draft === null || externalChange) return;
    setSaving(true);
    try {
      await call("config.docWrite", { kind: doc.kind, scope: doc.scope, name: doc.name, projectId, content: draft, expectedMtimeMs: expectedVersion });
      toast.success(m.saved, doc.path);
      await q.refetch();
    } catch (e) {
      toast.error(m.notSaved, errorMessage(e));
      if (e instanceof RpcCallError && e.code === "CONFLICT") void q.refetch();
    } finally {
      setSaving(false);
    }
  }, [draft, externalChange, doc, projectId, expectedVersion, q]);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-subtle">{doc.path}</span>
        <Button size="sm" variant="danger-ghost" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" /> {m.delete}
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || externalChange || !q.data} loading={saving}>
          <Save className="h-3.5 w-3.5" /> {m.save}
        </Button>
      </div>
      {externalChange && <ExternalChangeBanner onReload={reload} onKeep={keepEditing} />}
      {q.isLoading ? (
        <EditorSkeleton className="h-115" />
      ) : q.isError ? (
        <ErrorBanner title={m.unreadable}>{errorMessage(q.error)}</ErrorBanner>
      ) : (
        <div className="h-115">
          <CodeEditor value={draft ?? q.data?.content ?? ""} onChange={setDraft} language="markdown" onSave={() => void save()} ariaLabel={doc.name} />
        </div>
      )}
    </div>
  );
}

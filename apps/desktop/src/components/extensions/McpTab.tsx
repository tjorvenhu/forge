import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner, Loading, SectionTitle } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { AddMcpDialog } from "./AddMcpDialog";
import { MCP_STATUS, MCP_STATUS_TONE, mcpScopeOptions, mcpStatusText, type McpScope } from "./mcp";

export function McpTab({ projectId }: { projectId?: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["mcp", projectId ?? "global"], queryFn: () => call("mcp.list", { projectId }), staleTime: 60_000 });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  // `claude mcp list` does not say where a server is configured, so the user picks the scope.
  const [scope, setScope] = useState<McpScope>("user");
  return (
    <section className="rounded-xl border border-border bg-surface p-4">
      <SectionTitle
        action={
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => void list.refetch()} loading={list.isFetching}>
              <RefreshCw className="h-3.5 w-3.5" /> Prüfen
            </Button>
            <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Hinzufügen
            </Button>
          </div>
        }
      >
        MCP Server
      </SectionTitle>
      <p className="mb-3 text-xs text-muted">Verwaltet über die offiziellen Befehle von Claude Code. Der Status wird beim Prüfen live abgefragt.</p>
      {list.isLoading && <Loading label="Server werden geprüft …" />}
      {list.isError && <ErrorBanner>{errorMessage(list.error)}</ErrorBanner>}
      {list.data?.length === 0 && <EmptyState icon={<Server className="h-8 w-8" />} title="Keine MCP Server konfiguriert" />}
      <div className={cn("divide-y divide-border rounded-lg border border-border", !list.data?.length && "hidden")}>
        {list.data?.map((s) => (
          <div key={s.name} className="flex items-center gap-3 px-3 py-2 text-body">
            <Server className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div>{s.name}</div>
              <div className="truncate font-mono text-caption text-subtle">{s.target}</div>
            </div>
            <Badge tone={MCP_STATUS_TONE[s.status]}>
              <span title={mcpStatusText(s.statusText)}>{MCP_STATUS[s.status]}</span>
            </Badge>
            <Button
              size="icon-sm"
              variant="danger-ghost"
              aria-label={`${s.name} entfernen`}
              onClick={() => {
                setScope("user");
                setRemoving(s.name);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      <AddMcpDialog open={adding} onOpenChange={setAdding} projectId={projectId} onAdded={() => void qc.invalidateQueries({ queryKey: ["mcp"] })} />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`MCP Server ${removing ?? ""} entfernen?`}
        description="Claude Code entfernt den Eintrag aus dem gewählten Bereich. Wähle den Bereich, in dem der Server eingetragen ist."
        confirmLabel="Entfernen"
        danger
        onConfirm={async () => {
          if (!removing) return;
          try {
            await call("mcp.remove", { projectId, name: removing, scope });
            toast.success("Entfernt", removing);
            void qc.invalidateQueries({ queryKey: ["mcp"] });
          } catch (e) {
            toast.error("Nicht entfernt", errorMessage(e));
            throw e;
          }
        }}
      >
        <Field label="Bereich">
          <Select value={scope} onChange={setScope} className="w-full" options={mcpScopeOptions(projectId)} />
        </Field>
      </ConfirmDialog>
    </section>
  );
}

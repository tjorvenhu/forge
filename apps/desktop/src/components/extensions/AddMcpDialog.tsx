import { useEffect, useState } from "react";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { parseEnvLines } from "./env";
import { mcpScopeOptions, type McpScope } from "./mcp";
import { t } from "@/i18n";

const m = t.extensions.addMcp;

export function AddMcpDialog({ open, onOpenChange, projectId, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [scope, setScope] = useState<McpScope>(projectId ? "local" : "user");
  const [busy, setBusy] = useState(false);
  const parsedEnv = parseEnvLines(env);

  useEffect(() => {
    if (!open) return;
    setName("");
    setTransport("stdio");
    setTarget("");
    setArgs("");
    setEnv("");
    setScope(projectId ? "local" : "user");
  }, [open, projectId]);

  const submit = async () => {
    if (!parsedEnv.env) return;
    setBusy(true);
    try {
      await call("mcp.add", { projectId, name, scope, transport, target, args: args.trim() ? args.trim().split(/\s+/) : [], env: parsedEnv.env });
      toast.success(m.added, name);
      onAdded();
      onOpenChange(false);
    } catch (e) {
      toast.error(m.notAdded, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {m.cancel}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name || !target || !!parsedEnv.error} loading={busy}>
            {m.add}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={m.name}>
          <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} placeholder="context7" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={m.type}>
            <Select
              value={transport}
              onChange={setTransport}
              className="w-full"
              options={[
                { value: "stdio", label: m.stdio },
                { value: "http", label: "HTTP" },
                { value: "sse", label: "SSE" },
              ]}
            />
          </Field>
          <Field label={m.scope}>
            <Select value={scope} onChange={setScope} className="w-full" options={mcpScopeOptions(projectId)} />
          </Field>
        </div>
        <Field label={transport === "stdio" ? m.command : m.url}>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={transport === "stdio" ? "npx" : "https://…"} className="font-mono text-xs" />
        </Field>
        {transport === "stdio" && (
          <Field label={m.args} hint={m.argsHint}>
            <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @upstash/context7-mcp" className="font-mono text-xs" />
          </Field>
        )}
        <div>
          <Field label={m.env} hint={m.envHint}>
            <Textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={3} className="font-mono text-xs" aria-invalid={!!parsedEnv.error} />
          </Field>
          {parsedEnv.error && (
            <p className="mt-1 text-xs text-danger" role="alert">
              {parsedEnv.error}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

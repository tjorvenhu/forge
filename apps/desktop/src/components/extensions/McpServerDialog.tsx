import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Eye, EyeOff, TriangleAlert } from "lucide-react";
import type { McpScope, McpTransport } from "@forge/protocol";
import { call, useProjects } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/input";
import { ErrorBanner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { parseEnvLines, parseHeaderLines } from "./env";
import { authForm, authPayload, authProblem, EMPTY_AUTH, mcpScopeOptions, type McpAuthForm, type McpAuthKind } from "./mcp";
import { t } from "@/i18n";

const m = t.extensions.addMcp;

/**
 * Adds an MCP server, or edits one (`editName`): Claude Code has no edit command, so saving removes
 * the old entry and adds the new one; the sidecar puts the old one back if that fails.
 */
export function McpServerDialog({
  open,
  onOpenChange,
  projectId,
  editName,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** the open project: lists and edits are read from its folder */
  projectId?: string;
  editName?: string | null;
  onSaved: () => void;
}) {
  const projects = useProjects();
  const mainProjects = (projects.data ?? []).filter((p) => !p.parentId && p.exists);
  const existing = useQuery({
    queryKey: ["mcp-config", projectId ?? "global", editName],
    queryFn: () => call("mcp.get", { projectId, name: editName! }),
    enabled: open && !!editName,
    staleTime: 0,
    gcTime: 0,
  });
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [scope, setScope] = useState<McpScope>(projectId ? "local" : "user");
  const [forProject, setForProject] = useState<string | undefined>(projectId);
  const [auth, setAuth] = useState<McpAuthForm>(EMPTY_AUTH);
  const [busy, setBusy] = useState(false);
  const setAuthField = <K extends keyof McpAuthForm>(k: K, v: McpAuthForm[K]) => setAuth((a) => ({ ...a, [k]: v }));

  useEffect(() => {
    if (!open || editName) return;
    setName("");
    setTransport("stdio");
    setTarget("");
    setArgs("");
    setEnv("");
    setScope(projectId ? "local" : "user");
    setForProject(projectId);
    setAuth(EMPTY_AUTH);
  }, [open, projectId, editName]);

  const cfg = existing.data;
  useEffect(() => {
    if (!open || !cfg) return;
    setName(cfg.name);
    setTransport(cfg.transport);
    setTarget(cfg.target);
    setArgs(cfg.args.join(" "));
    setEnv(
      Object.entries(cfg.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n"),
    );
    setScope(cfg.scope);
    setForProject(projectId);
    setAuth(authForm(cfg));
  }, [open, cfg, projectId]);

  const remote = transport !== "stdio";
  const parsedEnv = parseEnvLines(env);
  const parsedHeaders = parseHeaderLines(remote ? auth.headers : "");
  const problem = authProblem(remote ? auth : EMPTY_AUTH);
  const needsProject = scope !== "user";
  // An entry of a project or local scope is removed in the folder it was read from, so the new one goes there too.
  const folderLocked = !!cfg && cfg.scope !== "user";
  const writeProject = folderLocked || !needsProject ? projectId : forProject;
  const hasSecrets = remote && (auth.kind === "bearer" || auth.kind === "apiKey" || !!auth.headers.trim());
  const loading = !!editName && existing.isPending;
  const canSave =
    !!name && !!target && !parsedEnv.error && !parsedHeaders.error && !problem.incomplete && !problem.error && (!needsProject || folderLocked || !!forProject) && !loading;

  const submit = async () => {
    if (!parsedEnv.env || !parsedHeaders.headers) return;
    setBusy(true);
    try {
      const { headers, oauth } = remote ? authPayload(auth, parsedHeaders.headers) : { headers: {}, oauth: undefined };
      await call("mcp.add", {
        projectId: writeProject,
        name,
        scope,
        transport,
        target,
        args: !remote && args.trim() ? args.trim().split(/\s+/) : [],
        env: parsedEnv.env,
        headers,
        oauth,
        replaces: cfg ? { name: cfg.name, scope: cfg.scope } : undefined,
      });
      toast.success(editName ? m.saved : m.added, name);
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(editName ? m.notSaved : m.notAdded, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const authKinds: Array<{ value: McpAuthKind; label: string; description: string }> = [
    { value: "none", ...m.authKinds.none },
    { value: "bearer", ...m.authKinds.bearer },
    { value: "apiKey", ...m.authKinds.apiKey },
    { value: "oauth", ...m.authKinds.oauth },
  ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editName ? m.editTitle(editName) : m.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {m.cancel}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSave} loading={busy}>
            {editName ? m.save : m.add}
          </Button>
        </>
      }
    >
      {existing.isError ? (
        <ErrorBanner>{errorMessage(existing.error)}</ErrorBanner>
      ) : loading ? (
        <SkeletonRegion label={m.loading} className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-[74px] w-full" />
          </div>
        </SkeletonRegion>
      ) : (
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
              <Select value={scope} onChange={setScope} className="w-full" options={mcpScopeOptions(mainProjects.length > 0 || !!projectId)} />
            </Field>
          </div>
          {needsProject && !(folderLocked && !projectId) && (
            <Field label={m.project}>
              {projects.isPending ? (
                <Skeleton className="h-8 w-full" />
              ) : mainProjects.length ? (
                <Select
                  value={folderLocked ? projectId : forProject}
                  onChange={setForProject}
                  placeholder={m.pickProject}
                  className="w-full"
                  disabled={folderLocked}
                  options={mainProjects.map((p) => ({ value: p.id, label: p.name, description: p.path }))}
                />
              ) : (
                <p className="text-xs text-muted">{m.noProjects}</p>
              )}
            </Field>
          )}
          <Field label={remote ? m.url : m.command}>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={remote ? "https://…" : "npx"} className="font-mono text-xs" />
          </Field>
          {!remote && (
            <Field label={m.args} hint={m.argsHint}>
              <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @upstash/context7-mcp" className="font-mono text-xs" />
            </Field>
          )}
          {remote && (
            <>
              <Field label={m.auth}>
                <Select value={auth.kind} onChange={(v) => setAuthField("kind", v)} className="w-full" options={authKinds} />
              </Field>
              {auth.kind === "bearer" && (
                <Field label={m.token}>
                  <SecretInput value={auth.token} onChange={(v) => setAuthField("token", v)} placeholder="sk-…" />
                </Field>
              )}
              {auth.kind === "apiKey" && (
                <div className="grid grid-cols-[2fr_3fr] gap-3">
                  <Field label={m.headerName}>
                    <Input value={auth.keyHeader} onChange={(e) => setAuthField("keyHeader", e.target.value.replace(/\s/g, ""))} className="font-mono text-xs" />
                  </Field>
                  <Field label={m.headerValue}>
                    <SecretInput value={auth.keyValue} onChange={(v) => setAuthField("keyValue", v)} />
                  </Field>
                </div>
              )}
              {auth.kind === "oauth" && (
                <>
                  <Field label={m.clientId} hint={m.oauthHint}>
                    <Input value={auth.clientId} onChange={(e) => setAuthField("clientId", e.target.value)} className="font-mono text-xs" />
                  </Field>
                  <div className="grid grid-cols-[3fr_2fr] gap-3">
                    <Field label={m.clientSecret} hint={editName ? m.clientSecretEdit : m.clientSecretHint}>
                      <SecretInput value={auth.clientSecret} onChange={(v) => setAuthField("clientSecret", v)} />
                    </Field>
                    <Field label={m.callbackPort} hint={m.callbackPortHint}>
                      <Input
                        value={auth.callbackPort}
                        onChange={(e) => setAuthField("callbackPort", e.target.value.replace(/\D/g, ""))}
                        inputMode="numeric"
                        placeholder="8080"
                        className="font-mono text-xs"
                        aria-invalid={!!problem.error}
                      />
                    </Field>
                  </div>
                  {problem.error && (
                    <p className="-mt-1 text-xs text-danger" role="alert">
                      {problem.error}
                    </p>
                  )}
                </>
              )}
              <div>
                <Field label={m.headers} hint={m.headersHint}>
                  <Textarea
                    value={auth.headers}
                    onChange={(e) => setAuthField("headers", e.target.value)}
                    rows={2}
                    placeholder="X-Team: forge"
                    className="font-mono text-xs"
                    aria-invalid={!!parsedHeaders.error}
                  />
                </Field>
                {parsedHeaders.error && (
                  <p className="mt-1 text-xs text-danger" role="alert">
                    {parsedHeaders.error}
                  </p>
                )}
              </div>
            </>
          )}
          <div>
            <Field label={m.env} hint={m.envHint}>
              <Textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={remote ? 2 : 3} className="font-mono text-xs" aria-invalid={!!parsedEnv.error} />
            </Field>
            {parsedEnv.error && (
              <p className="mt-1 text-xs text-danger" role="alert">
                {parsedEnv.error}
              </p>
            )}
          </div>
          {scope === "project" && (hasSecrets || !!env.trim()) && (
            <p className="flex gap-2 rounded-lg border border-warning/30 bg-warning-soft px-2.5 py-2 text-xs text-fg" role="note">
              <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
              {m.projectSecret}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
        spellCheck={false}
        className="pr-8 font-mono text-xs"
      />
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="absolute right-0.5 top-1/2 -translate-y-1/2"
        aria-label={shown ? m.hide : m.show}
        title={shown ? m.hide : m.show}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Blocks, Bot, Plus, RefreshCw, Save, Server, Trash2, Webhook } from "lucide-react";
import type { ConfigDoc, ConfigDocKind, ConfigScope } from "@forge/protocol";
import { call, useProject } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Page } from "@/components/layout/Page";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Badge, EmptyState, ErrorBanner, SectionTitle, Spinner } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { TabBar } from "@/components/ui/tabs";

type Tab = "mcp" | "skills" | "agents" | "hooks";

/** Claude Code extensions: MCP servers, skills, subagents and hooks, for the user and the open project. */
export function ExtensionsView() {
  const [tab, setTab] = useState<Tab>("mcp");
  const projectId = useUi((s) => s.activeProjectId) ?? undefined;
  const project = useProject(projectId ?? null);
  return (
    <Page
      title="Erweiterungen"
      subtitle={project.data ? `Global und für ${project.data.name}` : "Global (öffne ein Projekt, um Projekt-Erweiterungen zu sehen)"}
    >
      <div className="mb-4 border-b border-border">
        <TabBar<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "mcp", label: "MCP Server", icon: <Server className="h-3.5 w-3.5" /> },
            { value: "skills", label: "Skills", icon: <Blocks className="h-3.5 w-3.5" /> },
            { value: "agents", label: "Subagenten", icon: <Bot className="h-3.5 w-3.5" /> },
            { value: "hooks", label: "Hooks", icon: <Webhook className="h-3.5 w-3.5" /> },
          ]}
        />
      </div>
      <div className="max-w-5xl">
        {tab === "mcp" && <McpTab projectId={projectId} />}
        {tab === "skills" && <DocsTab kind="skill" projectId={projectId} />}
        {tab === "agents" && <DocsTab kind="agent" projectId={projectId} />}
        {tab === "hooks" && <HooksTab projectId={projectId} />}
      </div>
    </Page>
  );
}

// ---------- MCP

function McpTab({ projectId }: { projectId?: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["mcp", projectId ?? "global"], queryFn: () => call("mcp.list", { projectId }), staleTime: 60_000 });
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [scope, setScope] = useState<"user" | "project" | "local">("local");
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
      {list.isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-3.5 w-3.5" /> Server werden geprüft …
        </div>
      )}
      {list.isError && <ErrorBanner>{errorMessage(list.error)}</ErrorBanner>}
      {list.data?.length === 0 && <EmptyState icon={<Server className="h-8 w-8" />} title="Keine MCP Server konfiguriert" />}
      <div className="divide-y divide-border rounded-lg border border-border">
        {list.data?.map((s) => (
          <div key={s.name} className="flex items-center gap-3 px-3 py-2 text-[13px]">
            <Server className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div>{s.name}</div>
              <div className="truncate font-mono text-[11px] text-subtle">{s.target}</div>
            </div>
            <Badge tone={s.status === "connected" ? "success" : s.status === "failed" ? "danger" : s.status === "needs_auth" ? "warning" : "neutral"} >
              <span title={s.statusText}>{MCP_STATUS[s.status]}</span>
            </Badge>
            <Button size="icon-sm" variant="danger-ghost" aria-label={`${s.name} entfernen`} onClick={() => setRemoving(s.name)}>
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
        description="Claude Code entfernt den Eintrag aus dem gewählten Bereich."
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
          }
        }}
      >
        <Field label="Bereich">
          <Select value={scope} onChange={setScope} className="w-full" options={SCOPE_OPTIONS} />
        </Field>
      </ConfirmDialog>
    </section>
  );
}

const MCP_STATUS = { connected: "verbunden", failed: "Verbindung fehlgeschlagen", needs_auth: "Anmeldung nötig", unknown: "unbekannt" } as const;

const SCOPE_OPTIONS: Array<{ value: "user" | "project" | "local"; label: string; description: string }> = [
  { value: "local", label: "Lokal", description: "Nur dieses Projekt, nur für dich" },
  { value: "project", label: "Projekt", description: "In .mcp.json, wird mit dem Projekt geteilt" },
  { value: "user", label: "Global", description: "Alle Projekte" },
];

function AddMcpDialog({ open, onOpenChange, projectId, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; projectId?: string; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [target, setTarget] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [scope, setScope] = useState<"user" | "project" | "local">(projectId ? "local" : "user");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const envObj = Object.fromEntries(
        env
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      await call("mcp.add", { projectId, name, scope, transport, target, args: args.trim() ? args.trim().split(/\s+/) : [], env: envObj });
      toast.success("MCP Server hinzugefügt", name);
      onAdded();
      onOpenChange(false);
    } catch (e) {
      toast.error("Nicht hinzugefügt", errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="MCP Server hinzufügen"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name || !target} loading={busy}>
            Hinzufügen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} placeholder="context7" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Art">
            <Select
              value={transport}
              onChange={setTransport}
              className="w-full"
              options={[
                { value: "stdio", label: "Lokaler Befehl (stdio)" },
                { value: "http", label: "HTTP" },
                { value: "sse", label: "SSE" },
              ]}
            />
          </Field>
          <Field label="Bereich">
            <Select value={scope} onChange={setScope} className="w-full" options={projectId ? SCOPE_OPTIONS : SCOPE_OPTIONS.filter((o) => o.value === "user")} />
          </Field>
        </div>
        <Field label={transport === "stdio" ? "Befehl" : "URL"}>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={transport === "stdio" ? "npx" : "https://…"} className="font-mono text-xs" />
        </Field>
        {transport === "stdio" && (
          <Field label="Argumente" hint="Durch Leerzeichen getrennt">
            <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @upstash/context7-mcp" className="font-mono text-xs" />
          </Field>
        )}
        <Field label="Umgebungsvariablen (optional)" hint="Eine pro Zeile: NAME=wert">
          <textarea
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-2 font-mono text-xs text-fg focus:border-accent focus:outline-none"
          />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------- skills and subagents

function DocsTab({ kind, projectId }: { kind: ConfigDocKind; projectId?: string }) {
  const qc = useQueryClient();
  const docs = useQuery({ queryKey: ["docs", kind, projectId ?? "global"], queryFn: () => call("config.docs", { kind, projectId }) });
  const [selected, setSelected] = useState<ConfigDoc | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ConfigDoc | null>(null);
  const label = kind === "skill" ? "Skill" : "Subagent";
  const refresh = () => qc.invalidateQueries({ queryKey: ["docs", kind] });

  return (
    <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-4">
      <section className="rounded-xl border border-border bg-surface p-3">
        <SectionTitle
          action={
            <Button size="icon-sm" variant="ghost" aria-label={`${label} anlegen`} onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
            </Button>
          }
        >
          {kind === "skill" ? "Skills" : "Subagenten"}
        </SectionTitle>
        {docs.isLoading && <Spinner />}
        {docs.data?.length === 0 && <p className="px-1 text-xs text-muted">Noch keine eigenen {kind === "skill" ? "Skills" : "Subagenten"}.</p>}
        <ul className="flex flex-col gap-0.5">
          {docs.data?.map((d) => (
            <li key={`${d.scope}:${d.name}`}>
              <button
                onClick={() => setSelected(d)}
                className={cn(
                  "w-full rounded-md px-2 py-1.5 text-left",
                  selected?.name === d.name && selected.scope === d.scope ? "bg-accent-soft" : "hover:bg-surface-3",
                )}
              >
                <div className="flex items-center gap-1.5 text-[13px]">
                  <span className="truncate">{d.name}</span>
                  <Badge>{d.scope === "user" ? "global" : "Projekt"}</Badge>
                </div>
                {d.description && <div className="line-clamp-2 text-[11px] text-subtle">{d.description}</div>}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section className="min-w-0 rounded-xl border border-border bg-surface p-4">
        {selected ? (
          <DocEditor key={`${selected.scope}:${selected.name}`} doc={selected} projectId={projectId} onDelete={() => setDeleting(selected)} />
        ) : (
          <EmptyState icon={kind === "skill" ? <Blocks className="h-8 w-8" /> : <Bot className="h-8 w-8" />} title={`${label} auswählen oder anlegen`}>
            {kind === "skill"
              ? "Skills sind Anleitungen, die Claude bei passenden Aufgaben automatisch lädt (SKILL.md)."
              : "Subagenten sind spezialisierte Helfer mit eigener Rolle, die Claude für Teilaufgaben startet."}
          </EmptyState>
        )}
      </section>
      <CreateDocDialog
        kind={kind}
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        onCreated={(d) => {
          void refresh();
          setSelected(d);
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`${label} ${deleting?.name ?? ""} löschen?`}
        description="Eine Sicherung der Datei bleibt als .bak erhalten (bei Skills wird der ganze Ordner entfernt)."
        confirmLabel="Löschen"
        danger
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await call("config.docDelete", { kind, scope: deleting.scope, name: deleting.name, projectId });
            setSelected(null);
            void refresh();
          } catch (e) {
            toast.error("Nicht gelöscht", errorMessage(e));
          }
        }}
      />
    </div>
  );
}

function DocEditor({ doc, projectId, onDelete }: { doc: ConfigDoc; projectId?: string; onDelete: () => void }) {
  const q = useQuery({
    queryKey: ["doc", doc.kind, doc.scope, doc.name, projectId],
    queryFn: () => call("config.docRead", { kind: doc.kind, scope: doc.scope, name: doc.name, projectId }),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(null), [q.data?.mtimeMs]);
  const dirty = draft !== null && draft !== q.data?.content;
  const save = useCallback(async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      await call("config.docWrite", { kind: doc.kind, scope: doc.scope, name: doc.name, projectId, content: draft, expectedMtimeMs: q.data?.mtimeMs ?? null });
      toast.success("Gespeichert", doc.path);
      await q.refetch();
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [draft, doc, projectId, q]);
  if (q.isLoading) return <Spinner />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">{doc.path}</span>
        <Button size="sm" variant="danger-ghost" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5" /> Löschen
        </Button>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty} loading={saving}>
          <Save className="h-3.5 w-3.5" /> Speichern
        </Button>
      </div>
      <div className="h-[460px]">
        <CodeEditor value={draft ?? q.data?.content ?? ""} onChange={setDraft} language="markdown" onSave={() => void save()} ariaLabel={doc.name} />
      </div>
    </div>
  );
}

function CreateDocDialog({
  kind,
  open,
  onOpenChange,
  projectId,
  onCreated,
}: {
  kind: ConfigDocKind;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId?: string;
  onCreated: (d: ConfigDoc) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<ConfigScope>("user");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={kind === "skill" ? "Skill anlegen" : "Subagent anlegen"}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!/^[a-z0-9][a-z0-9-]*$/.test(name) || !description.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await call("config.docCreate", { kind, scope, name, description, projectId });
                onCreated({ kind, scope, name, description, path: r.path });
                onOpenChange(false);
                setName("");
                setDescription("");
              } catch (e) {
                toast.error("Nicht angelegt", errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Anlegen
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name" hint="Kleinbuchstaben, Ziffern, Bindestriche">
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="release-notes" autoFocus />
        </Field>
        <Field label="Beschreibung" hint="Woran Claude erkennt, wann er das hier nutzen soll">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Bereich">
          <Select<ConfigScope>
            value={scope}
            onChange={setScope}
            className="w-full"
            options={[
              { value: "user", label: "Global", description: "~/.claude, für alle Projekte" },
              ...(projectId ? [{ value: "project" as const, label: "Projekt", description: ".claude im Projekt, wird mit dem Repo geteilt" }] : []),
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------- hooks

function HooksTab({ projectId }: { projectId?: string }) {
  const [scope, setScope] = useState<"user" | "project" | "local">("user");
  const q = useQuery({ queryKey: ["hooks", scope, projectId], queryFn: () => call("config.hooksRead", { scope, projectId }) });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(null), [q.data?.mtimeMs, scope]);
  const dirty = draft !== null && draft !== q.data?.hooks;
  const save = useCallback(async () => {
    if (draft === null) return;
    setSaving(true);
    try {
      await call("config.hooksWrite", { scope, projectId, hooks: draft, expectedMtimeMs: q.data?.mtimeMs ?? null });
      toast.success("Hooks gespeichert", q.data?.path);
      await q.refetch();
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [draft, scope, projectId, q]);
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
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">{q.data?.path}</span>
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty} loading={saving}>
          <Save className="h-3.5 w-3.5" /> Speichern
        </Button>
      </div>
      {q.isError && <ErrorBanner>{errorMessage(q.error)}</ErrorBanner>}
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="h-[420px]">
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

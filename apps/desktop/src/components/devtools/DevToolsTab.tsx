import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, Database, FileInput, Play, RotateCcw, RotateCw, Square } from "lucide-react";
import type { DevToolsConfig, Project, TestDbState } from "@forge/protocol";
import { call, keys, useDevServer, useDevTools, useTestDb } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { Badge, ErrorBanner, Loading } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { Group, Row, SwitchRow } from "@/components/settings/layout";
import { DevServerPanel } from "@/components/workspace/DevServer";

const AUTOSAVE_MS = 800;
const ENV_KEY_RE = /^[^\S\n]*(?:export[^\S\n]+)?([A-Za-z_][A-Za-z0-9_.-]*)[^\S\n]*=/gm;

/** Variable names in .env text, in order, without duplicates. */
export function envKeys(text: string): string[] {
  return [...new Set([...text.matchAll(ENV_KEY_RE)].map((m) => m[1]!))];
}

type DbPatch = Partial<Omit<DevToolsConfig["database"], "password">>;

/**
 * Dev tools of a project: dev server with its start command and output, a local PostgreSQL for
 * tests and a test environment (.env) for both. Worktrees share test database and environment with
 * their project; the dev server is their own.
 */
export function DevToolsTab({ project }: { project: Project }) {
  const owner = project.parentId ?? project.id;
  const config = useDevTools(owner);
  const qc = useQueryClient();

  const update = useCallback(
    async (patch: { env?: string; useEnv?: boolean; database?: DbPatch }, quiet = false) => {
      try {
        const next = await call("devtools.update", { projectId: owner, ...patch });
        qc.setQueryData(keys.devTools(owner), next);
        void qc.invalidateQueries({ queryKey: keys.testDb(owner) });
        if (!quiet) toast.saved();
        return true;
      } catch (e) {
        toast.error("Nicht gespeichert", errorMessage(e));
        return false;
      }
    },
    [owner, qc],
  );

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="mx-auto grid max-w-7xl gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <DevServerCard project={project} />
        <div className="flex min-w-0 flex-col gap-5">
          {config.isLoading ? (
            <Loading />
          ) : config.isError || !config.data ? (
            <ErrorBanner>{errorMessage(config.error)}</ErrorBanner>
          ) : (
            <>
              <TestDbCard owner={owner} config={config.data} update={update} isWorktree={!!project.parentId} />
              <TestEnvCard owner={owner} config={config.data} update={update} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DevServerCard({ project }: { project: Project }) {
  const qc = useQueryClient();
  const dev = useDevServer(project.id).data;
  const saveCommand = async (devCommand: string | null) => {
    try {
      await call("projects.update", { projectId: project.id, devCommand });
      await qc.invalidateQueries({ queryKey: keys.project(project.id) });
      void qc.invalidateQueries({ queryKey: keys.devServer(project.id) });
      toast.saved();
    } catch (e) {
      toast.error("Nicht gespeichert", errorMessage(e));
    }
  };
  return (
    <Group title="Dev-Server" description="Läuft im Projektordner. Bekommt die Test-Umgebung und, solange sie läuft, die Verbindung zur Test-Datenbank.">
      <Row label="Startbefehl" description="Leer lassen, um den erkannten Befehl aus package.json zu nutzen." stacked>
        <Input
          key={project.devCommand ?? ""}
          defaultValue={project.devCommand ?? ""}
          placeholder={dev?.effectiveCommand && !project.devCommand ? `Erkannt: ${dev.effectiveCommand}` : "z. B. pnpm dev"}
          className="font-mono text-xs"
          aria-label="Startbefehl des Dev-Servers"
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== project.devCommand) void saveCommand(v);
          }}
        />
      </Row>
      <div className="h-[28rem] xl:h-[34rem]">
        <DevServerPanel project={project} />
      </div>
    </Group>
  );
}

function dbBadge(state: TestDbState | undefined) {
  switch (state?.status) {
    case "running":
      return <Badge tone="success">läuft</Badge>;
    case "installing":
      return <Badge tone="warning">wird geladen</Badge>;
    case "starting":
      return <Badge tone="warning">startet</Badge>;
    case "stopping":
      return <Badge tone="warning">stoppt</Badge>;
    case "failed":
      return <Badge tone="danger">Fehler</Badge>;
    default:
      return <Badge>gestoppt</Badge>;
  }
}

function TestDbCard({
  owner,
  config,
  update,
  isWorktree,
}: {
  owner: string;
  config: DevToolsConfig;
  update: (patch: { database: DbPatch }, quiet?: boolean) => Promise<boolean>;
  isWorktree: boolean;
}) {
  const qc = useQueryClient();
  const state = useTestDb(owner).data;
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const db = config.database;
  const running = state?.status === "running";
  const working = busy || state?.status === "installing" || state?.status === "starting" || state?.status === "stopping";

  const act = async (method: "testdb.start" | "testdb.stop", errorTitle: string) => {
    setBusy(true);
    try {
      qc.setQueryData(keys.testDb(owner), await call(method, { projectId: owner }));
    } catch (e) {
      toast.error(errorTitle, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    await act("testdb.stop", "Test-Datenbank nicht gestoppt");
    await act("testdb.start", "Test-Datenbank nicht gestartet");
  };

  /** Port and name apply from the next start; a running server keeps the old ones until then. */
  const saveDb = async (patch: DbPatch) => {
    const ok = await update({ database: patch }, running);
    if (ok && running && (patch.port !== undefined || patch.name !== undefined)) toast.info("Gespeichert", "Gilt nach einem Neustart der Test-Datenbank.");
  };

  return (
    <Group
      title="Test-Datenbank"
      description={`PostgreSQL ${state?.version ?? "17"} nur für dieses Projekt, erreichbar nur auf diesem Rechner. Die Daten bleiben bis zum Zurücksetzen erhalten.${isWorktree ? " Agenten nutzen die Datenbank ihres Projekts." : ""}`}
      action={dbBadge(state)}
    >
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <>
              <Button size="sm" onClick={() => void act("testdb.stop", "Test-Datenbank nicht gestoppt")} disabled={working}>
                <Square className="h-3 w-3 fill-current" /> Stoppen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void restart()} disabled={working}>
                <RotateCw className="h-3.5 w-3.5" /> Neu starten
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void act("testdb.start", "Test-Datenbank nicht gestartet")} loading={working} disabled={working}>
              <Play className="h-3.5 w-3.5" /> Starten
            </Button>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="danger-ghost" onClick={() => setResetting(true)} disabled={working || !state?.initialized}>
            <RotateCcw className="h-3.5 w-3.5" /> Zurücksetzen …
          </Button>
        </div>

        {state?.status === "installing" && (
          <div className="flex flex-col gap-1.5" role="status">
            <div className="text-xs text-muted">PostgreSQL wird einmalig geladen (rund 38 MB): {Math.round((state.progress ?? 0) * 100)} %</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round((state.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {state && !state.installed && state.status === "stopped" && (
          <p className="text-xs text-muted">Beim ersten Start lädt FORGE PostgreSQL einmalig herunter (rund 38 MB) und prüft die Prüfsumme. Docker ist nicht nötig.</p>
        )}
        {state?.error && <ErrorBanner title="Start fehlgeschlagen">{state.error}</ErrorBanner>}

        <ConnectionUrl url={state?.url ?? ""} />
      </div>

      <Row label="Port" description="Gilt ab dem nächsten Start.">
        <Input
          key={db.port}
          type="number"
          min={1024}
          max={65535}
          defaultValue={db.port}
          className="w-28 font-mono text-xs"
          aria-label="Port der Test-Datenbank"
          onBlur={(e) => {
            const port = Number(e.target.value);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
              e.target.value = String(db.port);
              return toast.error("Ungültiger Port", "Erlaubt sind 1024 bis 65535.");
            }
            if (port !== db.port) void saveDb({ port });
          }}
        />
      </Row>
      <Row label="Datenbank" description="Wird beim nächsten Start angelegt, falls es sie noch nicht gibt.">
        <Input
          key={db.name}
          defaultValue={db.name}
          className="w-44 font-mono text-xs"
          aria-label="Name der Test-Datenbank"
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name === db.name) return;
            if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
              e.target.value = db.name;
              return toast.error("Ungültiger Name", "Kleinbuchstaben, Ziffern und Unterstriche, am Anfang keine Ziffer.");
            }
            void saveDb({ name });
          }}
        />
      </Row>
      <Row label="Übergeben als" description="Umgebungsvariable mit der Verbindungs-URL für Dev-Server und Tests. Leer: wird nicht übergeben.">
        <Input
          key={db.envVar ?? ""}
          defaultValue={db.envVar ?? ""}
          placeholder="DATABASE_URL"
          className="w-44 font-mono text-xs"
          aria-label="Variable für die Verbindungs-URL"
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v === db.envVar) return;
            if (v && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
              e.target.value = db.envVar ?? "";
              return toast.error("Ungültiger Variablenname", "Buchstaben, Ziffern und Unterstriche.");
            }
            void saveDb({ envVar: v });
          }}
        />
      </Row>
      <SwitchRow
        label="Mit dem Dev-Server starten"
        description="Startet die Test-Datenbank, bevor der Dev-Server startet."
        checked={db.withDevServer}
        onChange={(withDevServer) => void saveDb({ withDevServer })}
      />

      <div className="px-4 py-2.5">
        <button onClick={() => setLogOpen(!logOpen)} className="flex items-center gap-1 text-xs text-muted hover:text-fg" aria-expanded={logOpen}>
          {logOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Protokoll
        </button>
        {logOpen && <DbLog owner={owner} state={state} />}
      </div>

      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Test-Datenbank zurücksetzen?"
        description={`Alle Tabellen und Daten in ${db.name} werden gelöscht. Der nächste Start legt eine leere Datenbank an.`}
        confirmLabel="Zurücksetzen"
        danger
        onConfirm={async () => {
          try {
            const wasRunning = running;
            qc.setQueryData(keys.testDb(owner), await call("testdb.reset", { projectId: owner }));
            if (wasRunning) qc.setQueryData(keys.testDb(owner), await call("testdb.start", { projectId: owner }));
            toast.success("Test-Datenbank zurückgesetzt", wasRunning ? "Sie läuft wieder, leer." : undefined);
          } catch (e) {
            toast.error("Nicht zurückgesetzt", errorMessage(e));
            throw e;
          }
        }}
      />
    </Group>
  );
}

function ConnectionUrl({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Nicht kopiert", "Die Zwischenablage ist nicht erreichbar.");
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Database className="h-4 w-4 shrink-0 text-subtle" />
      <Input readOnly value={url} className="min-w-0 flex-1 font-mono text-xs" aria-label="Verbindungs-URL" onFocus={(e) => e.target.select()} />
      <Button size="icon-sm" variant="ghost" onClick={() => void copy()} aria-label="Verbindungs-URL kopieren" title="Verbindungs-URL kopieren">
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

function DbLog({ owner, state }: { owner: string; state: TestDbState | undefined }) {
  const log = useQuery({ queryKey: [...keys.testDb(owner), "log", state?.status], queryFn: () => call("testdb.log", { projectId: owner }), staleTime: 0 });
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log.data]);
  return (
    <pre ref={ref} className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg px-3 py-2 font-mono text-caption leading-[1.45] text-muted">
      {log.isLoading ? "Lädt …" : log.data?.text.trim() || "Noch kein Protokoll. Es entsteht beim ersten Start."}
    </pre>
  );
}

function TestEnvCard({ owner, config, update }: { owner: string; config: DevToolsConfig; update: (patch: { env?: string; useEnv?: boolean }, quiet?: boolean) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const files = useQuery({ queryKey: [...keys.devTools(owner), "envFiles"], queryFn: () => call("devtools.envFiles", { projectId: owner }), staleTime: 10_000 });
  const text = draft ?? config.env;
  const names = envKeys(text);

  // Saves shortly after the last key; leaving the tab saves what is still pending.
  const latest = useRef({ draft, saved: config.env });
  latest.current = { draft, saved: config.env };
  // Only the text that was sent is cleared: keys typed while saving stay in the draft.
  const saveDraft = useCallback(
    (sent: string) => void update({ env: sent }).then((ok) => ok && setDraft((d) => (d === sent ? null : d))),
    [update],
  );
  useEffect(() => {
    if (draft === null || draft === config.env) return;
    const t = setTimeout(() => saveDraft(draft), AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [draft, config.env, saveDraft]);
  useEffect(
    () => () => {
      const { draft: d, saved } = latest.current;
      if (d !== null && d !== saved) void update({ env: d }, true);
    },
    [update],
  );

  const importFile = async (name: string) => {
    try {
      const { text: content } = await call("devtools.readEnvFile", { projectId: owner, name });
      const cur = text.trimEnd();
      setDraft(cur ? `${cur}\n\n# aus ${name}\n${content.trimEnd()}\n` : `${content.trimEnd()}\n`);
      toast.info(`${name} übernommen`, "Prüf die Werte: für Tests oft eigene Schlüssel und Adressen verwenden.");
    } catch (e) {
      toast.error("Nicht übernommen", errorMessage(e));
    }
  };

  return (
    <Group
      title="Test-Umgebung"
      description="Variablen im .env-Format für Dev-Server und Tests. Sie bleiben in FORGE und landen nie im Projektordner oder im Git. Claude sieht nur die Namen."
      action={<Switch checked={config.useEnv} onChange={(useEnv) => void update({ useEnv })} label="Test-Umgebung verwenden" />}
    >
      <div className="flex flex-col gap-2 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted" title={names.join(", ")}>
            {!config.useEnv ? "Ausgeschaltet: Dev-Server und Tests laufen ohne diese Variablen." : names.length ? `${names.length} ${names.length === 1 ? "Variable" : "Variablen"}: ${names.join(", ")}` : "Noch keine Variablen."}
          </span>
          {(files.data?.length ?? 0) > 0 && (
            <DropdownMenu
              header="Aus Datei im Projekt übernehmen"
              trigger={
                <Button size="sm" variant="ghost">
                  <FileInput className="h-3.5 w-3.5" /> Aus Datei
                </Button>
              }
              items={(files.data ?? []).map((f) => ({ label: f, onSelect: () => void importFile(f) }))}
            />
          )}
        </div>
        <div className="h-64">
          <CodeEditor
            value={text}
            onChange={setDraft}
            language="text"
            ariaLabel="Test-Umgebung im .env-Format"
            onSave={() => draft !== null && saveDraft(draft)}
          />
        </div>
        <p className="text-caption text-subtle">Beispiel: API_URL=http://localhost:4000. Next.js, Vite und dotenv lassen diese Werte vor gleichnamigen Einträgen aus .env-Dateien des Projekts gelten.</p>
      </div>
    </Group>
  );
}

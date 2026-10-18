import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Copy, Database, FileInput, FileKey, Play, RotateCcw, RotateCw, Server, Square } from "lucide-react";
import type { DevToolsConfig, Project, TestDbState } from "@forge/protocol";
import { call, keys, useDevServer, useDevTools, useTestDb } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { toast } from "@/stores/toast";
import { useUi, type DevToolsSection } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu } from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import { Badge, ErrorBanner, InfoTip } from "@/components/ui/misc";
import { EditorSkeleton, Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Group, Row, SettingsLayout, SwitchRow, type SettingsSectionDef } from "@/components/settings/layout";
import { DevServerControls, DevServerPanel } from "@/components/workspace/DevServer";
import { t } from "@/i18n";

const m = t.devtools;

const AUTOSAVE_MS = 800;
const ENV_KEY_RE = /^[^\S\n]*(?:export[^\S\n]+)?([A-Za-z_][A-Za-z0-9_.-]*)[^\S\n]*=/gm;

/** Variable names in .env text, in order, without duplicates. */
export function envKeys(text: string): string[] {
  return [...new Set([...text.matchAll(ENV_KEY_RE)].map((m) => m[1]!))];
}

type DbPatch = Partial<Omit<DevToolsConfig["database"], "password">>;

/**
 * Dev tools of a project, in sections like the settings: dev server with its start command and
 * output, a local PostgreSQL for tests and a test environment (.env) for both. Worktrees share the
 * settings with their project; dev server and test database (a copy, own port) are their own.
 */
export function DevToolsTab({ project }: { project: Project }) {
  const owner = project.parentId ?? project.id;
  const config = useDevTools(owner);
  const qc = useQueryClient();
  const section = useUi((s) => s.devToolsSection);
  const setSection = useUi((s) => s.setDevToolsSection);

  const update = useCallback(
    async (patch: { env?: string; useEnv?: boolean; database?: DbPatch }, quiet = false) => {
      try {
        const next = await call("devtools.update", { projectId: owner, ...patch });
        qc.setQueryData(keys.devTools(owner), next);
        void qc.invalidateQueries({ queryKey: keys.testDb(owner) });
        if (project.id !== owner) void qc.invalidateQueries({ queryKey: keys.testDb(project.id) });
        if (!quiet) toast.saved();
        return true;
      } catch (e) {
        toast.error(m.notSaved, errorMessage(e));
        return false;
      }
    },
    [owner, project.id, qc],
  );

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <SettingsLayout sections={SECTIONS} current={section} onSelect={setSection} label={m.navLabel}>
        {section === "server" ? (
          <DevServerCard project={project} />
        ) : config.isLoading ? (
          section === "database" ? (
            <TestDbSkeleton dbId={project.id} isWorktree={!!project.parentId} />
          ) : (
            <TestEnvSkeleton />
          )
        ) : config.isError || !config.data ? (
          <ErrorBanner>{errorMessage(config.error)}</ErrorBanner>
        ) : section === "database" ? (
          <TestDbCard dbId={project.id} config={config.data} update={update} isWorktree={!!project.parentId} />
        ) : (
          <TestEnvCard owner={owner} config={config.data} update={update} />
        )}
      </SettingsLayout>
    </div>
  );
}

export const SECTIONS: ReadonlyArray<SettingsSectionDef<DevToolsSection>> = [
  { id: "server", ...m.sections.server, Icon: Server },
  // Both belong to the dev server: it gets the variables and the database URL when it starts.
  { id: "env", ...m.sections.env, Icon: FileKey, parent: "server" },
  { id: "database", ...m.sections.database, Icon: Database, parent: "server" },
];

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
      toast.error(m.notSaved, errorMessage(e));
    }
  };
  return (
    <Group
      title={m.server.title}
      description={m.server.description}
      action={<DevServerControls project={project} />}
    >
      <Row label={m.server.command} description={m.server.commandDescription} stacked>
        <Input
          key={project.devCommand ?? ""}
          defaultValue={project.devCommand ?? ""}
          placeholder={dev?.effectiveCommand && !project.devCommand ? m.server.detected(dev.effectiveCommand) : m.server.commandPlaceholder}
          className="font-mono text-xs"
          aria-label={m.server.commandAria}
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v !== project.devCommand) void saveCommand(v);
          }}
        />
      </Row>
      <div className="h-[28rem] xl:h-[34rem]">
        <DevServerPanel project={project} controls={false} />
      </div>
    </Group>
  );
}

function dbBadge(state: TestDbState | undefined) {
  switch (state?.status) {
    case "running":
      return <Badge tone="success">{m.db.status.running}</Badge>;
    case "installing":
      return <Badge tone="warning">{m.db.status.installing}</Badge>;
    case "starting":
      return <Badge tone="warning">{m.db.status.starting}</Badge>;
    case "stopping":
      return <Badge tone="warning">{m.db.status.stopping}</Badge>;
    case "failed":
      return <Badge tone="danger">{m.db.status.failed}</Badge>;
    default:
      return <Badge>{m.db.status.stopped}</Badge>;
  }
}

function dbDescription(version: string | undefined, isWorktree: boolean) {
  return isWorktree
    ? m.db.descriptionWorktree(version ?? "17")
    : m.db.description(version ?? "17");
}

function DbBadgeSkeleton() {
  return (
    <SkeletonRegion label={m.db.loadingStatus}>
      <Skeleton className="h-5 w-16 rounded" />
    </SkeletonRegion>
  );
}

/** Start and reset buttons while the state is unknown, so no "gestoppt" and no start button show too early. */
function DbActionsSkeleton() {
  return (
    <SkeletonRegion label={m.db.loadingControls} className="flex items-center gap-2">
      <Skeleton className="h-7 w-22" />
      <div className="flex-1" />
      <Skeleton className="h-7 w-30" />
    </SkeletonRegion>
  );
}

/** A settings row with a placeholder for its control (input width or a switch). */
function RowSkeleton({ control }: { control: string }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-5 items-center">
          <Skeleton className="h-3 w-28 rounded-sm" />
        </div>
        <div className="mt-0.5 flex h-4 items-center">
          <Skeleton className="h-2.5 w-3/5 rounded-sm" />
        </div>
      </div>
      <Skeleton className={control} />
    </div>
  );
}

/** The test database card while the dev tools config loads: real header, placeholders for buttons, URL and settings. */
function TestDbSkeleton({ dbId, isWorktree }: { dbId: string; isWorktree: boolean }) {
  const version = useTestDb(dbId).data?.version;
  return (
    <Group title={m.db.title} description={dbDescription(version, isWorktree)} action={<Skeleton className="h-5 w-16 rounded" />}>
      <SkeletonRegion label={m.db.loading} className="divide-y divide-border">
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-22" />
            <div className="flex-1" />
            <Skeleton className="h-7 w-30" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 shrink-0 rounded-sm" />
            <Skeleton className="h-8 min-w-0 flex-1" />
            <Skeleton className="h-7 w-7 shrink-0" />
          </div>
        </div>
        {!isWorktree && <RowSkeleton control="h-8 w-28" />}
        <RowSkeleton control="h-8 w-44" />
        <RowSkeleton control="h-8 w-44" />
        <RowSkeleton control="h-5 w-9 rounded-full" />
        <div className="flex h-9 items-center px-4">
          <Skeleton className="h-2.5 w-20 rounded-sm" />
        </div>
      </SkeletonRegion>
    </Group>
  );
}

const ENV_DESCRIPTION = (
  <div className="flex flex-col gap-1.5">
    <p>{m.env.description1}</p>
    <p>{m.env.description2}</p>
  </div>
);

/** The test .env card while the dev tools config loads; the editor box has its final height. */
function TestEnvSkeleton() {
  return (
    <Group title={m.env.title} description={ENV_DESCRIPTION} action={<Skeleton className="h-5 w-9 rounded-full" />}>
      <div className="flex flex-col gap-2 px-4 py-3.5">
        <div className="flex h-4 items-center">
          <Skeleton className="h-2.5 w-2/5 rounded-sm" />
        </div>
        <div className="h-64">
          <EditorSkeleton className="rounded-lg" label={m.env.loading} />
        </div>
      </div>
    </Group>
  );
}

function TestDbCard({
  dbId,
  config,
  update,
  isWorktree,
}: {
  dbId: string;
  config: DevToolsConfig;
  update: (patch: { database: DbPatch }, quiet?: boolean) => Promise<boolean>;
  isWorktree: boolean;
}) {
  const qc = useQueryClient();
  const stateQuery = useTestDb(dbId);
  const state = stateQuery.data;
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const db = config.database;
  const running = state?.status === "running";
  const working = busy || state?.status === "installing" || state?.status === "starting" || state?.status === "stopping";

  const act = async (method: "testdb.start" | "testdb.stop", errorTitle: string) => {
    setBusy(true);
    try {
      qc.setQueryData(keys.testDb(dbId), await call(method, { projectId: dbId }));
    } catch (e) {
      toast.error(errorTitle, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const restart = async () => {
    await act("testdb.stop", m.db.notStopped);
    await act("testdb.start", m.db.notStarted);
  };

  /** Port and name apply from the next start; a running server keeps the old ones until then. */
  const saveDb = async (patch: DbPatch) => {
    const ok = await update({ database: patch }, running);
    if (ok && running && (patch.port !== undefined || patch.name !== undefined)) toast.info(m.db.saved, m.db.afterRestart);
  };

  return (
    <Group title={m.db.title} description={dbDescription(state?.version, isWorktree)} action={stateQuery.isLoading ? <DbBadgeSkeleton /> : dbBadge(state)}>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {stateQuery.isLoading ? (
          <DbActionsSkeleton />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {running ? (
              <>
                <Button size="sm" onClick={() => void act("testdb.stop", m.db.notStopped)} disabled={working}>
                  <Square className="h-3 w-3 fill-current" /> {m.db.stop}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void restart()} disabled={working}>
                  <RotateCw className="h-3.5 w-3.5" /> {m.db.restart}
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" onClick={() => void act("testdb.start", m.db.notStarted)} loading={working} disabled={working}>
                  <Play className="h-3.5 w-3.5" /> {m.db.start}
                </Button>
                {state && !state.installed && state.status === "stopped" && (
                  <InfoTip>{m.db.firstStartInfo}</InfoTip>
                )}
              </>
            )}
            <div className="flex-1" />
            <Button size="sm" variant="danger-ghost" onClick={() => setResetting(true)} disabled={working || !state?.initialized}>
              <RotateCcw className="h-3.5 w-3.5" /> {m.db.reset}
            </Button>
          </div>
        )}

        {state?.status === "installing" && (
          <div className="flex flex-col gap-1.5" role="status">
            <div className="text-xs text-muted">{m.db.downloading(Math.round((state.progress ?? 0) * 100))}</div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round((state.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {state?.error && <ErrorBanner title={m.db.startFailed}>{state.error}</ErrorBanner>}

        <ConnectionUrl url={state?.url ?? ""} />
      </div>

      {!isWorktree && (
      <Row label={m.db.port} description={m.db.portDescription}>
        <Input
          key={db.port}
          type="number"
          min={1024}
          max={65535}
          defaultValue={db.port}
          className="w-28 font-mono text-xs"
          aria-label={m.db.portAria}
          onBlur={(e) => {
            const port = Number(e.target.value);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
              e.target.value = String(db.port);
              return toast.error(m.db.invalidPort, m.db.invalidPortHint);
            }
            if (port !== db.port) void saveDb({ port });
          }}
        />
      </Row>
      )}
      <Row label={m.db.name} description={m.db.nameDescription}>
        <Input
          key={db.name}
          defaultValue={db.name}
          className="w-44 font-mono text-xs"
          aria-label={m.db.nameAria}
          onBlur={(e) => {
            const name = e.target.value.trim();
            if (name === db.name) return;
            if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
              e.target.value = db.name;
              return toast.error(m.db.invalidName, m.db.invalidNameHint);
            }
            void saveDb({ name });
          }}
        />
      </Row>
      <Row label={m.db.envVar} description={m.db.envVarDescription}>
        <Input
          key={db.envVar ?? ""}
          defaultValue={db.envVar ?? ""}
          placeholder="DATABASE_URL"
          className="w-44 font-mono text-xs"
          aria-label={m.db.envVarAria}
          onBlur={(e) => {
            const v = e.target.value.trim() || null;
            if (v === db.envVar) return;
            if (v && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
              e.target.value = db.envVar ?? "";
              return toast.error(m.db.invalidEnvVar, m.db.invalidEnvVarHint);
            }
            void saveDb({ envVar: v });
          }}
        />
      </Row>
      <SwitchRow
        label={m.db.withDevServer}
        description={m.db.withDevServerDescription}
        checked={db.withDevServer}
        onChange={(withDevServer) => void saveDb({ withDevServer })}
      />

      <div className="px-4 py-2.5">
        <button onClick={() => setLogOpen(!logOpen)} className="flex items-center gap-1 text-xs text-muted hover:text-fg" aria-expanded={logOpen}>
          {logOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} {m.db.log}
        </button>
        {logOpen && <DbLog dbId={dbId} state={state} />}
      </div>

      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title={m.db.resetTitle}
        description={m.db.resetDescription(db.name)}
        confirmLabel={m.db.resetConfirm}
        danger
        onConfirm={async () => {
          const wasRunning = running;
          try {
            qc.setQueryData(keys.testDb(dbId), await call("testdb.reset", { projectId: dbId }));
          } catch (e) {
            toast.error(m.db.notReset, errorMessage(e));
            throw e;
          }
          if (!wasRunning) {
            toast.success(m.db.resetDone);
            return;
          }
          // The reset is done; a failed start must not ask for another reset.
          try {
            qc.setQueryData(keys.testDb(dbId), await call("testdb.start", { projectId: dbId }));
            toast.success(m.db.resetDone, m.db.runningAgain);
          } catch (e) {
            toast.error(m.db.resetNotRestarted, errorMessage(e));
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
      toast.error(m.db.notCopied, m.db.clipboardUnavailable);
    }
  };
  return (
    <div className="flex items-center gap-2">
      <Database className="h-4 w-4 shrink-0 text-subtle" />
      <Input readOnly value={url} className="min-w-0 flex-1 font-mono text-xs" aria-label={m.db.url} onFocus={(e) => e.target.select()} />
      <Button size="icon-sm" variant="ghost" onClick={() => void copy()} aria-label={m.db.copyUrl} title={m.db.copyUrl}>
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

function DbLog({ dbId, state }: { dbId: string; state: TestDbState | undefined }) {
  const log = useQuery({ queryKey: [...keys.testDb(dbId), "log", state?.status], queryFn: () => call("testdb.log", { projectId: dbId }), staleTime: 0, placeholderData: (prev) => prev });
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log.data]);
  if (log.isLoading)
    return (
      <SkeletonRegion label={m.db.loadingLog} className="mt-2 flex flex-col gap-1.5 rounded-md border border-border bg-bg px-3 py-2">
        {[80, 65, 90, 45].map((w, i) => (
          <div key={i} className="flex h-3.5 items-center">
            <Skeleton className="h-2.5 rounded-sm" style={{ width: `${w}%` }} />
          </div>
        ))}
      </SkeletonRegion>
    );
  return (
    <pre ref={ref} className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-bg px-3 py-2 font-mono text-caption leading-[1.45] text-muted">
      {log.data?.text.trim() || m.db.noLog}
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
      setDraft(cur ? `${cur}\n\n${m.env.importedFrom(name)}\n${content.trimEnd()}\n` : `${content.trimEnd()}\n`);
      toast.info(m.env.imported(name), m.env.importedHint);
    } catch (e) {
      toast.error(m.env.notImported, errorMessage(e));
    }
  };

  return (
    <Group
      title={m.env.title}
      description={ENV_DESCRIPTION}
      action={<Switch checked={config.useEnv} onChange={(useEnv) => void update({ useEnv })} label={m.env.use} />}
    >
      <div className="flex flex-col gap-2 px-4 py-3.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted" title={names.join(", ")}>
            {!config.useEnv ? m.env.off : names.length ? m.env.variables(names.length, names.join(", ")) : m.env.none}
          </span>
          {(files.data?.length ?? 0) > 0 && (
            <DropdownMenu
              header={m.env.fromFileHeader}
              trigger={
                <Button size="sm" variant="ghost">
                  <FileInput className="h-3.5 w-3.5" /> {m.env.fromFile}
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
            ariaLabel={m.env.title}
            onSave={() => draft !== null && saveDraft(draft)}
          />
        </div>
      </div>
    </Group>
  );
}

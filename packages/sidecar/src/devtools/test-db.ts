import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, cp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { ForgeError, type TestDbConfig, type TestDbState } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import { run } from "../util/proc.js";
import { findFreePort, isPortFree } from "../util/ports.js";
import { platformTag, type PlatformTag } from "../util/platform.js";
import { connectionUrl, type DevToolsService } from "./dev-tools.js";

const PG_VERSION = "17.10";
const PG_BUILD = "17.10.0-beta.17";

/**
 * PostgreSQL from the npm packages @embedded-postgres/<platform> (official EDB binaries on Windows,
 * zonky builds elsewhere, repackaged). Pinned with their sha512 from the registry; a new version
 * needs new hashes for every platform.
 */
const PG_PACKAGES: Record<PlatformTag, { pkg: string; integrity: string; size: number }> = {
  "win32-x64": { pkg: "windows-x64", integrity: "sha512-q6xIETTkv67i1QlTWz1LAKb3Z+vG2V3qrp+BjLEWhCQ9jE4hbbsQ/J/3wiOPFLJbuwak7CfHC9EUJG7txAbGKw==", size: 37_794_841 },
  "darwin-arm64": { pkg: "darwin-arm64", integrity: "sha512-E2dxhSllrcyAJBHuvgTrBTx2BaPlX2vvjXClPKHxfwBezk+nTZ01uAEraKiRJMpzHSCyN8J1dTjKh4q/uTsBLQ==", size: 51_141_714 },
  "darwin-x64": { pkg: "darwin-x64", integrity: "sha512-gXk65MIyttD/PWo6NDSmu/n4vzPcqZQmxVWjEKuecwlyGmWO984AZ3Ljb7F0bwPvXhqcovH4FGN4ydr0fGeJxg==", size: 51_141_708 },
  "linux-x64": { pkg: "linux-x64", integrity: "sha512-hU4Sgna19ixDP/l3P/zkHhQ9B0JDV39qA97RNz55QcngeRjFC5/1G36LZjODVJ84kVJHUTQMmly7nzWO8js8kg==", size: 23_500_205 },
};

/** The PostgreSQL package for a platform. */
export function postgresPackage(tag: PlatformTag = platformTag()) {
  const p = PG_PACKAGES[tag];
  return {
    version: PG_VERSION,
    build: PG_BUILD,
    url: `https://registry.npmjs.org/@embedded-postgres/${p.pkg}/-/${p.pkg}-${PG_BUILD}.tgz`,
    integrity: p.integrity,
    size: p.size,
  } as const;
}

export const POSTGRES = postgresPackage();

const EXE = process.platform === "win32" ? ".exe" : "";

export const DB_USER = "forge";
const START_TIMEOUT_S = 60;
const LOG_TAIL = 64_000;
/** Agents' own servers start here, above the ports of the projects (FIRST_DB_PORT on). */
export const FIRST_WORKTREE_DB_PORT = 55330;
/** How often state() asks pg_ctl whether a server marked running still runs. */
const ALIVE_CHECK_MS = 15_000;

type Status = TestDbState["status"];

interface Instance {
  status: Status;
  progress: number | null;
  error: string | null;
  startedAt: string | null;
  /** port and database the running server was started with */
  running: { port: number; name: string } | null;
  /** start, stop and reset of one project run one after another */
  queue: Promise<unknown>;
  /** last time a running server was confirmed alive */
  checkedAt: number;
}

export interface TestDbDeps {
  dataDir: string;
  devTools: DevToolsService;
  emit: (state: TestDbState) => void;
  log?: (m: string) => void;
  /** test hook: where the binaries come from */
  binDir?: string;
  /** test hook: download limits */
  download?: { url?: string; connectMs?: number; stallMs?: number };
  /** test hook: whether a port is free */
  portFree?: (port: number) => Promise<boolean>;
}

/** What seed() did for an agent's database. */
export type SeedResult = "copied" | "exists" | "parent-running" | "none";

function tarExe(): string {
  if (process.platform !== "win32") return "tar";
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const abs = path.join(root, "System32", "tar.exe");
  return existsSync(abs) ? abs : "tar";
}

/**
 * npm packages cannot hold symlinks, so the macOS and Linux packages list the library links in
 * native/pg-symlinks.json (their postinstall script recreates them). Paths there start with native/.
 */
async function hydrateSymlinks(native: string) {
  let links: Array<{ source: string; target: string }> = [];
  try {
    links = JSON.parse(readFileSync(path.join(native, "pg-symlinks.json"), "utf8")) as typeof links;
  } catch {
    return;
  }
  const inside = (p: string) => path.join(native, ...p.split("/").slice(1));
  for (const { source, target } of links) {
    const to = inside(target);
    await rm(to, { force: true });
    await symlink(path.relative(path.dirname(to), inside(source)), to).catch(() => {});
  }
  for (const name of await readdir(path.join(native, "bin")).catch(() => [] as string[])) await chmod(path.join(native, "bin", name), 0o755).catch(() => {});
}

/** Last lines of PostgreSQL's log that explain a failed start ("FATAL", "could not bind" ...). */
export function failureReason(log: string): string | null {
  const lines = log.split(/\r?\n/).filter((l) => /\b(FATAL|ERROR|PANIC|could not|konnte nicht)\b/i.test(l));
  const last = lines.at(-1);
  return last ? last.replace(/^.*?(FATAL|ERROR|PANIC|LOG):\s*/i, "").trim() : null;
}

/** Port a running server was started with: line 4 of postmaster.pid. */
function pidFilePort(data: string): number | null {
  try {
    const port = Number(readFileSync(path.join(data, "postmaster.pid"), "utf8").split(/\r?\n/)[3]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Local PostgreSQL per project for tests and the dev server. Runs from binaries downloaded once into
 * FORGE's data folder; each project gets its own data folder and port, reachable only on 127.0.0.1.
 * pg_ctl keeps the server in the desktop shell's job object, so it ends with FORGE.
 *
 * Worktrees (parallel agents) get their own server too, with the settings of their project but
 * their own data folder and a port of their own: an agent's migrations and test data never reach
 * the project's database. seed() starts it as a copy of the project's data.
 */
export class TestDbService {
  private readonly instances = new Map<string, Instance>();
  private installing: Promise<void> | null = null;
  /** progress callbacks of every project waiting for the shared download */
  private readonly installWatchers = new Set<(p: number) => void>();
  private closed = false;
  private readonly binDir: string;
  /** ports of the agents' servers; projects keep theirs in the dev tools settings */
  private readonly ports = new Map<string, number>();

  constructor(private readonly d: TestDbDeps) {
    this.binDir = d.binDir ?? path.join(d.dataDir, "postgres", POSTGRES.build, "bin");
  }

  private instance(key: string): Instance {
    let i = this.instances.get(key);
    if (!i) {
      i = { status: "stopped", progress: null, error: null, startedAt: null, running: null, queue: Promise.resolve(), checkedAt: 0 };
      this.instances.set(key, i);
    }
    return i;
  }

  private folder(key: string) {
    const base = path.join(this.d.dataDir, "testdb", key);
    return { base, data: path.join(base, "data"), log: path.join(base, "server.log"), created: path.join(base, "databases.json") };
  }

  private isWorktree(key: string): boolean {
    return this.d.devTools.owner(key) !== key;
  }

  /** Settings of the project; an agent's server has its own port. */
  private config(key: string): TestDbConfig {
    const cfg = this.d.devTools.get(key).database;
    const port = this.ports.get(key);
    return port !== undefined && this.isWorktree(key) ? { ...cfg, port } : cfg;
  }

  /** Only inside a queued job: a free port for an agent's server, the one it had if still free. */
  private async reservePort(key: string) {
    const free = this.d.portFree ?? isPortFree;
    const cur = this.ports.get(key);
    if (cur !== undefined && (await free(cur))) return;
    const taken = [...this.d.devTools.ports(), ...[...this.ports].filter(([k]) => k !== key).map(([, p]) => p)];
    this.ports.set(key, await findFreePort(FIRST_WORKTREE_DB_PORT, taken, free));
  }

  private bin(name: string) {
    return path.join(this.binDir, `${name}${EXE}`);
  }

  get installed(): boolean {
    return existsSync(this.bin("pg_ctl")) && existsSync(this.bin("postgres")) && existsSync(this.bin("initdb"));
  }

  state(projectId: string): TestDbState {
    const key = projectId;
    const i = this.instance(key);
    const cfg = this.config(key);
    if (i.status === "running" && Date.now() - i.checkedAt > ALIVE_CHECK_MS) this.checkAlive(key);
    return {
      projectId: key,
      status: i.status,
      progress: i.progress,
      version: POSTGRES.version,
      installed: this.installed,
      initialized: existsSync(path.join(this.folder(key).data, "PG_VERSION")),
      url: connectionUrl(i.running && i.status === "running" ? { ...cfg, ...i.running } : cfg),
      startedAt: i.startedAt,
      error: i.error,
    };
  }

  isRunning(projectId: string): boolean {
    return this.instance(projectId).status === "running";
  }

  /** URL of the running server, null when it is not running. */
  runningUrl(projectId: string): string | null {
    return this.isRunning(projectId) ? this.state(projectId).url : null;
  }

  log(projectId: string): string {
    const file = this.folder(projectId).log;
    try {
      const text = readFileSync(file, "utf8");
      return text.length > LOG_TAIL ? text.slice(-LOG_TAIL) : text;
    } catch {
      return "";
    }
  }

  private set(key: string, patch: Partial<Instance>) {
    Object.assign(this.instance(key), patch);
    this.d.emit(this.state(key));
  }

  private enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const i = this.instance(key);
    const next = i.queue.then(job, job);
    i.queue = next.catch(() => {});
    return next;
  }

  /** A server can end without FORGE (crash, killed by hand): the status follows it. */
  private checkAlive(key: string) {
    const i = this.instance(key);
    i.checkedAt = Date.now();
    void this.enqueue(key, async () => {
      if (i.status !== "running") return;
      if (await this.serverAlive(this.folder(key).data)) {
        i.checkedAt = Date.now();
        return;
      }
      this.d.log?.(`Test-Datenbank läuft nicht mehr: Projekt ${key}`);
      this.set(key, { status: "stopped", running: null, startedAt: null });
    }).catch(() => {});
  }

  start(projectId: string): Promise<TestDbState> {
    const key = projectId;
    return this.enqueue(key, async () => {
      const i = this.instance(key);
      if (this.closed) throw new ForgeError("INTERNAL", tr().system.testDb.closing);
      const f = this.folder(key);
      if (i.status === "running") {
        if (await this.serverAlive(f.data)) {
          i.checkedAt = Date.now();
          return this.state(key);
        }
        this.d.log?.(`Test-Datenbank läuft nicht mehr, starte neu: Projekt ${key}`);
        this.set(key, { status: "stopped", running: null, startedAt: null });
      }
      try {
        if (!this.installed) {
          this.set(key, { status: "installing", progress: 0, error: null });
          await this.install((p) => {
            if (i.status === "installing" && (i.progress === null || p - i.progress >= 0.02 || p === 1)) this.set(key, { progress: p });
          });
        }
        this.set(key, { status: "starting", progress: null, error: null });
        // A server left behind by a crashed sidecar still holds the data folder: take it over.
        if (await this.serverAlive(f.data)) {
          const port = pidFilePort(f.data);
          if (port && this.isWorktree(key)) this.ports.set(key, port);
          const cfg = this.config(key);
          this.set(key, { status: "running", startedAt: new Date().toISOString(), running: { port: cfg.port, name: cfg.name }, checkedAt: Date.now() });
          return this.state(key);
        }
        if (this.isWorktree(key)) await this.reservePort(key);
        const cfg = this.config(key);
        if (!existsSync(path.join(f.data, "PG_VERSION"))) await this.initCluster(f, cfg.password);
        await this.ensureDatabase(f, cfg.name);
        // No Unix socket: its default folder may not exist or be writable, and TCP on 127.0.0.1 is enough.
        const socket = process.platform === "win32" ? "" : " -k ''";
        const r = await run(this.bin("pg_ctl"), ["start", "-D", f.data, "-l", f.log, "-w", "-t", String(START_TIMEOUT_S), "-o", `-p ${cfg.port} -h 127.0.0.1${socket}`], {
          timeoutMs: (START_TIMEOUT_S + 15) * 1000,
        });
        if (r.code !== 0) {
          const reason = failureReason(this.log(key)) ?? (r.stderr.trim() || r.stdout.trim() || tr().system.testDb.pgCtlExited(r.code ?? "?"));
          throw new Error(/could not bind|address already in use|Adresse wird bereits/i.test(reason) ? tr().system.testDb.portBusy(cfg.port) : reason);
        }
        this.set(key, { status: "running", startedAt: new Date().toISOString(), running: { port: cfg.port, name: cfg.name }, checkedAt: Date.now() });
        this.d.log?.(`Test-Datenbank gestartet: Projekt ${key}, Port ${cfg.port}`);
        return this.state(key);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.set(key, { status: "failed", progress: null, error: message, running: null });
        throw new ForgeError("INTERNAL", tr().system.testDb.notStarted(message));
      }
    });
  }

  stop(projectId: string): Promise<TestDbState> {
    const key = projectId;
    return this.enqueue(key, async () => {
      await this.stopNow(key);
      return this.state(key);
    });
  }

  /** Only inside a queued job. */
  private async stopNow(key: string) {
    const f = this.folder(key);
    if (!existsSync(path.join(f.data, "PG_VERSION")) || !this.installed) {
      this.set(key, { status: "stopped", running: null, startedAt: null });
      return;
    }
    this.set(key, { status: "stopping", error: null });
    await run(this.bin("pg_ctl"), ["stop", "-D", f.data, "-m", "fast", "-w", "-t", "30"], { timeoutMs: 45_000 });
    if (await this.serverAlive(f.data)) {
      await run(this.bin("pg_ctl"), ["stop", "-D", f.data, "-m", "immediate", "-w", "-t", "15"], { timeoutMs: 25_000 });
    }
    this.set(key, { status: "stopped", running: null, startedAt: null });
  }

  /**
   * Stops the server and deletes its data; the next start creates an empty database. One job, so no
   * start can slip in between stop and delete.
   */
  reset(projectId: string): Promise<TestDbState> {
    const key = projectId;
    return this.enqueue(key, async () => {
      await this.stopNow(key);
      await rm(this.folder(key).base, { recursive: true, force: true });
      this.set(key, { status: "stopped", error: null, startedAt: null, running: null });
      return this.state(key);
    });
  }

  /** The project was removed from FORGE: stop its server and delete its data. */
  async forget(projectId: string) {
    const key = projectId;
    if (!existsSync(this.folder(key).base)) return;
    await this.enqueue(key, async () => {
      await this.stopNow(key).catch(() => {});
      await rm(this.folder(key).base, { recursive: true, force: true }).catch(() => {});
    });
    this.instances.delete(key);
    this.ports.delete(key);
  }

  /**
   * An agent's database starts as a copy of its project's data: same tables, same test data. Copied
   * as files, which is only consistent while the project's server is stopped; while it runs the
   * agent's first start creates an empty database instead. Queued on the project, so the project's
   * server cannot start in the middle of the copy.
   */
  async seed(projectId: string): Promise<SeedResult> {
    const owner = this.d.devTools.owner(projectId);
    if (owner === projectId) return "none";
    const src = this.folder(owner);
    const dst = this.folder(projectId);
    if (existsSync(path.join(dst.data, "PG_VERSION"))) return "exists";
    if (!existsSync(path.join(src.data, "PG_VERSION"))) return "none";
    return this.enqueue(owner, async () => {
      if (await this.serverAlive(src.data)) return "parent-running";
      await rm(dst.base, { recursive: true, force: true });
      await mkdir(dst.base, { recursive: true });
      // postmaster.pid would make the copy look like a running server.
      await cp(src.data, dst.data, { recursive: true, filter: (from) => path.basename(from) !== "postmaster.pid" });
      if (existsSync(src.created)) await copyFile(src.created, dst.created);
      this.d.log?.(`Test-Datenbank für Agenten kopiert: Projekt ${projectId}`);
      return "copied";
    });
  }

  /**
   * On exit, started while the sessions drain: the desktop shell ends the sidecar after a few
   * seconds, and pg_ctl's fast shutdown spares the next start a recovery.
   */
  async stopAll() {
    this.closed = true;
    await Promise.allSettled(
      [...this.instances].map(async ([key, i]) => {
        if (i.status !== "running" && i.status !== "starting") return;
        const data = this.folder(key).data;
        await run(this.bin("pg_ctl"), ["stop", "-D", data, "-m", "fast", "-w", "-t", "4"], { timeoutMs: 5_000 });
        if (!(await this.serverAlive(data))) Object.assign(i, { status: "stopped", running: null, startedAt: null });
      }),
    );
  }

  /** Last resort on exit for servers stopAll did not get down in time. */
  shutdown() {
    this.closed = true;
    for (const [key, i] of this.instances) {
      if (i.status !== "running" && i.status !== "starting") continue;
      spawnSync(this.bin("pg_ctl"), ["stop", "-D", this.folder(key).data, "-m", "fast", "-w", "-t", "10"], { windowsHide: true, stdio: "ignore", timeout: 12_000 });
    }
  }

  private async serverAlive(data: string): Promise<boolean> {
    if (!existsSync(path.join(data, "postmaster.pid"))) return false;
    const r = await run(this.bin("pg_ctl"), ["status", "-D", data], { timeoutMs: 15_000 });
    return r.code === 0;
  }

  private async initCluster(f: ReturnType<TestDbService["folder"]>, password: string) {
    // initdb and postgres refuse to run as root on macOS and Linux.
    if (process.getuid?.() === 0) throw new Error(tr().system.testDb.asRoot);
    await rm(f.data, { recursive: true, force: true });
    await mkdir(f.base, { recursive: true });
    const pwfile = path.join(f.base, "pw.tmp");
    await writeFile(pwfile, password, "utf8");
    try {
      const r = await run(
        this.bin("initdb"),
        ["-D", f.data, "-U", DB_USER, `--pwfile=${pwfile}`, "-A", "scram-sha-256", "-E", "UTF8", "--locale=C", "--no-instructions"],
        { timeoutMs: 120_000 },
      );
      if (r.code !== 0) throw new Error(`initdb: ${(r.stderr || r.stdout).trim().split(/\r?\n/).at(-1) ?? tr().system.testDb.exitCode(r.code ?? "?")}`);
    } finally {
      await rm(pwfile, { force: true });
    }
    await rm(f.created, { force: true });
  }

  /**
   * Creates the database in single-user mode while the server is stopped: FORGE needs no client
   * library for it. Remembered in databases.json, so a renamed database is created on the next start.
   */
  private async ensureDatabase(f: ReturnType<TestDbService["folder"]>, name: string) {
    let created: string[] = [];
    try {
      created = JSON.parse(readFileSync(f.created, "utf8")) as string[];
    } catch {
      /* first start */
    }
    if (created.includes(name) || name === "postgres") return;
    const r = await run(this.bin("postgres"), ["--single", "-D", f.data, "-F", "postgres"], {
      input: `SELECT 1 FROM pg_database WHERE datname = '${name}'\n`,
      timeoutMs: 60_000,
    });
    const exists = /\?column\?\s*=\s*"1"/.test(r.stdout);
    if (!exists) {
      const c = await run(this.bin("postgres"), ["--single", "-D", f.data, "-F", "postgres"], { input: `CREATE DATABASE "${name}"\n`, timeoutMs: 60_000 });
      if (c.code !== 0 || /\bERROR\b|FEHLER/.test(c.stderr + c.stdout)) {
        throw new Error(tr().system.testDb.createFailed(name, (c.stderr || c.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? tr().system.testDb.exitCode(c.code ?? "?")));
      }
    }
    writeFileSync(f.created, JSON.stringify([...created, name]));
  }

  /** Downloads and unpacks the binaries once; parallel starts of several projects share one download. */
  private install(onProgress: (p: number) => void): Promise<void> {
    this.installWatchers.add(onProgress);
    this.installing ??= this.download((p) => {
      for (const w of this.installWatchers) w(p);
    }).finally(() => (this.installing = null));
    return this.installing.finally(() => this.installWatchers.delete(onProgress));
  }

  private async download(progress: (p: number) => void) {
    const root = path.dirname(this.binDir);
    const parent = path.dirname(root);
    await mkdir(parent, { recursive: true });
    const tgz = path.join(parent, `postgres-${POSTGRES.build}.tgz`);
    const tmp = path.join(parent, `extract-${process.pid}`);
    const connectMs = this.d.download?.connectMs ?? 30_000;
    const stallMs = this.d.download?.stallMs ?? 30_000;
    const abort = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      this.d.log?.(`Test-Datenbank: lade PostgreSQL ${POSTGRES.version}`);
      // Without limits a dead connection would hold the queue of every waiting project forever.
      watchdog = setTimeout(() => abort.abort(new Error(tr().system.testDb.serverSilent)), connectMs);
      let res: Response;
      try {
        res = await fetch(this.d.download?.url ?? POSTGRES.url, { signal: abort.signal });
      } catch (e) {
        throw abort.signal.aborted ? (abort.signal.reason as Error) : new Error(tr().system.testDb.downloadFailed(e instanceof Error ? e.message : String(e)));
      }
      clearTimeout(watchdog);
      if (!res.ok || !res.body) throw new Error(tr().system.testDb.downloadHttp(res.status));
      const total = Number(res.headers.get("content-length")) || POSTGRES.size;
      const hash = createHash("sha512");
      let got = 0;
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      const stalled = () => {
        const err = new Error(tr().system.testDb.stalled(Math.round(stallMs / 1000)));
        abort.abort(err);
        body.destroy(err);
      };
      watchdog = setTimeout(stalled, stallMs);
      body.on("data", (chunk: Buffer) => {
        clearTimeout(watchdog);
        watchdog = setTimeout(stalled, stallMs);
        hash.update(chunk);
        got += chunk.length;
        progress(Math.min(0.99, got / total));
      });
      try {
        await pipeline(body, createWriteStream(tgz));
      } catch (e) {
        throw abort.signal.aborted ? (abort.signal.reason as Error) : e;
      } finally {
        clearTimeout(watchdog);
      }
      if (`sha512-${hash.digest("base64")}` !== POSTGRES.integrity) throw new Error(tr().system.testDb.checksum);
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      const x = await run(tarExe(), ["-xzf", tgz, "-C", tmp], { timeoutMs: 300_000 });
      if (x.code !== 0) throw new Error(tr().system.testDb.unpackFailed(x.stderr.trim() || tr().system.testDb.exitCode(x.code ?? "?")));
      const native = path.join(tmp, "package", "native");
      if (!existsSync(path.join(native, "bin", `pg_ctl${EXE}`))) throw new Error(tr().system.testDb.noPgCtl(`pg_ctl${EXE}`));
      if (process.platform !== "win32") await hydrateSymlinks(native);
      await rm(root, { recursive: true, force: true });
      await rename(native, root);
      progress(1);
    } finally {
      clearTimeout(watchdog);
      await rm(tgz, { force: true }).catch(() => {});
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      await this.dropOldBuilds(parent).catch(() => {});
    }
  }

  /** Older PostgreSQL builds from earlier FORGE versions. */
  private async dropOldBuilds(parent: string) {
    for (const name of await readdir(parent)) {
      if (name !== POSTGRES.build && /^\d+\.\d+\.\d+/.test(name)) await rm(path.join(parent, name), { recursive: true, force: true });
    }
  }
}

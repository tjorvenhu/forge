import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { ForgeError, type TestDbState } from "@forge/protocol";
import { run } from "../util/proc.js";
import { connectionUrl, type DevToolsService } from "./dev-tools.js";

/**
 * PostgreSQL for Windows x64 from the npm package @embedded-postgres/windows-x64 (official EDB
 * binaries, repackaged). Pinned with its sha512 from the registry; a new version needs a new hash.
 */
export const POSTGRES = {
  version: "17.10",
  build: "17.10.0-beta.17",
  url: "https://registry.npmjs.org/@embedded-postgres/windows-x64/-/windows-x64-17.10.0-beta.17.tgz",
  integrity: "sha512-q6xIETTkv67i1QlTWz1LAKb3Z+vG2V3qrp+BjLEWhCQ9jE4hbbsQ/J/3wiOPFLJbuwak7CfHC9EUJG7txAbGKw==",
  size: 37_794_841,
} as const;

export const DB_USER = "forge";
const START_TIMEOUT_S = 60;
const LOG_TAIL = 64_000;

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
}

export interface TestDbDeps {
  dataDir: string;
  devTools: DevToolsService;
  emit: (state: TestDbState) => void;
  log?: (m: string) => void;
  /** test hook: where the binaries come from */
  binDir?: string;
}

function tarExe(): string {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const abs = path.join(root, "System32", "tar.exe");
  return existsSync(abs) ? abs : "tar";
}

/** Last lines of PostgreSQL's log that explain a failed start ("FATAL", "could not bind" ...). */
export function failureReason(log: string): string | null {
  const lines = log.split(/\r?\n/).filter((l) => /\b(FATAL|ERROR|PANIC|could not|konnte nicht)\b/i.test(l));
  const last = lines.at(-1);
  return last ? last.replace(/^.*?(FATAL|ERROR|PANIC|LOG):\s*/i, "").trim() : null;
}

/**
 * Local PostgreSQL per project for tests and the dev server. Runs from binaries downloaded once into
 * FORGE's data folder; each project gets its own data folder and port, reachable only on 127.0.0.1.
 * pg_ctl keeps the server in the desktop shell's job object, so it ends with FORGE.
 */
export class TestDbService {
  private readonly instances = new Map<string, Instance>();
  private installing: Promise<void> | null = null;
  private readonly binDir: string;

  constructor(private readonly d: TestDbDeps) {
    this.binDir = d.binDir ?? path.join(d.dataDir, "postgres", POSTGRES.build, "bin");
  }

  private instance(owner: string): Instance {
    let i = this.instances.get(owner);
    if (!i) {
      i = { status: "stopped", progress: null, error: null, startedAt: null, running: null, queue: Promise.resolve() };
      this.instances.set(owner, i);
    }
    return i;
  }

  private folder(owner: string) {
    const base = path.join(this.d.dataDir, "testdb", owner);
    return { base, data: path.join(base, "data"), log: path.join(base, "server.log"), created: path.join(base, "databases.json") };
  }

  private bin(name: string) {
    return path.join(this.binDir, `${name}.exe`);
  }

  get installed(): boolean {
    return existsSync(this.bin("pg_ctl")) && existsSync(this.bin("postgres")) && existsSync(this.bin("initdb"));
  }

  state(projectId: string): TestDbState {
    const owner = this.d.devTools.owner(projectId);
    const i = this.instance(owner);
    const cfg = this.d.devTools.get(owner).database;
    return {
      projectId: owner,
      status: i.status,
      progress: i.progress,
      version: POSTGRES.version,
      installed: this.installed,
      initialized: existsSync(path.join(this.folder(owner).data, "PG_VERSION")),
      url: connectionUrl(i.running && i.status === "running" ? { ...cfg, ...i.running } : cfg),
      startedAt: i.startedAt,
      error: i.error,
    };
  }

  isRunning(projectId: string): boolean {
    return this.instance(this.d.devTools.owner(projectId)).status === "running";
  }

  /** URL of the running server, null when it is not running. */
  runningUrl(projectId: string): string | null {
    return this.isRunning(projectId) ? this.state(projectId).url : null;
  }

  log(projectId: string): string {
    const file = this.folder(this.d.devTools.owner(projectId)).log;
    try {
      const text = readFileSync(file, "utf8");
      return text.length > LOG_TAIL ? text.slice(-LOG_TAIL) : text;
    } catch {
      return "";
    }
  }

  private set(owner: string, patch: Partial<Instance>) {
    Object.assign(this.instance(owner), patch);
    this.d.emit(this.state(owner));
  }

  private enqueue<T>(owner: string, job: () => Promise<T>): Promise<T> {
    const i = this.instance(owner);
    const next = i.queue.then(job, job);
    i.queue = next.catch(() => {});
    return next;
  }

  start(projectId: string): Promise<TestDbState> {
    const owner = this.d.devTools.owner(projectId);
    return this.enqueue(owner, async () => {
      const i = this.instance(owner);
      if (i.status === "running") return this.state(owner);
      try {
        if (!this.installed) {
          this.set(owner, { status: "installing", progress: 0, error: null });
          await this.install((p) => {
            if (i.status === "installing" && (i.progress === null || p - i.progress >= 0.02 || p === 1)) this.set(owner, { progress: p });
          });
        }
        this.set(owner, { status: "starting", progress: null, error: null });
        const cfg = this.d.devTools.get(owner).database;
        const f = this.folder(owner);
        // A server left behind by a crashed sidecar still holds the data folder: take it over.
        if (await this.serverAlive(f.data)) {
          this.set(owner, { status: "running", startedAt: new Date().toISOString(), running: { port: cfg.port, name: cfg.name } });
          return this.state(owner);
        }
        if (!existsSync(path.join(f.data, "PG_VERSION"))) await this.initCluster(f, cfg.password);
        await this.ensureDatabase(f, cfg.name);
        const r = await run(this.bin("pg_ctl"), ["start", "-D", f.data, "-l", f.log, "-w", "-t", String(START_TIMEOUT_S), "-o", `-p ${cfg.port} -h 127.0.0.1`], {
          timeoutMs: (START_TIMEOUT_S + 15) * 1000,
        });
        if (r.code !== 0) {
          const reason = failureReason(this.log(owner)) ?? (r.stderr.trim() || r.stdout.trim() || `pg_ctl beendet mit Code ${r.code ?? "?"}`);
          throw new Error(/could not bind|address already in use|Adresse wird bereits/i.test(reason) ? `Port ${cfg.port} ist belegt. Wähle einen anderen Port.` : reason);
        }
        this.set(owner, { status: "running", startedAt: new Date().toISOString(), running: { port: cfg.port, name: cfg.name } });
        this.d.log?.(`Test-Datenbank gestartet: Projekt ${owner}, Port ${cfg.port}`);
        return this.state(owner);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.set(owner, { status: "failed", progress: null, error: message, running: null });
        throw new ForgeError("INTERNAL", `Test-Datenbank nicht gestartet: ${message}`);
      }
    });
  }

  stop(projectId: string): Promise<TestDbState> {
    const owner = this.d.devTools.owner(projectId);
    return this.enqueue(owner, async () => {
      const f = this.folder(owner);
      if (!existsSync(path.join(f.data, "PG_VERSION")) || !this.installed) {
        this.set(owner, { status: "stopped", running: null, startedAt: null });
        return this.state(owner);
      }
      this.set(owner, { status: "stopping", error: null });
      await run(this.bin("pg_ctl"), ["stop", "-D", f.data, "-m", "fast", "-w", "-t", "30"], { timeoutMs: 45_000 });
      if (await this.serverAlive(f.data)) {
        await run(this.bin("pg_ctl"), ["stop", "-D", f.data, "-m", "immediate", "-w", "-t", "15"], { timeoutMs: 25_000 });
      }
      this.set(owner, { status: "stopped", running: null, startedAt: null });
      return this.state(owner);
    });
  }

  /** Stops the server and deletes its data; the next start creates an empty database. */
  async reset(projectId: string): Promise<TestDbState> {
    const owner = this.d.devTools.owner(projectId);
    await this.stop(owner);
    return this.enqueue(owner, async () => {
      await rm(this.folder(owner).base, { recursive: true, force: true });
      this.set(owner, { status: "stopped", error: null, startedAt: null, running: null });
      return this.state(owner);
    });
  }

  /** The project was removed from FORGE: stop its server and delete its data. */
  async forget(projectId: string) {
    const owner = projectId;
    if (!existsSync(this.folder(owner).base)) return;
    await this.stop(owner).catch(() => null);
    await rm(this.folder(owner).base, { recursive: true, force: true }).catch(() => {});
    this.instances.delete(owner);
  }

  /** On exit: every running server goes down cleanly (fast shutdown, no recovery on the next start). */
  shutdown() {
    for (const [owner, i] of this.instances) {
      if (i.status !== "running" && i.status !== "starting") continue;
      spawnSync(this.bin("pg_ctl"), ["stop", "-D", this.folder(owner).data, "-m", "fast", "-w", "-t", "10"], { windowsHide: true, stdio: "ignore", timeout: 12_000 });
    }
  }

  private async serverAlive(data: string): Promise<boolean> {
    if (!existsSync(path.join(data, "postmaster.pid"))) return false;
    const r = await run(this.bin("pg_ctl"), ["status", "-D", data], { timeoutMs: 15_000 });
    return r.code === 0;
  }

  private async initCluster(f: ReturnType<TestDbService["folder"]>, password: string) {
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
      if (r.code !== 0) throw new Error(`initdb: ${(r.stderr || r.stdout).trim().split(/\r?\n/).at(-1) ?? `Code ${r.code ?? "?"}`}`);
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
        throw new Error(`Datenbank ${name} nicht angelegt: ${(c.stderr || c.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1) ?? `Code ${c.code ?? "?"}`}`);
      }
    }
    writeFileSync(f.created, JSON.stringify([...created, name]));
  }

  /** Downloads and unpacks the binaries once; parallel starts of several projects share one download. */
  private install(progress: (p: number) => void): Promise<void> {
    this.installing ??= this.download(progress).finally(() => (this.installing = null));
    return this.installing;
  }

  private async download(progress: (p: number) => void) {
    const root = path.dirname(this.binDir);
    const parent = path.dirname(root);
    await mkdir(parent, { recursive: true });
    const tgz = path.join(parent, `postgres-${POSTGRES.build}.tgz`);
    const tmp = path.join(parent, `extract-${process.pid}`);
    try {
      this.d.log?.(`Test-Datenbank: lade PostgreSQL ${POSTGRES.version}`);
      const res = await fetch(POSTGRES.url);
      if (!res.ok || !res.body) throw new Error(`Download von PostgreSQL fehlgeschlagen (HTTP ${res.status}).`);
      const total = Number(res.headers.get("content-length")) || POSTGRES.size;
      const hash = createHash("sha512");
      let got = 0;
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      body.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        got += chunk.length;
        progress(Math.min(0.99, got / total));
      });
      await pipeline(body, createWriteStream(tgz));
      if (`sha512-${hash.digest("base64")}` !== POSTGRES.integrity) throw new Error("Prüfsumme von PostgreSQL stimmt nicht. Download verworfen.");
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      const x = await run(tarExe(), ["-xzf", tgz, "-C", tmp], { timeoutMs: 300_000 });
      if (x.code !== 0) throw new Error(`Entpacken fehlgeschlagen: ${x.stderr.trim() || `Code ${x.code ?? "?"}`}`);
      const native = path.join(tmp, "package", "native");
      if (!existsSync(path.join(native, "bin", "pg_ctl.exe"))) throw new Error("Das PostgreSQL-Paket enthält kein pg_ctl.exe.");
      await rm(root, { recursive: true, force: true });
      await rename(native, root);
      progress(1);
    } finally {
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

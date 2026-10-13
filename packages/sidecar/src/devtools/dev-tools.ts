import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DevToolsConfig, ForgeError, type TestDbConfig } from "@forge/protocol";
import type { Db } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";

/** Away from 5432, where an installed PostgreSQL usually listens. */
export const FIRST_DB_PORT = 54330;
const ENV_FILE_RE = /^\.env(\.[A-Za-z0-9_.-]+)?$/;
const MAX_ENV_FILE = 100_000;
const BOM = String.fromCharCode(0xfeff);

/** Editors on Windows like to start UTF-8 files with a byte order mark. */
export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

/**
 * Reads .env text: KEY=VALUE per line, `export` prefix, comments, single and double quotes (double
 * quotes know \n), values over several lines inside quotes. Later keys win, like dotenv.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const src = stripBom(text).replace(/\r\n?/g, "\n");
  const re = /^[^\S\n]*(?:export[^\S\n]+)?([A-Za-z_][A-Za-z0-9_.-]*)[^\S\n]*=[^\S\n]*('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\n]*)?[^\S\n]*(?:#.*)?$/gm;
  for (const m of src.matchAll(re)) {
    const key = m[1]!;
    let value = (m[2] ?? "").trim();
    const q = value[0];
    if ((q === '"' || q === "'" || q === "`") && value.endsWith(q) && value.length >= 2) {
      value = value.slice(1, -1);
      if (q === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\"/g, '"');
    }
    out[key] = value;
  }
  return out;
}

/** A database name from the project name: "Mein Shop 2" -> "mein_shop_2". */
export function dbNameFor(projectName: string): string {
  const s = projectName
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  if (!s) return "app";
  return /^[0-9]/.test(s) ? `db_${s}` : s;
}

export function connectionUrl(db: TestDbConfig): string {
  return `postgresql://forge:${encodeURIComponent(db.password)}@127.0.0.1:${db.port}/${db.name}`;
}

/**
 * Test environment and test database settings per project. Worktrees (agents) use the settings of
 * their project: one test database per project, not one per agent.
 */
export class DevToolsService {
  constructor(
    private readonly db: Db,
    private readonly projects: ProjectManager,
  ) {}

  owner(projectId: string): string {
    const p = this.projects.get(projectId);
    return p.parentId ?? p.id;
  }

  get(projectId: string): DevToolsConfig {
    const owner = this.owner(projectId);
    const stored = DevToolsConfig.safeParse(this.db.getDevTools(owner));
    if (stored.success) return stored.data;
    // First use (or an unreadable row): port and password are fixed now, so the URL stays the same.
    const project = this.projects.get(owner);
    const config: DevToolsConfig = {
      env: "",
      useEnv: true,
      database: {
        port: this.freePort(owner),
        name: dbNameFor(project.name),
        password: randomBytes(12).toString("hex"),
        withDevServer: false,
        envVar: "DATABASE_URL",
      },
    };
    this.db.setDevTools(owner, config);
    return config;
  }

  update(projectId: string, patch: { env?: string; useEnv?: boolean; database?: Partial<Omit<TestDbConfig, "password">> }): DevToolsConfig {
    const owner = this.owner(projectId);
    const cur = this.get(owner);
    const next: DevToolsConfig = {
      env: patch.env ?? cur.env,
      useEnv: patch.useEnv ?? cur.useEnv,
      database: { ...cur.database, ...patch.database },
    };
    if (next.database.port !== cur.database.port) {
      const taken = this.db.devToolsPorts(owner);
      if (taken.includes(next.database.port)) throw new ForgeError("VALIDATION", `Port ${next.database.port} nutzt schon die Test-Datenbank eines anderen Projekts.`);
    }
    this.db.setDevTools(owner, DevToolsConfig.parse(next));
    return next;
  }

  private freePort(owner: string): number {
    const taken = new Set(this.db.devToolsPorts(owner));
    let port = FIRST_DB_PORT;
    while (taken.has(port)) port++;
    return port;
  }

  /** .env files in the project root that can be taken over into the test environment. */
  async envFiles(projectId: string): Promise<string[]> {
    const dir = this.projects.requireExisting(projectId).path;
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => ENV_FILE_RE.test(n));
    const files: string[] = [];
    for (const n of names) {
      const s = await stat(path.join(dir, n)).catch(() => null);
      if (s?.isFile()) files.push(n);
    }
    // .env.example and friends first: they show which variables exist without real secrets.
    return files.sort((a, b) => Number(!/example|sample|template/i.test(a)) - Number(!/example|sample|template/i.test(b)) || a.localeCompare(b));
  }

  async readEnvFile(projectId: string, name: string): Promise<string> {
    if (!ENV_FILE_RE.test(name) || !(await this.envFiles(projectId)).includes(name)) throw new ForgeError("NOT_FOUND", `Keine Datei ${name} im Projektordner.`);
    const full = path.join(this.projects.requireExisting(projectId).path, name);
    const s = await stat(full);
    if (s.size > MAX_ENV_FILE) throw new ForgeError("VALIDATION", `${name} ist zu groß (über 100 KB).`);
    return readFile(full, "utf8");
  }

  /** Variables of the test environment, or none when it is switched off. */
  testVariables(projectId: string): Record<string, string> {
    const c = this.get(projectId);
    return c.useEnv ? parseDotenv(c.env) : {};
  }
}

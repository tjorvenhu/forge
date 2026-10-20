import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForgeError, type Project, type PromptTemplate, type Settings, type SyncStatus } from "@forge/protocol";
import { DEFAULT_SETTINGS, Db, MIGRATIONS } from "../src/persistence/db.js";
import { open, seal, type SyncKey } from "../src/sync/crypto.js";
import { mergeItems, projectKey, SyncService, type SyncDeps, type SyncRemote } from "../src/sync/sync.js";
import { tempDir } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const PASS = "richtig langes Passwort";

/** GitHub with one account: repositories with one file each and its commits, blob shas checked like the contents API. */
class FakeGitHub implements SyncRemote {
  login: string | null = "me";
  repos = new Map<string, { private: boolean; commits: Array<{ sha: string; text: string; message: string; date: string }> }>();
  writes = 0;
  private seq = 0;
  /** runs once right before the next write is checked: another computer pushing in between */
  beforeWrite: (() => void) | null = null;

  async account() {
    return this.login ? { login: this.login } : null;
  }
  async repoInfo(fullName: string) {
    const r = this.repos.get(fullName);
    return r ? { private: r.private } : null;
  }
  async createPrivateRepo(name: string) {
    this.repos.set(`${this.login}/${name}`, { private: true, commits: [] });
  }
  async readRepoFile(fullName: string, _file: string, ref?: string) {
    const commits = this.repos.get(fullName)?.commits ?? [];
    const c = ref ? commits.find((x) => x.sha === ref) : commits.at(-1);
    return c ? { sha: c.sha, text: c.text } : null;
  }
  async writeRepoFile(fullName: string, _file: string, text: string, sha: string | null, message: string) {
    const hook = this.beforeWrite;
    this.beforeWrite = null;
    hook?.();
    const r = this.repos.get(fullName)!;
    if ((r.commits.at(-1)?.sha ?? null) !== sha) throw new ForgeError("CONFLICT", "Die Datei wurde inzwischen geändert.");
    this.push(r, text, message);
    this.writes++;
  }
  async repoFileHistory(fullName: string) {
    return [...(this.repos.get(fullName)?.commits ?? [])].reverse().map(({ sha, date, message }) => ({ sha, date, message }));
  }
  push(r: { commits: Array<{ sha: string; text: string; message: string; date: string }> }, text: string, message = "von außen") {
    const n = ++this.seq;
    r.commits.push({ sha: `${n.toString(16).padStart(7, "0")}abc`, text, message, date: new Date(Date.UTC(2026, 9, 13, 10, n)).toISOString() });
  }
  text() {
    return this.repos.get("me/forge-data")!.commits.at(-1)!.text;
  }
  /** decrypted items, with the key of a computer that knows the password */
  items(key: SyncKey) {
    const doc = JSON.parse(this.text()) as { box: { iv: string; tag: string; data: string } };
    return JSON.parse(open(key, doc.box)) as Record<string, unknown>;
  }
  /** writes items like another computer would */
  craft(key: SyncKey, change: (items: Record<string, unknown>) => void) {
    const r = this.repos.get("me/forge-data")!;
    const doc = JSON.parse(this.text()) as Record<string, unknown>;
    const items = this.items(key);
    change(items);
    this.push(r, JSON.stringify({ ...doc, box: seal(key, JSON.stringify(items)) }));
  }
}

/** A stored dev tools row as DevToolsService writes it. */
function tools(env: string, db: { port?: number; password?: string } = {}) {
  return { env, useEnv: true, database: { port: db.port ?? 54330, name: "shop", password: db.password ?? "pw-a", withDevServer: false, envVar: "DATABASE_URL" as string | null } };
}

function project(dir: string, patch: Partial<Project> = {}): Project {
  return {
    id: `p-${path.basename(dir)}`,
    name: path.basename(dir),
    path: dir,
    favorite: false,
    tags: [],
    technologies: [],
    profile: "balanced",
    defaultModel: null,
    defaultEffort: null,
    createdAt: "2026-10-01T00:00:00Z",
    lastOpenedAt: null,
    testCommand: null,
    devCommand: null,
    parentId: null,
    gitEnabled: true,
    group: null,
    exists: true,
    ...patch,
  };
}

/** One computer with FORGE: its own settings, projects, phone, secrets, Claude folder and sync state. */
function computer(gh: FakeGitHub, device: string) {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const claudeDir = path.join(t.dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const c = {
    dir: t.dir,
    claudeDir,
    claudeJson: path.join(t.dir, ".claude.json"),
    settings: { ...DEFAULT_SETTINGS, syncEnabled: true, defaultProjectDir: path.join(t.dir, "Projekte") } as Settings,
    projects: [] as Project[],
    remotes: new Map<string, string>(),
    identity: { name: null as string | null, email: null as string | null },
    devTools: new Map<string, unknown>(),
    phone: null as Record<string, unknown> | null,
    phoneApplied: [] as Array<Record<string, unknown>>,
    secrets: new Map<string, string>(),
    templates: [] as PromptTemplate[],
    key: null as SyncKey | null,
    removed: [] as string[],
    backups: 0,
    statuses: [] as SyncStatus[],
    svc: null as unknown as SyncService,
    /** FORGE started again: a new service on the same data folder */
    restart: () => {
      c.svc = new SyncService(deps);
    },
    add(name: string, remote: string | null, patch: Partial<Project> = {}) {
      const p = project(path.join(t.dir, name), patch);
      c.projects.push(p);
      if (remote) c.remotes.set(p.path, remote);
      return p;
    },
  };
  const deps: SyncDeps = {
    stateFile: path.join(t.dir, "data", "sync", "state.json"),
    appVersion: "test",
    remote: gh,
    device,
    claudeDir,
    claudeJson: c.claudeJson,
    kdfN: 1024,
    settings: () => c.settings,
    updateSettings: async (patch) => {
      c.settings = { ...c.settings, ...patch };
    },
    projects: () => c.projects,
    remoteUrl: async (dir) => c.remotes.get(dir) ?? null,
    identity: async () => c.identity,
    setIdentity: async (name, email) => {
      c.identity = { name, email };
    },
    updateProject: async (id, patch) => {
      const p = c.projects.find((x) => x.id === id)!;
      Object.assign(p, patch);
      return p;
    },
    cloneProject: async (url, parentDir) => {
      const p = project(path.join(parentDir, url.split("/").pop()!.replace(/\.git$/, "")));
      c.projects.push(p);
      c.remotes.set(p.path, url);
      return p;
    },
    removeProject: async (id) => {
      c.removed.push(id);
      c.projects = c.projects.filter((p) => p.id !== id);
    },
    devTools: {
      get: (id) => c.devTools.get(id) ?? null,
      // Like DevToolsService.update: port and password of this computer stay.
      update: (id, patch) => {
        const cur = (c.devTools.get(id) as ReturnType<typeof tools> | undefined) ?? tools("", { port: 54400, password: `pw-${device}` });
        c.devTools.set(id, { ...cur, env: patch.env, useEnv: patch.useEnv, database: { ...cur.database, ...patch.database } });
      },
    },
    templates: {
      list: () => c.templates,
      put: (t) => {
        const now = "2026-10-16T00:00:00Z";
        c.templates = [...c.templates.filter((x) => x.id !== t.id), { ...t, createdAt: now, updatedAt: now }];
      },
      remove: (id) => {
        c.templates = c.templates.filter((x) => x.id !== id);
      },
    },
    phone: {
      config: () => c.phone,
      apply: async (cfg) => {
        c.phone = cfg;
        c.phoneApplied.push(cfg);
      },
      secretsChanged: async () => {},
    },
    secrets: {
      names: () => [...c.secrets.keys()],
      get: async (n) => c.secrets.get(n) ?? null,
      set: async (n, v) => void (v ? c.secrets.set(n, v) : c.secrets.delete(n)),
    },
    key: {
      get: async () => c.key,
      set: async (k) => {
        c.key = k;
      },
    },
    safetyBackup: async () => {
      c.backups++;
    },
    emit: (s) => c.statuses.push(s),
    log: () => {},
  };
  c.svc = new SyncService(deps);
  return c;
}

/** A computer that switched sync on and set the password. */
async function joined(gh: FakeGitHub, device: string, setup?: (c: ReturnType<typeof computer>) => void) {
  const c = computer(gh, device);
  setup?.(c);
  await c.svc.setPassphrase(PASS);
  return c;
}

describe("merge of the synced items", () => {
  const never = () => false;
  it("takes the side that changed, the repository when both did, and adds what only one side has", () => {
    const base = { a: 1, b: 1, c: 1 };
    const { result, apply, removed } = mergeItems(base, { a: 2, b: 1, c: 3, n: 1 }, { a: 1, b: 2, c: 4, r: 1 }, never);
    expect(result).toEqual({ a: 2, b: 2, c: 4, n: 1, r: 1 });
    expect(apply).toEqual({ b: 2, c: 4, r: 1 });
    expect(removed).toEqual([]);
  });

  it("tells an item removed here from one that lives on another computer", () => {
    const base = { gone: 1, elsewhere: 1 };
    expect(mergeItems(base, {}, base, (k) => k === "gone").result).toEqual({ elsewhere: 1 });
    expect(mergeItems(base, { gone: 1, elsewhere: 1 }, { elsewhere: 1 }, () => true)).toEqual({ result: { elsewhere: 1 }, apply: {}, removed: ["gone"] });
  });

  it("lets the repository win on the first sync of a computer", () => {
    expect(mergeItems(null, { s: "local", mine: 1 }, { s: "remote" }, never)).toEqual({ result: { s: "remote", mine: 1 }, apply: { s: "remote" }, removed: [] });
    expect(mergeItems(null, { s: "local" }, null, never).result).toEqual({ s: "local" });
  });

  it("compares objects whatever the order of their keys", () => {
    expect(mergeItems({ x: { a: 1, b: 2 } }, { x: { b: 2, a: 1 } }, { x: { a: 1, b: 2 } }, never).apply).toEqual({});
  });

  it("keys projects by remote without credentials, else by folder", () => {
    expect(projectKey("C:\\x\\shop", "https://token123@github.com/Me/Shop.git")).toEqual({ key: "github.com/me/shop", cloneUrl: "https://github.com/Me/Shop.git" });
    expect(projectKey("C:\\x\\shop", "https://user:pw@gitlab.example.com/team/shop.git")).toEqual({
      key: "https://gitlab.example.com/team/shop",
      cloneUrl: "https://gitlab.example.com/team/shop.git",
    });
    expect(projectKey(path.join("x", "Notizen"), null)).toEqual({ key: "folder:notizen", cloneUrl: null });
  });
});

describe("encrypted sync over a private GitHub repository", () => {
  it("encrypts everything and keeps paths of this computer out", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.settings.sounds = false;
      c.settings.claudePath = "C:\\claude.exe";
      c.identity = { name: "Tjorven", email: "t@example.com" };
      c.add("shop", "https://github.com/me/shop.git", { favorite: true, testCommand: "pnpm test" });
      c.devTools.set("p-shop", tools("STRIPE_KEY=sk_test_geheim"));
      c.phone = { server: "pbx.local", username: "30", pinHash: "salt:hash" };
      c.secrets.set("sip-password", "sip-geheim-123");
      writeFileSync(path.join(c.claudeDir, "CLAUDE.md"), "Antworte auf Deutsch.");
      writeFileSync(path.join(c.claudeDir, "settings.json"), '{"env":{"API_KEY":"x"}}');
      writeFileSync(c.claudeJson, JSON.stringify({ mcpServers: { db: { command: "db-mcp", env: { TOKEN: "t0k3n" } } }, other: 1 }));
    });
    expect(a.svc.status()).toMatchObject({ phase: "idle", account: "me", repo: "me/forge-data", hasKey: true, remote: { device: "PC-A" } });
    expect(gh.repos.get("me/forge-data")!.private).toBe(true);
    const text = gh.text();
    for (const plain of ["shop", "pnpm test", "sk_test_geheim", "pbx.local", "sip-geheim-123", "Antworte", "t0k3n", "Tjorven", "sounds"]) expect(text).not.toContain(plain);
    expect(JSON.parse(text)).toMatchObject({ format: "forge-sync", version: 2, device: "PC-A" });

    const items = gh.items(a.key!);
    expect(items).toMatchObject({
      "setting:sounds": false,
      "git:identity": { name: "Tjorven", email: "t@example.com" },
      "project:github.com/me/shop": { name: "shop", favorite: true, testCommand: "pnpm test" },
      "devtools:github.com/me/shop": { env: "STRIPE_KEY=sk_test_geheim" },
      "phone:config": { server: "pbx.local" },
      "secret:sip-password": "sip-geheim-123",
      "claude:CLAUDE.md": "Antworte auf Deutsch.",
      "claude:settings.json": '{"env":{"API_KEY":"x"}}',
      "mcp:db": { command: "db-mcp", env: { TOKEN: "t0k3n" } },
    });
    for (const k of ["setting:claudePath", "setting:defaultProjectDir", "setting:syncEnabled", "setting:setupDone", "setting:syncAsked"]) expect(items).not.toHaveProperty([k]);
    expect(JSON.stringify(items)).not.toContain(a.dir.replace(/\\/g, "\\\\"));
  });

  it("needs the password on the second computer and then brings everything over", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.settings.defaultProfile = "safe";
      c.add("shop", "https://github.com/me/shop.git", { favorite: true });
      c.add("notizen", null);
      c.devTools.set("p-shop", tools("A=1", { port: 54331, password: "pw-a" }));
      c.phone = { server: "pbx.local" };
      c.secrets.set("gemini-key", "AIza-geheim");
      writeFileSync(path.join(c.claudeDir, "settings.json"), '{"hooks":{}}');
      writeFileSync(c.claudeJson, JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
    });
    const b = computer(gh, "PC-B");
    writeFileSync(b.claudeJson, JSON.stringify({ mcpServers: { local: { command: "x" } }, numStartups: 3 }));
    await expect(b.svc.now()).rejects.toThrow(/Sync-Passwort/);
    expect(b.svc.status().phase).toBe("needs-passphrase");
    expect(await b.svc.probe()).toMatchObject({ found: true, device: "PC-A", projects: null });
    await expect(b.svc.setPassphrase("ganz anderes Passwort")).rejects.toThrow(/passt nicht/);
    await expect(b.svc.setPassphrase("kurz")).rejects.toThrow(/mindestens 12/);

    const ownDir = b.settings.defaultProjectDir;
    const st = await b.svc.setPassphrase(PASS);
    expect(st.phase).toBe("idle");
    expect(b.settings.defaultProfile).toBe("safe");
    expect(b.settings.defaultProjectDir).toBe(ownDir);
    expect(b.phoneApplied).toEqual([{ server: "pbx.local" }]);
    expect(b.secrets.get("gemini-key")).toBe("AIza-geheim");
    expect(readFileSync(path.join(b.claudeDir, "settings.json"), "utf8")).toBe('{"hooks":{}}');
    expect(JSON.parse(readFileSync(b.claudeJson, "utf8"))).toEqual({ mcpServers: { local: { command: "x" }, db: { command: "db-mcp" } }, numStartups: 3 });
    expect(st.available.map((p) => p.key)).toEqual(["folder:notizen", "github.com/me/shop"]);

    // Fetching it clones into the folder for new projects and takes over its settings and dev tools.
    const p = await b.svc.cloneProject("github.com/me/shop");
    expect(p).toMatchObject({ name: "shop", favorite: true, path: path.join(ownDir!, "shop") });
    // Port and password belong to the database on this computer.
    expect(b.devTools.get(p.id)).toEqual(tools("A=1", { port: 54400, password: "pw-PC-B" }));
    await b.svc.now();
    expect(b.svc.status().available.map((x) => x.key)).toEqual(["folder:notizen"]);
    expect(Object.keys(gh.items(a.key!)).filter((k) => k.startsWith("mcp:")).sort()).toEqual(["mcp:db", "mcp:local"]);
  });

  it("merges changes from both computers and again when another one pushed in between", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => c.add("shop", "https://github.com/me/shop.git"));
    const b = await joined(gh, "PC-B", (c) => c.add("shop", "https://github.com/me/shop.git"));
    a.settings.sounds = false;
    a.projects[0]!.testCommand = "pnpm test";
    b.settings.enterToSend = false;
    await a.svc.now();
    await b.svc.now();
    await a.svc.now();
    expect(a.settings).toMatchObject({ sounds: false, enterToSend: false });
    expect(b.settings).toMatchObject({ sounds: false, enterToSend: false });
    expect(b.projects[0]!.testCommand).toBe("pnpm test");

    a.settings.updateChecks = false;
    gh.beforeWrite = () => gh.craft(a.key!, (items) => (items["setting:alwaysOnTop"] = true));
    await a.svc.now();
    expect(gh.items(a.key!)).toMatchObject({ "setting:updateChecks": false, "setting:alwaysOnTop": true });
    expect(a.settings.alwaysOnTop).toBe(true);
  });

  it("shows what another computer removed as only local, syncs it again or sets it hard to GitHub", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.add("shop", "https://github.com/me/shop.git");
      c.add("blog", "https://github.com/me/blog.git");
    });
    const b = await joined(gh, "PC-B", (c) => {
      c.add("shop", "https://github.com/me/shop.git");
      c.add("blog", "https://github.com/me/blog.git");
    });

    a.projects = [];
    await a.svc.now();
    await b.svc.now();
    expect(b.projects).toHaveLength(2);
    expect(b.svc.status().localOnly).toEqual([
      { key: "project:github.com/me/blog", kind: "project", label: "Projekt blog", projectId: "p-blog" },
      { key: "project:github.com/me/shop", kind: "project", label: "Projekt shop", projectId: "p-shop" },
    ]);
    // Changes to it here stay here; it does not come back on A.
    b.projects[0]!.favorite = true;
    await b.svc.now();
    expect(gh.items(a.key!)).not.toHaveProperty(["project:github.com/me/shop"]);

    await b.svc.keep("project:github.com/me/shop");
    expect(gh.items(a.key!)).toMatchObject({ "project:github.com/me/shop": { favorite: true } });
    await a.svc.now();
    expect(a.svc.status().available.map((x) => x.key)).toEqual(["github.com/me/shop"]);

    await b.svc.forceLocal("project:github.com/me/blog");
    expect(b.removed).toEqual(["p-blog"]);
    expect(b.backups).toBe(1);
    expect(b.svc.status().localOnly).toEqual([]);
    expect(b.projects.map((p) => p.name)).toEqual(["shop"]);
  });

  it("syncs prompt templates; those of a project come once the project is here", async () => {
    const gh = new FakeGitHub();
    const tpl = (id: string, projectId: string | null, name: string): PromptTemplate => ({
      id,
      projectId,
      name,
      description: null,
      text: `${name} für {datei}`,
      sortOrder: 0,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    });
    const a = await joined(gh, "PC-A", (c) => {
      const shop = c.add("shop", "https://github.com/me/shop.git");
      c.templates = [tpl("t-global", null, "Review"), tpl("t-shop", shop.id, "Shop-Tests")];
    });
    expect(gh.items(a.key!)).toMatchObject({
      "template:t-global": { name: "Review", project: null, text: "Review für {datei}" },
      "template:t-shop": { name: "Shop-Tests", project: "project:github.com/me/shop" },
    });

    const b = await joined(gh, "PC-B");
    expect(b.templates.map((t) => t.id)).toEqual(["t-global"]);
    // Not lost meanwhile, and B does not remove it from GitHub.
    await b.svc.now();
    expect(gh.items(a.key!)).toHaveProperty(["template:t-shop"]);

    await b.svc.cloneProject("github.com/me/shop");
    await b.svc.now();
    expect(b.templates.find((t) => t.id === "t-shop")).toMatchObject({ projectId: b.projects[0]!.id, name: "Shop-Tests" });

    b.templates = b.templates.filter((t) => t.id !== "t-global");
    await b.svc.now();
    await a.svc.now();
    expect(a.svc.status().localOnly).toEqual([{ key: "template:t-global", kind: "template", label: "Vorlage Review", projectId: null }]);
  });

  it("sets the whole computer hard to GitHub and keeps what was only added here", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => c.add("shop", "https://github.com/me/shop.git"));
    const b = await joined(gh, "PC-B", (c) => c.add("shop", "https://github.com/me/shop.git"));
    a.projects = [];
    a.settings.sounds = false;
    await a.svc.now();
    b.settings.desktopNotifications = false;
    b.add("neu", "https://github.com/me/neu.git");
    writeFileSync(path.join(b.claudeDir, "CLAUDE.md"), "nur hier");

    await b.svc.forceLocal();
    expect(b.backups).toBe(1);
    expect(b.settings).toMatchObject({ sounds: false, desktopNotifications: true });
    expect(b.projects.map((p) => p.name)).toEqual(["neu"]);
    expect(b.svc.status().localOnly).toEqual([]);
    // Not on GitHub yet when forced: goes up with the following sync.
    expect(gh.items(a.key!)).toMatchObject({ "project:github.com/me/neu": { name: "neu" }, "claude:CLAUDE.md": "nur hier" });
  });

  it("lists the states on GitHub and brings chosen parts of an older one back", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.settings.sounds = false;
      c.identity = { name: "Alt", email: "alt@example.com" };
    });
    const old = (await a.svc.versions())[0]!;
    expect(old).toMatchObject({ device: "PC-A" });
    a.settings.sounds = true;
    a.identity = { name: "Neu", email: "neu@example.com" };
    await a.svc.now();
    expect((await a.svc.versions()).map((v) => v.sha)).toEqual([expect.any(String), old.sha]);

    const r = await a.svc.restoreVersion(old.sha, ["settings"]);
    expect(r.restored).toEqual(["settings"]);
    expect(a.backups).toBe(1);
    expect(a.settings.sounds).toBe(false);
    expect(a.identity.name).toBe("Neu");
    expect(gh.items(a.key!)["setting:sounds"]).toBe(false);
  });

  it("starts the repository anew with a new password; the other computer needs it then", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => c.add("shop", "https://github.com/me/shop.git"));
    const b = await joined(gh, "PC-B");
    await a.svc.resetRemote("ein neues langes Passwort");
    expect(gh.items(a.key!)).toHaveProperty(["project:github.com/me/shop"]);
    await expect(b.svc.now()).rejects.toThrow(/anderen Sync-Passwort/);
    expect(b.svc.status().phase).toBe("needs-passphrase");
    await b.svc.setPassphrase("ein neues langes Passwort");
    expect(b.svc.status().phase).toBe("idle");
  });

  it("only writes when something changed", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A");
    await a.svc.now();
    await a.svc.now();
    expect(gh.writes).toBe(1);
  });

  it("does not write back and forth once two computers agree", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.add("shop", "https://github.com/me/shop.git");
      c.devTools.set("p-shop", { env: "A=1", useEnv: true });
      c.phone = { number: "+491", desk: { host: "x" } };
      c.secrets.set("sip-password", "geheim");
      c.identity = { name: "A", email: "a@example.com" };
      writeFileSync(path.join(c.claudeDir, "CLAUDE.md"), "regeln\r\n");
      writeFileSync(c.claudeJson, JSON.stringify({ mcpServers: { db: { command: "db" } } }));
    });
    const b = await joined(gh, "PC-B", (c) => c.add("shop", "https://github.com/me/shop.git"));
    await a.svc.now();
    const writes = gh.writes;
    for (let i = 0; i < 3; i++) {
      await b.svc.now();
      await a.svc.now();
    }
    expect(gh.writes).toBe(writes);

    b.settings.sounds = false;
    await b.svc.now();
    await a.svc.now();
    await b.svc.now();
    expect(gh.writes).toBe(writes + 1);
  });

  it("refuses a public repository and needs a GitHub login", async () => {
    const gh = new FakeGitHub();
    gh.repos.set("me/forge-data", { private: false, commits: [] });
    const a = computer(gh, "PC-A");
    await expect(a.svc.setPassphrase(PASS)).rejects.toThrow(/öffentlich/);
    gh.login = null;
    await expect(a.svc.now()).rejects.toThrow(/bei GitHub an/);
    expect(a.svc.status().phase).toBe("no-github");
    a.settings.syncEnabled = false;
    expect(a.svc.status().phase).toBe("off");
    await expect(a.svc.now()).rejects.toThrow(/ist aus/);
  });

  it("writes only Claude files it syncs itself, inside the Claude folder", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A");
    gh.craft(a.key!, (items) =>
      Object.assign(items, {
        "claude:.credentials.json": "{}",
        "claude:../evil.md": "x",
        "claude:agents/../../evil.md": "x",
        "claude:agents/ok.md": "fine",
      }),
    );
    await a.svc.now();
    expect(existsSync(path.join(a.claudeDir, ".credentials.json"))).toBe(false);
    expect(existsSync(path.join(a.dir, "evil.md"))).toBe(false);
    expect(readFileSync(path.join(a.claudeDir, "agents", "ok.md"), "utf8")).toBe("fine");
  });

  it("looks into the repository without changing anything", async () => {
    const gh = new FakeGitHub();
    const b = computer(gh, "PC-B");
    expect(await b.svc.probe()).toMatchObject({ account: "me", repo: "me/forge-data", found: false });
    const a = await joined(gh, "PC-A", (c) => c.add("shop", "https://github.com/me/shop.git"));
    const writes = gh.writes;
    expect(await a.svc.probe()).toMatchObject({ found: true, device: "PC-A", projects: 1 });
    expect(gh.writes).toBe(writes);
  });
});

describe("sync edge cases", () => {
  it("keeps the secrets in the state file sealed and still knows the base after a restart", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.secrets.set("sip-password", "sip-geheim-123");
      c.add("shop", "https://github.com/me/shop.git");
    });
    const stateText = readFileSync(path.join(a.dir, "data", "sync", "state.json"), "utf8");
    expect(stateText).not.toContain("sip-geheim-123");
    expect(stateText).not.toContain("github.com/me/shop\":{");
    a.restart();
    const writes = gh.writes;
    await a.svc.now();
    // Same base as before: nothing to push, no first sync again.
    expect(gh.writes).toBe(writes);
    expect(a.svc.status().localOnly).toEqual([]);
  });

  it("keeps port and password of the test database on each computer", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.add("shop", "https://github.com/me/shop.git");
      c.devTools.set("p-shop", tools("A=1", { port: 54330, password: "pw-a" }));
    });
    const b = await joined(gh, "PC-B", (c) => {
      c.add("shop", "https://github.com/me/shop.git");
      c.devTools.set("p-shop", tools("", { port: 54333, password: "pw-b" }));
    });
    expect(b.devTools.get("p-shop")).toEqual(tools("A=1", { port: 54333, password: "pw-b" }));
    expect(JSON.stringify(gh.items(a.key!))).not.toContain("pw-a");
  });

  it("stops instead of overwriting a .claude.json it cannot read", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A");
    gh.craft(a.key!, (items) => (items["mcp:db"] = { command: "db-mcp" }));
    writeFileSync(a.claudeJson, '{"mcpServers": {"local": ');
    await expect(a.svc.now()).rejects.toThrow(/kein gültiges JSON/);
    expect(readFileSync(a.claudeJson, "utf8")).toBe('{"mcpServers": {"local": ');
    // A BOM from an editor is fine.
    writeFileSync(a.claudeJson, `\uFEFF${JSON.stringify({ mcpServers: { local: { command: "x" } }, keep: 1 })}`);
    await a.svc.now();
    expect(JSON.parse(readFileSync(a.claudeJson, "utf8").replace(/^\uFEFF/, ""))).toEqual({ mcpServers: { local: { command: "x" }, db: { command: "db-mcp" } }, keep: 1 });
  });

  it("does not delete what a newer FORGE wrote and this one does not know", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A");
    gh.craft(a.key!, (items) => {
      items["setting:somethingNew"] = 42;
      items["setting:defaultProfile"] = "superfast";
      items["future:thing"] = { x: 1 };
    });
    a.settings.sounds = false;
    await a.svc.now();
    await a.svc.now();
    expect(gh.items(a.key!)).toMatchObject({ "setting:somethingNew": 42, "setting:defaultProfile": "superfast", "future:thing": { x: 1 }, "setting:sounds": false });
    expect(a.settings.defaultProfile).toBe("autonomous");
    expect(a.svc.status().localOnly).toEqual([]);
  });

  it("does not list a project as only local that was never here", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => c.add("blog", "https://github.com/me/blog.git"));
    const b = await joined(gh, "PC-B");
    expect(b.svc.status().available.map((x) => x.key)).toEqual(["github.com/me/blog"]);
    a.projects = [];
    await a.svc.now();
    await b.svc.now();
    expect(b.svc.status()).toMatchObject({ localOnly: [], available: [] });
  });

  it("treats an unreachable project folder as unchanged, not as removed", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => c.add("shop", "https://github.com/me/shop.git"));
    a.projects[0]!.exists = false;
    a.settings.sounds = false;
    await a.svc.now();
    expect(gh.items(a.key!)).toHaveProperty(["project:github.com/me/shop"]);
    expect(Object.keys(gh.items(a.key!)).filter((k) => k.startsWith("project:"))).toEqual(["project:github.com/me/shop"]);
  });

  it("refuses the hard reset when what would be removed changed since the question", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A", (c) => {
      c.add("shop", "https://github.com/me/shop.git");
      c.add("blog", "https://github.com/me/blog.git");
    });
    const b = await joined(gh, "PC-B", (c) => {
      c.add("shop", "https://github.com/me/shop.git");
      c.add("blog", "https://github.com/me/blog.git");
    });
    a.projects = a.projects.filter((p) => p.name !== "shop");
    await a.svc.now();
    await b.svc.now();
    const told = b.svc.status().localOnly.map((x) => x.key);
    a.projects = [];
    await a.svc.now();
    await expect(b.svc.forceLocal(undefined, told)).rejects.toThrow(/geändert/);
    expect(b.removed).toEqual([]);
    await b.svc.now();
    await b.svc.forceLocal(undefined, b.svc.status().localOnly.map((x) => x.key));
    expect(b.removed.sort()).toEqual(["p-blog", "p-shop"]);
  });

  it("runs a sync of its own when one is asked for during a hard reset", async () => {
    const gh = new FakeGitHub();
    const a = await joined(gh, "PC-A");
    let forced = false;
    const force = a.svc.forceLocal().then(() => (forced = true));
    const st = await a.svc.now();
    // now() waited for the reset and then synced itself, instead of handing back the reset's outcome.
    expect(forced).toBe(true);
    expect(st.phase).toBe("idle");
    await force;
  });
});

describe("setup flag for existing installations", () => {
  it("marks a database that was used before as set up, a new one not", () => {
    const t = tempDir();
    cleanups.push(t.cleanup);
    mkdirSync(t.dir, { recursive: true });
    const fresh = new Db(path.join(t.dir, "fresh.db"));
    expect(fresh.getSettings()).toMatchObject({ setupDone: false, syncEnabled: false, syncAsked: false });
    const migration = MIGRATIONS.find((m) => m.includes("'setupDone'"))!;
    fresh.sql.exec(migration);
    expect(fresh.getSettings().setupDone).toBe(false);
    fresh.setKnownModels(["opus"]);
    fresh.sql.exec(migration);
    expect(fresh.getSettings().setupDone).toBe(false);
    fresh.updateSettings({ sounds: false });
    fresh.sql.exec(migration);
    expect(fresh.getSettings().setupDone).toBe(true);
    fresh.close();
  });
});

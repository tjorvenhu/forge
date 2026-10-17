import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DevServerState, WorktreeSetupState } from "@forge/protocol";
import { GitEngine } from "../src/git/git.js";
import { Db } from "../src/persistence/db.js";
import { ProjectManager } from "../src/projects/project-manager.js";
import { WorktreeService } from "../src/automation/worktrees.js";
import { FIRST_AGENT_DEV_PORT, installPlan, LOCAL_CONFIG, runShell, WorktreeSetup, type ShellRunner, type WorktreeSetupDeps } from "../src/automation/worktree-setup.js";
import { withPortFlag } from "../src/devserver/port-args.js";
import { findFreePort } from "../src/util/ports.js";
import { git, initRepo, tempDir } from "./helpers.js";

const write = (file: string, text = "x\n") => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe("installPlan", () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => (t = tempDir("forge-plan-")));
  afterEach(() => t.cleanup());

  it("installs from the nearest lockfile, as locked", () => {
    const top = path.join(t.dir, "wt");
    write(path.join(top, "pnpm-lock.yaml"));
    write(path.join(top, "apps", "web", "package.json"), "{}");
    expect(installPlan(path.join(top, "apps", "web"), top, null)).toEqual([{ command: "pnpm install --frozen-lockfile --prefer-offline", cwd: top }]);

    const npm = path.join(t.dir, "npm");
    write(path.join(npm, "package-lock.json"));
    expect(installPlan(npm, npm, null)[0]?.command).toBe("npm ci --prefer-offline --no-audit --no-fund");

    const berry = path.join(t.dir, "berry");
    write(path.join(berry, "yarn.lock"));
    write(path.join(berry, ".yarnrc.yml"));
    expect(installPlan(berry, berry, null)[0]?.command).toBe("yarn install --immutable");
  });

  it("sets up Python only where the main folder has a virtual environment, or uv manages one", () => {
    const main = path.join(t.dir, "main");
    const wt = path.join(t.dir, "wt");
    write(path.join(wt, "requirements.txt"));
    expect(installPlan(wt, wt, main)).toEqual([]);
    write(path.join(main, ".venv", "pyvenv.cfg"));
    expect(installPlan(wt, wt, main)[0]?.command).toMatch(/^python -m venv \.venv && \.venv[\\/](Scripts|bin)[\\/]python -m pip install -r requirements\.txt$/);
    write(path.join(wt, "uv.lock"));
    expect(installPlan(wt, wt, main)).toEqual([{ command: "uv sync --frozen", cwd: wt }]);
  });

  it("recognizes local configuration by name", () => {
    for (const f of [".env", "apps/web/.env.local", ".env.development", ".claude/settings.local.json", "docker-compose.local.yml", ".dev.vars", ".npmrc"]) expect(LOCAL_CONFIG.test(f)).toBe(true);
    for (const f of ["src/env.ts", "dist/", "local/readme.md", ".envrc.bak/x"]) expect(LOCAL_CONFIG.test(f)).toBe(false);
  });
});

describe("withPortFlag", () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => (t = tempDir("forge-port-")));
  afterEach(() => t.cleanup());

  it("adds --port where the dev server takes it, through the package manager", async () => {
    write(path.join(t.dir, "package.json"), JSON.stringify({ scripts: { dev: "vite", next: "next dev --turbopack", chain: "pnpm build && vite", api: "node server.js" } }));
    expect(await withPortFlag("pnpm dev", 4100, t.dir)).toBe("pnpm dev --port 4100");
    expect(await withPortFlag("npm run dev", 4100, t.dir)).toBe("npm run dev -- --port 4100");
    expect(await withPortFlag("yarn next", 4100, t.dir)).toBe("yarn next --port 4100");
    expect(await withPortFlag("next dev", 4100, t.dir)).toBe("next dev --port 4100");
    // Several commands or one that reads PORT itself: only the variable.
    expect(await withPortFlag("pnpm chain", 4100, t.dir)).toBeNull();
    expect(await withPortFlag("pnpm api", 4100, t.dir)).toBeNull();
    expect(await withPortFlag("pnpm build && vite", 4100, t.dir)).toBeNull();
  });
});

describe("findFreePort", () => {
  it("skips ports promised to others and taken ones", async () => {
    const busy = new Set([4101, 4103]);
    expect(await findFreePort(4100, [4100], async (p) => !busy.has(p))).toBe(4102);
  });
});

describe("WorktreeSetup", () => {
  let t: ReturnType<typeof tempDir>;
  let db: Db;
  let projects: ProjectManager;
  let repo: string;
  const engine = new GitEngine();

  beforeEach(async () => {
    t = tempDir("forge-setup-");
    repo = path.join(t.dir, "app");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    write(path.join(repo, ".gitignore"), "node_modules/\ndist/\n.env\n.env.*\n*.local.json\nsrc-tauri/target/\nsrc-tauri/runtime/\n");
    write(path.join(repo, "package.json"), JSON.stringify({ name: "app", scripts: { dev: "vite" } }));
    write(path.join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    write(path.join(repo, "packages", "lib", "package.json"), "{}");
    write(path.join(repo, "src-tauri", "Cargo.toml"), "[package]\nname = \"app\"\n");
    write(path.join(repo, "src-tauri", "tauri.conf.json"), JSON.stringify({ bundle: { resources: ["runtime/**/*", "icons/app.png"] } }));
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "init");
    // What git does not bring along:
    write(path.join(repo, ".env"), "SECRET=geheim\n");
    write(path.join(repo, ".claude", "settings.local.json"), "{}");
    write(path.join(repo, "node_modules", "vite", "index.js"));
    write(path.join(repo, "packages", "lib", "dist", "index.js"), "export const lib = 1;\n");
    write(path.join(repo, "src-tauri", "target", "debug", "deps", "libserde.rlib"), "rlib");
    write(path.join(repo, "src-tauri", "target", "debug", "incremental", "app-1", "x"), "big");
    write(path.join(repo, "src-tauri", "runtime", "node.exe"), "node");
    db = new Db(path.join(t.dir, "forge.db"));
    projects = new ProjectManager(db, engine, () => "balanced");
  });
  afterEach(() => {
    db.close();
    t.cleanup();
  });

  function setup(extra: Partial<WorktreeSetupDeps> = {}) {
    const states: WorktreeSetupState[] = [];
    const commands: Array<{ command: string; cwd: string }> = [];
    // Installs are recorded; robocopy (Rust cache on Windows) really runs.
    const shell: ShellRunner = async (command, cwd, env, onKill, opts) => {
      if (opts?.shell === false) return runShell(command, cwd, env, onKill, opts);
      commands.push({ command, cwd });
      return { code: 0, output: "Done" };
    };
    const s = new WorktreeSetup({ git: engine, projects, env: () => ({ ...process.env }) as Record<string, string>, emit: (x) => states.push(x), shell, portFree: async () => true, ...extra });
    const worktrees = new WorktreeService(engine, projects);
    worktrees.useSetup(s);
    return { s, worktrees, states, commands };
  }

  it("prepares a new worktree like the main folder and leaves nothing to commit", async () => {
    const { s, worktrees, states, commands } = setup();
    const parent = await projects.import(repo);
    const wt = await worktrees.create(parent, "agent/komplett");
    const done = await s.wait(wt.id, 30_000);
    expect(done?.status).toBe("done");
    expect(done?.devPort).toBe(FIRST_AGENT_DEV_PORT);
    expect(states[0]?.status).toBe("running");

    expect(readFileSync(path.join(wt.path, ".env"), "utf8")).toBe("SECRET=geheim\n");
    expect(existsSync(path.join(wt.path, ".claude", "settings.local.json"))).toBe(true);
    expect(commands).toEqual([{ command: "pnpm install --frozen-lockfile --prefer-offline", cwd: wt.path }]);
    expect(existsSync(path.join(wt.path, "packages", "lib", "dist", "index.js"))).toBe(true);
    expect(existsSync(path.join(wt.path, "src-tauri", "target", "debug", "deps", "libserde.rlib"))).toBe(true);
    expect(existsSync(path.join(wt.path, "src-tauri", "target", "debug", "incremental"))).toBe(false);
    // A real copy: git worktree remove on Windows follows links and would empty the main folder's.
    const res = path.join(wt.path, "src-tauri", "runtime");
    expect(lstatSync(res).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(res, "node.exe"), "utf8")).toBe("node");
    writeFileSync(path.join(res, "node.exe"), "vom Agenten");
    expect(readFileSync(path.join(repo, "src-tauri", "runtime", "node.exe"), "utf8")).toBe("node");
    // Copies are ignored there too: nothing shows up as a change.
    expect((await engine.status(wt.path)).files).toEqual([]);
    // The detail names files, never their contents.
    expect(JSON.stringify(states)).not.toContain("geheim");
    expect(s.describe(wt.id)).toMatch(/Lokale Konfiguration: fertig, 2 Dateien kopiert/);

    // Removing the worktree removes the link, not what it points to.
    await worktrees.remove(wt, true, { deleteBranch: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(path.join(repo, "src-tauri", "runtime", "node.exe"), "utf8")).toBe("node");
    expect(existsSync(path.join(repo, ".env"))).toBe(true);
    expect(s.state(wt.id)).toBeNull();
  }, 60_000);

  it("reports a failed install without blocking and tells the agent what still runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const shell: ShellRunner = async () => {
      await gate;
      return { code: 1, output: "Progress: resolved 10\nERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n" };
    };
    const { s, worktrees } = setup({ shell });
    const parent = await projects.import(repo);
    const wt = await worktrees.create(parent, "agent/kaputt");
    await new Promise((r) => setTimeout(r, 300));
    expect(s.context(wt.id)).toMatch(/bereitet deinen Worktree gerade vor.*Abhängigkeiten.*wait=true/);
    release();
    const done = await s.wait(wt.id, 30_000);
    expect(done?.status).toBe("failed");
    const deps = done?.steps.find((x) => x.id === "deps");
    expect(deps?.detail).toMatch(/pnpm install --frozen-lockfile --prefer-offline fehlgeschlagen \(Exit-Code 1\): .*ERR_PNPM_OUTDATED_LOCKFILE/);
    expect(s.context(wt.id)).toMatch(/dev_environment/);
    await worktrees.remove(wt, true, { deleteBranch: true });
  }, 60_000);

  it("ends a running install when the worktree goes, so the folder can be deleted", async () => {
    let killed = false;
    let installing = false;
    const shell: ShellRunner = (_c, _cwd, _env, onKill) =>
      new Promise((resolve) => {
        installing = true;
        onKill(() => {
          killed = true;
          resolve({ code: null, output: "" });
        });
      });
    const forgotten: string[] = [];
    const { s, worktrees } = setup({
      shell,
      testDb: { seed: async () => "none", forget: async (id) => void forgotten.push(`db:${id}`) },
      devServers: () => ({ state: async () => stopped("x"), start: async () => stopped("x"), forget: async (id: string) => void forgotten.push(`dev:${id}`) }),
    });
    const parent = await projects.import(repo);
    const wt = await worktrees.create(parent, "agent/weg");
    // Under load the preparation may still be copying configuration; wait for the install itself.
    const deadline = Date.now() + 20_000;
    while (!installing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(s.state(wt.id)?.status).toBe("running");
    await worktrees.remove(wt, true, { deleteBranch: true });
    expect(killed).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(forgotten).toEqual([`dev:${wt.id}`, `db:${wt.id}`]);
  }, 60_000);

  it("starts the agent's dev server only when the project's runs", async () => {
    const started: string[] = [];
    let mainRunning = false;
    const devServers = () => ({
      state: async (id: string) => (id === parentId && mainRunning ? { ...stopped(id), status: "running" as const } : stopped(id)),
      start: async (id: string) => (started.push(id), { ...stopped(id), status: "running" as const }),
      forget: async () => {},
    });
    let parentId = "";
    const { s, worktrees } = setup({ devServers });
    const parent = await projects.import(repo);
    parentId = parent.id;
    const quiet = await worktrees.create(parent, "agent/ruhig");
    expect((await s.wait(quiet.id, 30_000))?.steps.find((x) => x.id === "devserver")).toMatchObject({ status: "skipped", detail: `startet bei Bedarf (Port ${FIRST_AGENT_DEV_PORT})` });
    mainRunning = true;
    const busy = await worktrees.create(parent, "agent/mit-server");
    expect((await s.wait(busy.id, 30_000))?.steps.find((x) => x.id === "devserver")?.status).toBe("done");
    expect(started).toEqual([busy.id]);
    // Each agent its own port.
    expect(await s.devPort(busy.id)).toBe(FIRST_AGENT_DEV_PORT + 1);
    expect(await s.devPort(parent.id)).toBeNull();
    const own = await s.devServerPort(busy.id, "pnpm dev");
    expect(own).toMatchObject({ env: { PORT: String(FIRST_AGENT_DEV_PORT + 1) }, command: `pnpm dev --port ${FIRST_AGENT_DEV_PORT + 1}` });
    await worktrees.remove(quiet, true, { deleteBranch: true });
    await worktrees.remove(busy, true, { deleteBranch: true });
  }, 60_000);
});

function stopped(projectId: string): DevServerState {
  return { projectId, status: "stopped", command: null, url: null, startedAt: null, exitCode: null, error: null, effectiveCommand: "pnpm dev" };
}

import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  EffortLevel,
  ForgeError,
  ProfileId,
  Settings,
  type BackupPart,
  type Project,
  type ServerEvent,
  type SyncAvailableProject,
  type SyncLocalOnly,
  type SyncProbe,
  type SyncStatus,
  type SyncVersion,
} from "@forge/protocol";
import { CLAUDE_DIRS, MAX_FILE_BYTES, TEXT_FILE } from "../backup/backup.js";
import { claudeHome, writeAtomic } from "../config/claude-config.js";
import { githubRepoFromRemote } from "../github/github.js";
import { claudeJsonPath } from "../util/paths.js";
import { deriveKey, KdfParams, newKdf, open, SealedBox, seal, type SyncKey } from "./crypto.js";

export const SYNC_REPO = "forge-data";
export const SYNC_FILE = "forge-sync.json";
const MAX_CLAUDE_BYTES = 5 * 1024 * 1024;
/** after a change in FORGE; several changes in a row become one commit */
const DEBOUNCE_MS = 10_000;
/** picks up what other computers pushed while FORGE runs */
const INTERVAL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const CLAUDE_FILES = ["CLAUDE.md", "settings.json"];

/**
 * Settings that belong to this computer: paths and the setup and sync flags themselves. Every
 * other setting is synced, new ones included.
 */
const LOCAL_SETTINGS = ["claudePath", "defaultProjectDir", "setupDone", "syncEnabled", "syncAsked"] as const satisfies ReadonlyArray<keyof Settings>;
const SYNCED_SETTINGS = Settings.keyof().options.filter((k) => !(LOCAL_SETTINGS as readonly string[]).includes(k));

const ProjectItem = z.object({
  name: z.string(),
  cloneUrl: z.string().nullable(),
  favorite: z.boolean(),
  tags: z.array(z.string()),
  profile: ProfileId,
  defaultModel: z.string().nullable(),
  defaultEffort: EffortLevel.nullable(),
  testCommand: z.string().nullable(),
  devCommand: z.string().nullable(),
  gitEnabled: z.boolean(),
});
type ProjectItem = z.infer<typeof ProjectItem>;
const GitItem = z.object({ name: z.string().min(1), email: z.string().min(1) });

/**
 * The file in the repository: who wrote it in clear, everything else encrypted. The items are flat:
 * "setting:<key>", "git:identity", "project:<remote or folder>", "devtools:<same>", "phone:config",
 * "secret:<name>", "claude:<path below ~/.claude>", "mcp:<server>".
 */
const SyncDoc = z.object({
  format: z.literal("forge-sync"),
  version: z.literal(2),
  updatedAt: z.string(),
  device: z.string(),
  appVersion: z.string(),
  kdf: KdfParams,
  box: SealedBox,
});
type SyncDoc = z.infer<typeof SyncDoc>;
type Items = Record<string, unknown>;
type Kind = SyncLocalOnly["kind"];

/** Which items a part of a backup stands for, when an older state comes back. */
const PART_KINDS: Record<BackupPart, Kind[]> = {
  settings: ["setting"],
  projects: ["project", "devtools"],
  phone: ["phone", "secret"],
  claude: ["claude", "mcp"],
  git: ["git"],
};

const SECRET_LABELS: Record<string, string> = {
  "sip-password": "SIP-Passwort",
  "openai-key": "OpenAI-Key",
  "gemini-key": "Gemini-Key",
  "desk-password": "Passwort des Tischtelefons",
};

/** Kept in the data folder of this computer, never in the repository. */
const SyncState = z.object({
  login: z.string(),
  /** the items as of the last sync: what both sides agreed on */
  base: z.record(z.string(), z.unknown()).nullable(),
  /** items that were on this computer at the last sync; one missing now was removed here */
  localKeys: z.array(z.string()),
  /** removed on another computer but kept here; no longer synced from this one */
  localOnly: z.array(z.string()),
  lastSyncAt: z.string().nullable(),
  remote: z.object({ updatedAt: z.string(), device: z.string() }).nullable(),
});
type SyncState = z.infer<typeof SyncState>;

export interface SyncRemote {
  account(): Promise<{ login: string } | null>;
  repoInfo(fullName: string): Promise<{ private: boolean } | null>;
  createPrivateRepo(name: string, description: string): Promise<void>;
  readRepoFile(fullName: string, file: string, ref?: string): Promise<{ sha: string; text: string } | null>;
  /** throws a ForgeError CONFLICT when the file changed since `sha` */
  writeRepoFile(fullName: string, file: string, text: string, sha: string | null, message: string): Promise<void>;
  repoFileHistory(fullName: string, file: string): Promise<Array<{ sha: string; date: string; message: string }>>;
}

export interface SyncDeps {
  stateFile: string;
  appVersion: string;
  remote: SyncRemote;
  settings(): Settings;
  updateSettings(patch: Partial<Settings>): Promise<unknown>;
  /** projects of this computer without agent worktrees */
  projects(): Project[];
  remoteUrl(dir: string): Promise<string | null>;
  updateProject(id: string, patch: Partial<Omit<ProjectItem, "cloneUrl">>): Promise<Project>;
  cloneProject(url: string, parentDir: string): Promise<Project>;
  /** from FORGE only; the folder stays */
  removeProject(id: string): Promise<void>;
  identity(): Promise<{ name: string | null; email: string | null }>;
  setIdentity(name: string, email: string): Promise<void>;
  devTools: { get(projectId: string): unknown; set(projectId: string, value: unknown): void };
  phone: { config(): Record<string, unknown> | null; apply(config: Record<string, unknown>): Promise<void>; secretsChanged(): Promise<void> };
  secrets: { names(): string[]; get(name: string): Promise<string | null>; set(name: string, value: string | null): Promise<void> };
  /** the key from the sync password, kept encrypted for this Windows user */
  key: { get(): Promise<SyncKey | null>; set(key: SyncKey | null): Promise<void> };
  /** a local backup before FORGE sets things back */
  safetyBackup(): Promise<void>;
  emit(status: SyncStatus): void;
  log(message: string): void;
  device?: string;
  claudeDir?: string;
  claudeJson?: string;
  /** cheaper key derivation in tests */
  kdfN?: number;
}

/** JSON with sorted keys, so equal values compare equal whatever order their keys came in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown) => (a === undefined || b === undefined ? a === b : stable(a) === stable(b));

export function sameItems(a: Items, b: Items): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && same(a[k], b[k]));
}

/**
 * Three-way merge of the items. A side that did not change an item since `base` takes the other
 * side's version; when both changed it, the repository wins (the other computer was first).
 * Without a base (first sync of this computer) the repository wins too, and what only this
 * computer has is added. `wasLocal` tells whether an item missing here was here at the last sync
 * (removed here) or never was (it lives on another computer).
 * `apply`: items to take over here; `removed`: items another computer removed.
 */
export function mergeItems(base: Items | null, local: Items, remote: Items | null, wasLocal: (key: string) => boolean) {
  const result: Items = {};
  const apply: Items = {};
  const removed: string[] = [];
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(local), ...Object.keys(remote ?? {})]);
  for (const k of keys) {
    const b = base?.[k];
    const l = k in local ? local[k] : base && !wasLocal(k) ? b : undefined;
    if (remote === null) {
      if (l !== undefined) result[k] = l;
      continue;
    }
    const r = remote[k];
    let v: unknown;
    if (same(l, r)) v = r;
    else if (base === null) {
      v = r ?? l;
      if (r !== undefined) apply[k] = r;
    } else if (same(r, b)) v = l;
    else if (r !== undefined) {
      v = r;
      apply[k] = r;
    } else if (same(l, b)) removed.push(k);
    else v = l;
    if (v !== undefined) result[k] = v;
  }
  return { result, apply, removed };
}

/** Identity of a project across computers: its remote (without credentials), else its folder name. */
export function projectKey(dir: string, remote: string | null): { key: string; cloneUrl: string | null } {
  const gh = githubRepoFromRemote(remote);
  if (gh) return { key: `github.com/${gh.toLowerCase()}`, cloneUrl: `https://github.com/${gh}.git` };
  const clean = remote?.trim().replace(/^(https?:\/\/)[^@/]+@/i, "$1");
  if (clean) return { key: clean.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, ""), cloneUrl: clean };
  return { key: `folder:${path.basename(dir).toLowerCase()}`, cloneUrl: null };
}

function split(key: string): { kind: Kind; id: string } {
  const sep = key.indexOf(":");
  return { kind: key.slice(0, sep) as Kind, id: key.slice(sep + 1) };
}

/** A project's items: the project itself and its dev tools. */
function withSiblings(key: string): string[] {
  const { kind, id } = split(key);
  return kind === "project" ? [key, `devtools:${id}`] : [key];
}

function parseDoc(text: string): SyncDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = SyncDoc.safeParse(raw);
  if (!parsed.success) throw new ForgeError("VALIDATION", `${SYNC_FILE} im Sync-Repository ist kein FORGE-Stand oder stammt aus einer anderen Version.`);
  return parsed.data;
}

/** The password of this computer does not open the repository (none yet, or changed on another computer). */
class PassphraseNeeded extends Error {}

function decodeItems(doc: SyncDoc, key: SyncKey): Items {
  if (doc.kdf.salt !== key.kdf.salt) throw new PassphraseNeeded("Auf GitHub liegt ein Stand mit einem anderen Sync-Passwort.");
  let text: string;
  try {
    text = open(key, doc.box);
  } catch {
    throw new PassphraseNeeded("Das Sync-Passwort passt nicht zu den Daten auf GitHub.");
  }
  return z.record(z.string(), z.unknown()).parse(JSON.parse(text));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Keeps FORGE's data in a private repository of the signed-in GitHub account, so another computer
 * signed in with the same account gets it: settings (without paths of this computer), projects
 * with their settings and dev tools, the phone with its passwords and keys, the git identity and
 * Claude Code's configuration (CLAUDE.md, settings.json, agents, commands, skills, rules, output
 * styles, MCP servers). Everything but the name of the writing computer is encrypted with a key
 * from the sync password, which never leaves the computers. Not in it: chats, call transcripts and
 * project files. Projects are matched by their remote; one that is not here yet can be cloned.
 * What another computer removed is not deleted here: it is shown as only local until the user
 * syncs it again or sets this computer to the state on GitHub.
 */
export class SyncService {
  private state: SyncState | null;
  private key: SyncKey | null | undefined;
  private needsKey = false;
  private keyProblem: string | null = null;
  private running: Promise<unknown> | null = null;
  private again = false;
  private pendingForce = false;
  private applying = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private phase: "idle" | "syncing" | "error" = "idle";
  private error: string | null = null;
  /** null: not signed in with GitHub at the last run; undefined: not checked yet */
  private account: string | null | undefined;
  private available: SyncAvailableProject[] = [];
  private localOnlyInfo: SyncLocalOnly[] = [];

  constructor(private readonly d: SyncDeps) {
    this.state = this.loadState();
    this.account = this.state?.login;
    if (this.state?.base) this.available = this.availableFrom(this.state.base, this.state.localKeys);
  }

  private get claudeDir() {
    return this.d.claudeDir ?? claudeHome();
  }

  private get claudeJson() {
    return this.d.claudeJson ?? claudeJsonPath();
  }

  private get device() {
    return this.d.device ?? os.hostname();
  }

  private enabled() {
    return this.d.settings().syncEnabled;
  }

  /** Sync on start and every few minutes while switched on. */
  start() {
    this.interval ??= setInterval(() => {
      if (this.enabled()) void this.run(true);
    }, INTERVAL_MS);
    this.interval.unref?.();
    void this.loadKey().then(() => this.emitStatus());
    if (this.enabled()) this.schedule(3_000, true);
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    if (this.timer) clearTimeout(this.timer);
    this.interval = null;
    this.timer = null;
  }

  onServerEvent(e: ServerEvent) {
    if (this.applying || !this.enabled()) return;
    if (e.event === "settings.updated" || e.event === "project.updated") this.schedule(DEBOUNCE_MS, false);
    if (e.event === "github.login" && e.payload.phase === "done") this.schedule(0, true);
  }

  /** The setting syncEnabled changed. */
  enabledChanged() {
    if (this.enabled()) this.schedule(0, true);
    else this.emitStatus();
  }

  status(): SyncStatus {
    const enabled = this.enabled();
    const account = this.account ?? null;
    const own = this.state?.login === account;
    return {
      enabled,
      phase: !enabled
        ? "off"
        : this.phase === "syncing"
          ? "syncing"
          : this.account === null
            ? "no-github"
            : this.needsKey
              ? "needs-passphrase"
              : this.phase === "error"
                ? "error"
                : "idle",
      account,
      repo: account ? `${account}/${SYNC_REPO}` : null,
      lastSyncAt: own ? this.state!.lastSyncAt : null,
      error: enabled ? (this.needsKey ? this.keyProblem : this.phase === "error" ? this.error : null) : null,
      remote: own ? this.state!.remote : null,
      available: enabled ? this.available : [],
      localOnly: enabled ? this.localOnlyInfo : [],
      hasKey: !!this.key,
    };
  }

  async now(): Promise<SyncStatus> {
    if (!this.enabled()) throw new ForgeError("VALIDATION", "Die Synchronisierung über GitHub ist aus.");
    await this.run(true);
    const s = this.status();
    if (s.phase === "no-github") throw new ForgeError("VALIDATION", "Melde dich zuerst bei GitHub an.");
    if (s.phase === "needs-passphrase") throw new ForgeError("VALIDATION", s.error ?? "Gib zuerst das Sync-Passwort ein.");
    if (s.phase === "error") throw new ForgeError("INTERNAL", s.error ?? "Synchronisieren fehlgeschlagen.");
    return s;
  }

  async probe(): Promise<SyncProbe> {
    const acc = await this.d.remote.account();
    const none = { updatedAt: null, device: null, projects: null, settings: null };
    if (!acc) return { account: null, repo: null, found: false, ...none };
    const repo = `${acc.login}/${SYNC_REPO}`;
    const info = await this.d.remote.repoInfo(repo);
    const file = info ? await this.d.remote.readRepoFile(repo, SYNC_FILE) : null;
    if (!file) return { account: acc.login, repo, found: false, ...none };
    const doc = parseDoc(file.text);
    const key = await this.loadKey();
    let keys: string[] | null;
    try {
      keys = key ? Object.keys(decodeItems(doc, key)) : null;
    } catch {
      keys = null;
    }
    return {
      account: acc.login,
      repo,
      found: true,
      updatedAt: doc.updatedAt,
      device: doc.device,
      projects: keys ? keys.filter((k) => k.startsWith("project:")).length : null,
      settings: keys ? keys.filter((k) => k.startsWith("setting:")).length : null,
    };
  }

  /** With data on GitHub the password must open it; without, it becomes the password of the repository. */
  async setPassphrase(passphrase: string): Promise<SyncStatus> {
    await this.exclusive(async () => {
      const { repo } = await this.repo();
      const file = await this.d.remote.readRepoFile(repo, SYNC_FILE);
      let key: SyncKey;
      if (file) {
        const doc = parseDoc(file.text);
        key = await deriveKey(passphrase, doc.kdf);
        try {
          decodeItems(doc, key);
        } catch (e) {
          throw new ForgeError("VALIDATION", errorText(e));
        }
      } else {
        key = await deriveKey(passphrase, newKdf(this.d.kdfN));
      }
      // A new password on another computer started the repository anew: what was agreed before no longer counts.
      if (this.state && this.key && this.key.kdf.salt !== key.kdf.salt) this.state = { ...this.state, base: null, localKeys: [] };
      await this.d.key.set(key);
      this.key = key;
      this.needsKey = false;
      this.keyProblem = null;
    });
    await this.run(true);
    return this.status();
  }

  /** Overwrites the repository with this computer's data under a new password. */
  async resetRemote(passphrase: string): Promise<SyncStatus> {
    await this.exclusive(async () => {
      const { acc, repo } = await this.repo();
      const key = await deriveKey(passphrase, newKdf(this.d.kdfN));
      const local = await this.snapshot([]);
      const file = await this.d.remote.readRepoFile(repo, SYNC_FILE);
      await this.write(repo, local.items, key, file?.sha ?? null, `FORGE-Daten von ${this.device}, neu angefangen`);
      await this.d.key.set(key);
      this.key = key;
      this.needsKey = false;
      this.keyProblem = null;
      await this.saveState({ login: acc.login, base: local.items, localKeys: Object.keys(local.items), localOnly: [], lastSyncAt: new Date().toISOString(), remote: { updatedAt: new Date().toISOString(), device: this.device } });
      this.available = [];
      this.localOnlyInfo = [];
      this.phase = "idle";
      this.error = null;
      this.d.log(`Synchronisierung: ${repo} mit dem Stand dieses Computers neu angefangen`);
    });
    this.emitStatus();
    return this.status();
  }

  /**
   * Sets this computer hard to the state on GitHub, or only the item `key`. Values come from GitHub,
   * what GitHub no longer has is removed here (projects only from FORGE). What was added here and
   * not synced yet stays and goes up with the next sync.
   */
  async forceLocal(key?: string): Promise<SyncStatus> {
    if (!this.enabled()) throw new ForgeError("VALIDATION", "Die Synchronisierung über GitHub ist aus.");
    await this.exclusive(async () => {
      const { acc, repo } = await this.repo();
      const sk = await this.requireKey();
      const file = await this.d.remote.readRepoFile(repo, SYNC_FILE);
      if (!file) throw new ForgeError("NOT_FOUND", "Auf GitHub liegt noch kein Stand.");
      const doc = parseDoc(file.text);
      const remote = this.decode(doc, sk);
      const state: SyncState = this.state?.login === acc.login ? this.state : { login: acc.login, base: null, localKeys: [], localOnly: [], lastSyncAt: null, remote: null };
      await this.d.safetyBackup();
      const local = await this.snapshot([]);
      const targets = key ? withSiblings(key) : [...new Set([...Object.keys(remote), ...Object.keys(local.items)])];
      const apply: Items = {};
      const remove: string[] = [];
      for (const k of targets) {
        if (k in remote) {
          if (!same(local.items[k], remote[k])) apply[k] = remote[k];
        } else if (k in local.items && (key || state.localOnly.includes(k) || state.base?.[k] !== undefined)) remove.push(k);
      }
      const failed = await this.applyRemote(apply, local.projects);
      for (const k of remove) {
        try {
          await this.removeItem(k, local.projects);
        } catch (e) {
          failed.add(k);
          this.d.log(`Synchronisierung: ${k} nicht entfernt: ${errorText(e)}`);
        }
      }
      const after = await this.snapshot([]);
      const base = { ...remote };
      for (const k of failed) {
        if (k in after.items) base[k] = after.items[k];
        else delete base[k];
      }
      const localOnly = key ? state.localOnly.filter((k) => !targets.includes(k)) : [];
      await this.saveState({ ...state, base, localKeys: Object.keys(after.items).filter((k) => !localOnly.includes(k)), localOnly, remote: { updatedAt: doc.updatedAt, device: doc.device } });
      this.available = this.availableFrom(base, this.state!.localKeys);
      this.localOnlyInfo = this.describe(localOnly, after.projects);
      this.d.log(`Synchronisierung: ${key ? key : "dieser Computer"} auf den Stand von GitHub gesetzt`);
    });
    await this.run(true);
    return this.status();
  }

  /** Syncs an item again that another computer removed. */
  async keep(key: string): Promise<SyncStatus> {
    if (!this.state?.localOnly.includes(key)) throw new ForgeError("NOT_FOUND", "Das ist nicht nur auf diesem Computer.");
    await this.exclusive(async () => {
      const drop = withSiblings(key);
      await this.saveState({ ...this.state!, localOnly: this.state!.localOnly.filter((k) => !drop.includes(k)) });
      this.localOnlyInfo = this.localOnlyInfo.filter((x) => !drop.includes(x.key));
    });
    await this.run(true);
    return this.status();
  }

  async versions(): Promise<SyncVersion[]> {
    const { repo } = await this.repo();
    const list = await this.d.remote.repoFileHistory(repo, SYNC_FILE);
    return list.map((c) => ({ sha: c.sha, date: c.date, device: /^FORGE-Daten von (.+?)(?:, neu angefangen)?$/.exec(c.message.split("\n")[0]!.trim())?.[1] ?? null }));
  }

  /** Takes the chosen parts back from an older state; the other computers get them with the next sync. */
  async restoreVersion(sha: string, parts: BackupPart[]): Promise<{ restored: BackupPart[]; notes: string[] }> {
    if (!this.enabled()) throw new ForgeError("VALIDATION", "Die Synchronisierung über GitHub ist aus.");
    const out = await this.exclusive(async () => {
      const { repo } = await this.repo();
      const sk = await this.requireKey();
      const file = await this.d.remote.readRepoFile(repo, SYNC_FILE, sha);
      if (!file) throw new ForgeError("NOT_FOUND", "Diesen Stand gibt es auf GitHub nicht.");
      const doc = parseDoc(file.text);
      let items: Items;
      try {
        items = decodeItems(doc, sk);
      } catch {
        throw new ForgeError("VALIDATION", "Dieser Stand ist mit einem früheren Sync-Passwort verschlüsselt und lässt sich hier nicht öffnen.");
      }
      await this.d.safetyBackup();
      const local = await this.snapshot([]);
      const kinds = new Set(parts.flatMap((p) => PART_KINDS[p]));
      const apply: Items = {};
      const restored = new Set<BackupPart>();
      let missingProjects = 0;
      for (const [k, v] of Object.entries(items)) {
        const { kind } = split(k);
        if (!kinds.has(kind)) continue;
        for (const p of parts) if (PART_KINDS[p].includes(kind)) restored.add(p);
        if (kind === "project" && !local.projects.has(k)) missingProjects++;
        if (!same(local.items[k], v)) apply[k] = v;
      }
      const failed = await this.applyRemote(apply, local.projects);
      const notes = ["Die anderen Computer bekommen diesen Stand mit dem nächsten Abgleich."];
      if (missingProjects) notes.push(`${missingProjects === 1 ? "1 Projekt" : `${missingProjects} Projekte`} aus diesem Stand ${missingProjects === 1 ? "liegt" : "liegen"} nicht auf diesem Computer und ${missingProjects === 1 ? "lässt" : "lassen"} sich unter Synchronisierung holen.`);
      if (failed.size) notes.push(`${failed.size === 1 ? "Ein Eintrag ließ" : `${failed.size} Einträge ließen`} sich nicht übernehmen, Einzelheiten stehen im Protokoll.`);
      this.d.log(`Synchronisierung: Stand ${sha.slice(0, 7)} wiederhergestellt (${[...restored].join(", ")})`);
      return { restored: [...restored], notes };
    });
    await this.run(true);
    return out;
  }

  /** Clones a project another computer synced into the folder for new projects and takes over its settings. */
  async cloneProject(key: string): Promise<Project> {
    const raw = this.state?.base?.[`project:${key}`];
    const item = ProjectItem.safeParse(raw);
    if (!item.success) throw new ForgeError("NOT_FOUND", "Das Projekt steht nicht im Sync-Repository.");
    if (!item.data.cloneUrl) throw new ForgeError("VALIDATION", "Das Projekt hat kein Git-Remote und lässt sich deshalb nicht holen.");
    const dir = this.d.settings().defaultProjectDir;
    if (!dir) throw new ForgeError("VALIDATION", "Lege zuerst in den Einstellungen einen Ordner für neue Projekte fest.");
    const cloned = await this.d.cloneProject(item.data.cloneUrl, dir);
    const { cloneUrl: _url, ...patch } = item.data;
    this.applying = true;
    let project: Project;
    try {
      project = await this.d.updateProject(cloned.id, patch);
      const tools = this.state?.base?.[`devtools:${key}`];
      if (tools) this.d.devTools.set(project.id, tools);
    } finally {
      this.applying = false;
    }
    this.available = this.available.filter((p) => p.key !== key);
    this.emitStatus();
    void this.run(true);
    return project;
  }

  private async repo() {
    const acc = await this.d.remote.account();
    this.account = acc?.login ?? null;
    if (!acc) throw new ForgeError("VALIDATION", "Melde dich zuerst bei GitHub an.");
    const repo = `${acc.login}/${SYNC_REPO}`;
    await this.ensureRepo(repo);
    return { acc, repo };
  }

  private async loadKey(): Promise<SyncKey | null> {
    if (this.key === undefined) this.key = await this.d.key.get().catch(() => null);
    return this.key;
  }

  private async requireKey(): Promise<SyncKey> {
    const k = await this.loadKey();
    if (!k) throw new ForgeError("VALIDATION", "Gib zuerst das Sync-Passwort ein.");
    return k;
  }

  private decode(doc: SyncDoc, key: SyncKey): Items {
    try {
      return decodeItems(doc, key);
    } catch (e) {
      if (!(e instanceof PassphraseNeeded)) throw e;
      this.needsKey = true;
      this.keyProblem = e.message;
      throw new ForgeError("VALIDATION", e.message);
    }
  }

  private async write(repo: string, items: Items, key: SyncKey, sha: string | null, message: string): Promise<SyncDoc> {
    const doc: SyncDoc = { format: "forge-sync", version: 2, updatedAt: new Date().toISOString(), device: this.device, appVersion: this.d.appVersion, kdf: key.kdf, box: seal(key, JSON.stringify(items)) };
    await this.d.remote.writeRepoFile(repo, SYNC_FILE, `${JSON.stringify(doc, null, 2)}\n`, sha, message);
    return doc;
  }

  private schedule(ms: number, force: boolean) {
    this.pendingForce ||= force;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const f = this.pendingForce;
      this.pendingForce = false;
      void this.run(f);
    }, ms);
    this.timer.unref?.();
  }

  /** One run at a time; a request during a run gets one more run afterwards. */
  private run(force: boolean): Promise<unknown> {
    if (this.running) {
      this.again = true;
      this.pendingForce ||= force;
      return this.running;
    }
    this.running = (async () => {
      let f = force;
      do {
        this.again = false;
        await this.syncOnce(f);
        f = this.pendingForce;
        this.pendingForce = false;
      } while (this.again && this.enabled());
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Runs `fn` while no sync runs; a sync asked for meanwhile follows afterwards. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    while (this.running) await this.running.catch(() => {});
    const p = fn();
    this.running = p;
    try {
      return await p;
    } finally {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.run(this.pendingForce);
      }
    }
  }

  /** `force`: ask GitHub even when nothing changed here (start, interval, by hand). */
  private async syncOnce(force: boolean) {
    if (!this.enabled()) return this.emitStatus();
    if (!force && this.state?.base && this.phase !== "error" && !this.needsKey) {
      const st = this.state;
      const local = await this.snapshot(st.localOnly);
      const { result } = mergeItems(st.base, local.items, st.base, (k) => st.localKeys.includes(k));
      if (sameItems(result, st.base!)) return;
    }
    this.phase = "syncing";
    this.emitStatus();
    try {
      const acc = await this.d.remote.account();
      this.account = acc?.login ?? null;
      if (!acc) {
        this.phase = "idle";
        this.error = null;
        return;
      }
      const repo = `${acc.login}/${SYNC_REPO}`;
      await this.ensureRepo(repo);
      const key = await this.loadKey();
      if (!key) {
        this.needsKey = true;
        this.keyProblem = "Gib das Sync-Passwort ein, mit dem die Daten auf GitHub verschlüsselt werden.";
        this.phase = "idle";
        return;
      }
      let state: SyncState = this.state?.login === acc.login ? this.state : { login: acc.login, base: null, localKeys: [], localOnly: [], lastSyncAt: null, remote: null };
      for (let attempt = 1; ; attempt++) {
        const file = await this.d.remote.readRepoFile(repo, SYNC_FILE);
        const remoteDoc = file ? parseDoc(file.text) : null;
        let remoteItems: Items | null = null;
        if (remoteDoc) {
          try {
            remoteItems = this.decode(remoteDoc, key);
          } catch (e) {
            if (this.needsKey) {
              this.phase = "idle";
              return;
            }
            throw e;
          }
        }
        this.needsKey = false;
        this.keyProblem = null;
        const local = await this.snapshot(state.localOnly);
        const merged = mergeItems(state.base, local.items, remoteItems, (k) => state.localKeys.includes(k));
        const failed = await this.applyRemote(merged.apply, local.projects);
        const localOnly = new Set(state.localOnly);
        for (const k of Object.keys(merged.apply)) localOnly.delete(k);
        for (const k of merged.removed) localOnly.add(k);
        let doc = remoteDoc;
        if (!remoteItems || !sameItems(merged.result, remoteItems)) {
          try {
            doc = await this.write(repo, merged.result, key, file?.sha ?? null, `FORGE-Daten von ${this.device}`);
          } catch (e) {
            // Another computer pushed in between: merge with its state and try again.
            if (e instanceof ForgeError && e.code === "CONFLICT" && attempt < MAX_ATTEMPTS) {
              state = { ...state, localOnly: [...localOnly] };
              continue;
            }
            throw e;
          }
        }
        // Not taken over here (e.g. the phone was in a call): the next sync tries again.
        const base = { ...merged.result };
        for (const k of failed) {
          if (k in local.items) base[k] = local.items[k];
          else delete base[k];
        }
        const here = new Set([...Object.keys(local.items), ...Object.keys(merged.apply).filter((k) => !failed.has(k) && this.isLocalAfterApply(k, local.projects))]);
        for (const k of localOnly) here.delete(k);
        state = {
          login: acc.login,
          base,
          localKeys: [...here],
          localOnly: [...localOnly],
          lastSyncAt: new Date().toISOString(),
          remote: doc ? { updatedAt: doc.updatedAt, device: doc.device } : null,
        };
        await this.saveState(state);
        this.available = this.availableFrom(base, state.localKeys);
        this.localOnlyInfo = this.describe(state.localOnly, local.projects);
        break;
      }
      this.phase = "idle";
      this.error = null;
    } catch (e) {
      this.phase = "error";
      this.error = errorText(e);
      this.d.log(`Synchronisierung: ${this.error}`);
    } finally {
      this.emitStatus();
    }
  }

  /** Projects and their dev tools exist here only when the project does; everything else is written here. */
  private isLocalAfterApply(key: string, projects: Map<string, Project>): boolean {
    const { kind, id } = split(key);
    if (kind === "project" || kind === "devtools") return projects.has(`project:${id}`);
    return true;
  }

  private async ensureRepo(repo: string) {
    const info = await this.d.remote.repoInfo(repo);
    if (!info) {
      await this.d.remote.createPrivateRepo(SYNC_REPO, "Daten von FORGE, verschlüsselt");
      this.d.log(`Synchronisierung: privates Repository ${repo} angelegt`);
    } else if (!info.private) {
      throw new ForgeError("POLICY_DENIED", `Das Repository ${repo} ist öffentlich. FORGE speichert seine Daten nur in einem privaten Repository.`);
    }
  }

  /** Everything this computer would sync; `projects` holds every project here, also the ones kept out. */
  private async snapshot(localOnly: string[]): Promise<{ items: Items; projects: Map<string, Project> }> {
    const items: Items = {};
    const s = this.d.settings();
    for (const k of SYNCED_SETTINGS) items[`setting:${k}`] = s[k];
    const git = await this.d.identity().catch(() => ({ name: null, email: null }));
    if (git.name && git.email) items["git:identity"] = { name: git.name, email: git.email };
    const projects = new Map<string, Project>();
    for (const p of this.d.projects()) {
      if (p.parentId) continue;
      const remote = await this.d.remoteUrl(p.path).catch(() => null);
      const { key, cloneUrl } = projectKey(p.path, remote);
      const id = `project:${key}`;
      if (projects.has(id)) continue;
      projects.set(id, p);
      const item: ProjectItem = {
        name: p.name,
        cloneUrl,
        favorite: p.favorite,
        tags: p.tags,
        profile: p.profile,
        defaultModel: p.defaultModel,
        defaultEffort: p.defaultEffort,
        testCommand: p.testCommand,
        devCommand: p.devCommand,
        gitEnabled: p.gitEnabled,
      };
      items[id] = item;
      const tools = this.d.devTools.get(p.id);
      if (tools) items[`devtools:${key}`] = tools;
    }
    const phone = this.d.phone.config();
    if (phone) items["phone:config"] = phone;
    for (const name of this.d.secrets.names()) {
      const v = await this.d.secrets.get(name).catch(() => null);
      if (v) items[`secret:${name}`] = v;
    }
    for (const [rel, text] of Object.entries(await this.readClaudeFiles())) items[`claude:${rel}`] = text;
    for (const [name, cfg] of Object.entries(await this.readMcpServers())) items[`mcp:${name}`] = cfg;
    for (const k of localOnly) delete items[k];
    return { items, projects };
  }

  private async readClaudeFiles(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    let total = 0;
    const add = async (rel: string) => {
      const full = path.join(this.claudeDir, rel);
      const s = await stat(full).catch(() => null);
      if (!s?.isFile() || s.size > MAX_FILE_BYTES || total + s.size > MAX_CLAUDE_BYTES) return;
      out[rel.split(path.sep).join("/")] = await readFile(full, "utf8");
      total += s.size;
    };
    for (const f of CLAUDE_FILES) await add(f);
    for (const dir of CLAUDE_DIRS) {
      const entries = await readdir(path.join(this.claudeDir, dir), { recursive: true, withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isFile() || !TEXT_FILE.test(e.name)) continue;
        await add(path.relative(this.claudeDir, path.join(e.parentPath, e.name)));
      }
    }
    return out;
  }

  private async readClaudeJson(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(await readFile(this.claudeJson, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  private async readMcpServers(): Promise<Record<string, unknown>> {
    const servers = (await this.readClaudeJson()).mcpServers;
    return servers && typeof servers === "object" ? (servers as Record<string, unknown>) : {};
  }

  /** Takes over what changed elsewhere; returns the items that could not be taken over. */
  private async applyRemote(apply: Items, projects: Map<string, Project>): Promise<Set<string>> {
    const failed = new Set<string>();
    const settings: Record<string, unknown> = {};
    const mcp: Record<string, unknown> = {};
    let phone: Record<string, unknown> | null = null;
    let secretsChanged = false;
    this.applying = true;
    try {
      for (const [k, v] of Object.entries(apply)) {
        const { kind, id } = split(k);
        try {
          if (kind === "setting") {
            if ((SYNCED_SETTINGS as string[]).includes(id)) settings[id] = v;
          } else if (kind === "git") {
            const g = GitItem.safeParse(v);
            if (g.success) await this.d.setIdentity(g.data.name, g.data.email);
          } else if (kind === "project") {
            const p = projects.get(k);
            const item = ProjectItem.safeParse(v);
            if (p && item.success) {
              const { cloneUrl: _url, ...patch } = item.data;
              await this.d.updateProject(p.id, patch);
            }
          } else if (kind === "devtools") {
            const p = projects.get(`project:${id}`);
            if (p && v && typeof v === "object") this.d.devTools.set(p.id, v);
          } else if (kind === "phone") {
            if (v && typeof v === "object") phone = v as Record<string, unknown>;
          } else if (kind === "secret") {
            if (typeof v === "string" && /^[\w-]{1,64}$/.test(id)) {
              await this.d.secrets.set(id, v);
              secretsChanged = true;
            }
          } else if (kind === "claude") {
            if (typeof v === "string") await this.writeClaudeFile(id, v);
          } else if (kind === "mcp") {
            if (v && typeof v === "object") mcp[id] = v;
          }
        } catch (e) {
          failed.add(k);
          this.d.log(`Synchronisierung: ${k} nicht übernommen: ${errorText(e)}`);
        }
      }
      const patch = Settings.partial().safeParse(settings);
      const settingKeys = Object.keys(settings).map((k) => `setting:${k}`);
      if (!patch.success) {
        settingKeys.forEach((k) => failed.add(k));
        this.d.log("Synchronisierung: Einstellungen aus dem Repository sind ungültig und wurden nicht übernommen");
      } else if (Object.keys(patch.data).length) {
        await this.d.updateSettings(patch.data).catch((e: unknown) => {
          settingKeys.forEach((k) => failed.add(k));
          this.d.log(`Synchronisierung: Einstellungen nicht übernommen: ${errorText(e)}`);
        });
      }
      if (Object.keys(mcp).length) {
        await this.writeMcpServers((servers) => Object.assign(servers, mcp)).catch((e: unknown) => {
          Object.keys(mcp).forEach((n) => failed.add(`mcp:${n}`));
          this.d.log(`Synchronisierung: MCP-Server nicht übernommen: ${errorText(e)}`);
        });
      }
      // The phone reloads once; that also reads the new secrets.
      if (phone) {
        await this.d.phone.apply(phone).catch((e: unknown) => {
          failed.add("phone:config");
          this.d.log(`Synchronisierung: ${errorText(e)}`);
        });
      } else if (secretsChanged) await this.d.phone.secretsChanged().catch(() => {});
    } finally {
      this.applying = false;
    }
    return failed;
  }

  private async removeItem(key: string, projects: Map<string, Project>) {
    const { kind, id } = split(key);
    if (kind === "project") {
      const p = projects.get(key);
      if (p) await this.d.removeProject(p.id);
    } else if (kind === "claude") await rm(this.claudeTarget(id), { force: true });
    else if (kind === "mcp") await this.writeMcpServers((servers) => delete servers[id]);
    else if (kind === "secret") {
      await this.d.secrets.set(id, null);
      await this.d.phone.secretsChanged().catch(() => {});
    }
  }

  private async writeMcpServers(change: (servers: Record<string, unknown>) => void) {
    const current = await this.readClaudeJson();
    const servers = { ...((current.mcpServers as Record<string, unknown> | undefined) ?? {}) };
    change(servers);
    await writeAtomic(this.claudeJson, JSON.stringify({ ...current, mcpServers: servers }, null, 2));
  }

  /** Only the files FORGE syncs itself, inside the Claude folder. */
  private claudeTarget(rel: string): string {
    const parts = rel.split("/");
    const allowed = CLAUDE_FILES.includes(rel) || (parts.length > 1 && CLAUDE_DIRS.includes(parts[0]!) && TEXT_FILE.test(rel));
    if (!allowed || parts.some((p) => p === ".." || p === "" || p.includes("\\") || p.includes(":"))) throw new Error("Pfad nicht erlaubt");
    const root = path.resolve(this.claudeDir);
    const target = path.resolve(root, ...parts);
    if (path.relative(root, target).startsWith("..")) throw new Error("Pfad nicht erlaubt");
    return target;
  }

  private async writeClaudeFile(rel: string, content: string) {
    const target = this.claudeTarget(rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeAtomic(target, content);
  }

  private describe(localOnly: string[], projects: Map<string, Project>): SyncLocalOnly[] {
    const out: SyncLocalOnly[] = [];
    for (const k of localOnly) {
      const { kind, id } = split(k);
      // Dev tools go with their project.
      if (kind === "devtools" && localOnly.includes(`project:${id}`)) continue;
      const p = kind === "project" || kind === "devtools" ? projects.get(`project:${id}`) : undefined;
      const label =
        kind === "project"
          ? `Projekt ${p?.name ?? id}`
          : kind === "devtools"
            ? `Dev-Tools von ${p?.name ?? id}`
            : kind === "claude"
              ? `Claude-Datei ${id}`
              : kind === "mcp"
                ? `MCP-Server ${id}`
                : kind === "secret"
                  ? (SECRET_LABELS[id] ?? `Schlüssel ${id}`)
                  : kind === "phone"
                    ? "Telefon-Einstellungen"
                    : kind === "git"
                      ? "Git-Name und E-Mail"
                      : `Einstellung ${id}`;
      out.push({ key: k, kind, label, projectId: kind === "project" ? (p?.id ?? null) : null });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }

  private availableFrom(items: Items, localKeys: string[]): SyncAvailableProject[] {
    const here = new Set(localKeys);
    const out: SyncAvailableProject[] = [];
    for (const [k, v] of Object.entries(items)) {
      if (!k.startsWith("project:") || here.has(k)) continue;
      const item = ProjectItem.safeParse(v);
      if (item.success) out.push({ key: k.slice("project:".length), name: item.data.name, cloneUrl: item.data.cloneUrl });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private emitStatus() {
    this.d.emit(this.status());
  }

  private loadState(): SyncState | null {
    try {
      const parsed = SyncState.safeParse(JSON.parse(readFileSync(this.d.stateFile, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private async saveState(state: SyncState) {
    this.state = state;
    await mkdir(path.dirname(this.d.stateFile), { recursive: true });
    await writeFile(this.d.stateFile, JSON.stringify(state), "utf8");
  }
}

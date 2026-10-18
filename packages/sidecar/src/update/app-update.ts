import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ForgeError, type AppChangelog, type AppUpdateState } from "@forge/protocol";
import { run } from "../util/proc.js";
import { resolveTool } from "../util/tools.js";
import { GitHubReleases, type ReleaseAsset, type ReleaseSource } from "./github-releases.js";
import { SIG_SUFFIX, verifySignature } from "./signature.js";
import { tr } from "../i18n/index.js";

/** Repository whose GitHub releases carry the FORGE installer (built by .github/workflows/release.yml). */
export const UPDATE_REPO = "vanturis/forge";
// Soon after the start, so an available update is offered right away.
const FIRST_CHECK_MS = 3_000;
const CHECK_INTERVAL_MS = 30 * 60_000;
const INSTALLER = /-setup\.exe$/i;
/** full installer of releases up to 0.1.8x, with the runtime key in its name; the oldest ones have none */
const KEYED_INSTALLER = /^FORGE_[^_]+_(.+)_x64-setup\.exe$/i;
/**
 * Since the short installer names (FORGE_<v>_x64-setup.exe) the runtime key sits in the name of a
 * small marker asset next to the installer: FORGE_<v>_x64-setup.<key>.runtime (release.yml).
 */
const RUNTIME_MARKER = /^FORGE_[^_]+_x64-setup\.(.+)\.runtime$/i;
/** small update: exe and sidecar only, for one runtime (key in the name) */
const PATCH = /_update_(.+)\.zip$/i;

/** Runtime key in the name of a full installer, null for names without one (short names included). */
export function installerRuntimeKey(name: string): string | null {
  return KEYED_INSTALLER.exec(name)?.[1] ?? null;
}

/** Runtime key of a full installer in a release: from its long name or from the marker asset next to it. */
function releaseInstallerKey(rel: Release, installerName: string): string | null {
  const named = installerRuntimeKey(installerName);
  if (named) return named;
  for (const a of rel.assets ?? []) {
    const key = a.name ? RUNTIME_MARKER.exec(a.name)?.[1] : undefined;
    if (key) return key;
  }
  return null;
}

/** Runtime key of the small update a release carries, null without one. */
function patchRuntimeKey(rel: Release): string | null {
  for (const a of rel.assets ?? []) {
    const key = a.name ? PATCH.exec(a.name)?.[1] : undefined;
    if (key) return key;
  }
  return null;
}

/** A release asset with its name, paired with its signature by signedOnly. */
export type Asset = ReleaseAsset & { name: string; sig?: ReleaseAsset };

/** The full installer of a release, only one for `key` when a key is given. */
function installerOf(rel: Release, key: string | null): Asset | null {
  const a = (rel.assets ?? []).find((x) => x.name && INSTALLER.test(x.name) && (!key || releaseInstallerKey(rel, x.name) === key));
  return a?.name ? { ...a, name: a.name } : null;
}

/** Published releases, newest first. */
function published(releases: Release[]): Release[] {
  return releases.filter((r) => r.tag_name && !r.draft && !r.prerelease).sort((a, b) => compareVersions(b.tag_name!, a.tag_name!));
}

/**
 * The newest full installer for a runtime key, whatever its version (the runtime changes rarely, so
 * the installer usually belongs to an older release). Without a key the newest installer at all.
 * `then`: the newest small update for that runtime when it is newer than the installer.
 */
export function pickInstaller(releases: Release[], key: string | null): { release: Release; asset: Asset; then: Release | null } | null {
  const list = published(releases);
  for (const rel of list) {
    const asset = installerOf(rel, key);
    if (!asset) continue;
    const runtime = key ?? releaseInstallerKey(rel, asset.name);
    const patch = runtime ? list.find((r) => patchRuntimeKey(r) === runtime) : undefined;
    const then = patch && compareVersions(patch.tag_name!, rel.tag_name!) > 0 ? patch : null;
    return { release: rel, asset, then };
  }
  return null;
}
/**
 * Most releases whose changes the update dialog lists. Local builds are 0.1.0 and would otherwise get
 * every release ever made. Below the 100 of the first page of the releases list, so that page is enough.
 */
export const MAX_CHANGE_RELEASES = 20;
// Limits for the changelog prompt. The compare API sends at most 250 commits without paging; one
// release per push keeps MAX_CHANGE_RELEASES well below that.
const MAX_NOTES_PER_RELEASE = 2_000;
const MAX_NOTES = 12_000;
const MAX_COMMITS = 150;

const bare = (tag: string) => tag.replace(/^v/i, "");

/**
 * Key of the installed runtime (bundled node, git, gh, python), as runtimeKey in
 * scripts/prepare-runtime.mjs builds it. Installations from before Python have the key without it;
 * no new small update matches that, so they get the full installer. null in a development build
 * without bundled runtime.
 */
export function installedRuntimeKey(dir = process.env.FORGE_RUNTIME_DIR): string | null {
  if (!dir) return null;
  try {
    const v = JSON.parse(readFileSync(path.join(dir, "VERSIONS.json"), "utf8")) as { node?: string; git?: string; gh?: string; python?: string };
    if (!v.node || !v.git || !v.gh) return null;
    return `node-${v.node}_git-${v.git}_gh-${v.gh}${v.python ? `_python-${v.python}` : ""}`;
  } catch {
    return null;
  }
}

/**
 * Which release to install from a list. The offered version is always the newest one (`newest`).
 * It is installed directly when it has a full installer or a small update for the installed runtime.
 * Otherwise `release` is a full installer for the runtime the small update of `newest` needs, which
 * then follows after the restart (see AppUpdateService.check). That installer may belong to an older
 * release than the installed one: the runtime changes rarely, and only such an installer leads on.
 */
export function pickRelease(
  releases: Release[],
  current: string,
  runtimeKey: string | null,
): { newest: Release; release: Release; asset: Asset; kind: "patch" | "full" } | null {
  const newer = newerReleases(releases, current);
  const newest = newer[0];
  if (!newest) return null;
  const patch = runtimeKey ? (newest.assets ?? []).find((a) => a.name && PATCH.exec(a.name)?.[1] === runtimeKey) : undefined;
  if (patch?.name) return { newest, release: newest, asset: { ...patch, name: patch.name }, kind: "patch" };
  const target = patchRuntimeKey(newest);
  const full = (rel: Release, key: string | null) => {
    const asset = installerOf(rel, key);
    return asset ? { newest, release: rel, asset, kind: "full" as const } : null;
  };
  for (const rel of newer) {
    const hit = full(rel, target);
    if (hit) return hit;
  }
  if (target) {
    for (const rel of published(releases)) {
      const hit = full(rel, target);
      if (hit) return hit;
    }
  }
  // Last resort: an installer for another runtime still brings a newer version.
  for (const rel of newer) {
    const hit = full(rel, null);
    if (hit) return hit;
  }
  return null;
}

/** Published releases newer than `current`, newest first. */
function newerReleases(releases: Release[], current: string): Release[] {
  const newer = releases.filter((r) => r.tag_name && !r.draft && !r.prerelease && compareVersions(r.tag_name, current) > 0);
  return newer.sort((a, b) => compareVersions(b.tag_name!, a.tag_name!));
}

/** The releases an update brings, for its changelog. */
export interface ChangeRange {
  /** every release after `since` up to the offered one, newest first */
  releases: Release[];
  /** version the changes are listed from (not included) */
  since: string;
  /** tag of `since`, base of the commit comparison */
  sinceTag: string;
  /** true when releases between the installed version and `since` are left out */
  capped: boolean;
}

/**
 * All releases after the installed version up to the newest, not just the newest. With more than
 * `max` of them (an old or local build) only the newest `max`, starting after the release before them.
 */
export function changeRange(releases: Release[], current: string, max = MAX_CHANGE_RELEASES): ChangeRange | null {
  const newer = newerReleases(releases, current);
  if (!newer.length) return null;
  const listed = newer.slice(0, max);
  const before = newer[max];
  if (before) return { releases: listed, since: bare(before.tag_name!), sinceTag: before.tag_name!, capped: true };
  const installed = releases.find((r) => r.tag_name && compareVersions(r.tag_name, current) === 0);
  return { releases: listed, since: current, sinceTag: installed?.tag_name ?? `v${current}`, capped: false };
}

/** Release notes of a range for the update dialog: one release as is, several under a heading each. */
export function rangeNotes(range: ChangeRange): string {
  const notes = range.releases.map((r) => ({ version: bare(r.tag_name!), text: (r.body ?? "").trim() })).filter((n) => n.text);
  if (range.releases.length === 1) return notes[0]?.text ?? "";
  return notes.map((n) => `### ${n.version}\n${n.text}`).join("\n\n");
}

/** Shortens at a line end, so no list item is cut in half. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > 0 ? cut : max)}\n${tr().system.update.clipped}`;
}

/** Where installers are downloaded; the desktop shell runs installers from this folder only. */
export function updateDir(): string {
  return path.join(os.tmpdir(), "forge-update");
}

/** Subfolder of updateDir for the full installer of a repair; an update download leaves it alone. */
export const FULL_DIR = "full";

/** Outside updateDir, which is emptied before every download. */
export function defaultChainFile(): string {
  return path.join(os.tmpdir(), "forge-update-chain.json");
}

/** Numeric comparison of versions like 0.1.12; a pre-release suffix sorts below the plain version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.replace(/^v/i, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export interface Release {
  tag_name?: string;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: Array<ReleaseAsset & { sig?: ReleaseAsset }>;
}

/**
 * The releases with only the assets that have a signature next to them (FORGE_x.zip.sig), each
 * paired with it. Unsigned assets (releases from before the signing) are never offered.
 */
export function signedOnly(releases: Release[]): Release[] {
  return releases.map((r) => {
    const all = r.assets ?? [];
    const sigs = new Map(all.filter((a) => a.name?.endsWith(SIG_SUFFIX)).map((a) => [a.name!.slice(0, -SIG_SUFFIX.length), a]));
    return { ...r, assets: all.filter((a) => a.name && !a.name.endsWith(SIG_SUFFIX) && sigs.has(a.name)).map((a) => ({ ...a, sig: sigs.get(a.name!) })) };
  });
}

/** Releases of UPDATE_REPO over HTTPS, anonymous unless GitHub refuses; then with the gh login, if any. */
export function defaultReleaseSource(): ReleaseSource {
  return new GitHubReleases(UPDATE_REPO, ghToken);
}

/** Token of the gh login, null without gh or login. */
async function ghToken(): Promise<string | null> {
  if (!resolveTool("gh")) return null;
  const r = await runGh(["auth", "token"], 10_000);
  const token = r.code === 0 ? r.stdout.trim() : "";
  return token || null;
}

/**
 * Downloads a signed asset into `dir` and checks it: the SHA-256 GitHub reports (when it does) and
 * always the signature. A file that fails is deleted; the path of a good one is returned.
 */
export async function fetchSigned(source: ReleaseSource, asset: Asset, dir: string, timeoutMs: number, publicKey?: string): Promise<string> {
  if (!asset.sig) throw new Error(tr().system.update.notSigned);
  const file = path.join(dir, asset.name);
  const sigFile = `${file}${SIG_SUFFIX}`;
  try {
    await source.download(asset.sig, sigFile, 60_000);
    await source.download(asset, file, timeoutMs);
  } catch (e) {
    await rm(file, { force: true }).catch(() => {});
    await rm(sigFile, { force: true }).catch(() => {});
    throw new Error(tr().system.update.downloadFailed(e instanceof Error ? e.message : String(e)), { cause: e });
  }
  const hash = await sha256(file);
  const bad =
    asset.digest?.startsWith("sha256:") && hash !== asset.digest.slice(7).toLowerCase()
      ? tr().system.update.checksumMismatch
      : !verifySignature(asset.name, hash, readFileSync(sigFile, "utf8"), publicKey)
        ? tr().system.update.signatureMismatch
        : null;
  await rm(sigFile, { force: true });
  if (bad) {
    await rm(file, { force: true });
    throw new Error(bad);
  }
  return file;
}

export interface UpdateDeps {
  emit(state: AppUpdateState): void;
  enabled(): boolean;
  log(message: string): void;
  /** releases, commits and downloads; tests pass a fake */
  source?: ReleaseSource;
  /** key the signatures are checked with; tests pass their own */
  publicKey?: string;
  currentVersion?: string;
  installable?: boolean;
  /** one-shot Claude call that writes the changelog from the prompt; without it there is none */
  writeChangelog?: (prompt: string) => Promise<string>;
  /** whether Claude can write it right now */
  claudeReady?: () => Promise<"ok" | "no-claude" | "no-login">;
  /** key of the installed runtime; tests pass one */
  runtimeKey?: () => string | null;
  /** remembers across the restart which version a two-step update is heading for; tests pass their own */
  chainFile?: string;
  /** asks the main window to install the offered update (the desktop shell runs installers) */
  requestInstall?: () => void;
}

/** Phases in which an update is offered and can be installed. */
const OFFERED: ReadonlyArray<AppUpdateState["phase"]> = ["available", "downloading", "ready"];

/**
 * Prompt for the changelog: the user's view, short, only what notes and commits say. Covers every
 * release of the range, not just the newest; notes and commits are capped to keep the prompt small.
 */
export function changelogPrompt(current: string, range: ChangeRange, commits: string[], commitsOmitted = 0): string {
  const version = bare(range.releases[0]!.tag_name!);
  const count = range.releases.length;
  const m = tr().system.changelogPrompt;
  const sections: string[] = [];
  let size = 0;
  for (const r of range.releases) {
    const section = `Version ${bare(r.tag_name!)}:\n${clip((r.body ?? "").trim(), MAX_NOTES_PER_RELEASE) || m.none}`;
    if (sections.length && size + section.length > MAX_NOTES) break;
    sections.push(section);
    size += section.length;
  }
  const notesOmitted = count - sections.length;
  const scope = count === 1 ? m.scopeOne(version, current) : m.scopeMany(version, current, count, range.since);
  return [
    scope,
    ...(range.capped ? [m.capped(current, count, range.since)] : []),
    m.rules,
    m.ruleFormat(count === 1 ? 8 : 12),
    m.ruleUser,
    m.ruleOverall,
    m.ruleTruth,
    m.ruleStyle,
    "",
    m.notes,
    ...sections,
    ...(notesOmitted ? [m.notesOmitted(notesOmitted)] : []),
    "",
    m.commits(range.since, commits.length, commitsOmitted),
    commits.length ? commits.map((c) => `- ${c}`).join("\n") : m.unavailable,
  ].join("\n");
}

/**
 * Looks for a newer FORGE release on GitHub and fetches its installer, without a GitHub account
 * (GitHubReleases). Only signed assets are offered, and a download is checked against its signature
 * and the SHA-256 GitHub reports before it can be run (fetchSigned).
 */
export class AppUpdateService {
  private state: AppUpdateState;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** what download() fetches: the offered version, or the full installer that goes first */
  private asset: { tag: string; file: Asset } | null = null;
  /** releases the offered version brings, for the changelog */
  private range: ChangeRange | null = null;
  private readonly chainFile: string;
  private readonly source: ReleaseSource;
  private busy: Promise<AppUpdateState> | null = null;
  private changelogs = new Map<string, { state: AppChangelog; done: Promise<void> }>();
  /** a two-step update was under way at the start: its second step may follow right away */
  private readonly chainAtStart: boolean;
  private started = false;
  private checked = false;

  constructor(private readonly d: UpdateDeps) {
    this.chainFile = d.chainFile ?? defaultChainFile();
    this.source = d.source ?? defaultReleaseSource();
    this.chainAtStart = existsSync(this.chainFile);
    this.state = {
      currentVersion: d.currentVersion ?? process.env.FORGE_APP_VERSION ?? "0.0.0-dev",
      phase: "idle",
      latest: null,
      installerPath: null,
      autoInstall: false,
      // The installed app runs with its bundled runtime; a development build has none.
      installable: d.installable ?? !!process.env.FORGE_RUNTIME_DIR,
      checkedAt: null,
      message: null,
    };
  }

  /** First check shortly after the start, then every 30 minutes (when enabled in the settings). */
  start() {
    this.started = true;
    const tick = (delay: number) => {
      this.timer = setTimeout(() => {
        if (this.d.enabled() && this.state.phase !== "downloading" && this.state.phase !== "ready") void this.check().catch(() => {});
        tick(CHECK_INTERVAL_MS);
      }, delay);
      this.timer.unref?.();
    };
    tick(FIRST_CHECK_MS);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get(): AppUpdateState {
    return this.state;
  }

  /**
   * True while the second step of a two-step update may still install itself after this start. The
   * sessions noted at the restart wait for it, so they do not start working only to be stopped again.
   */
  holdsResume(): boolean {
    if (!this.chainAtStart || !this.started || !this.d.enabled()) return false;
    if (!this.checked) return true;
    return this.state.autoInstall && OFFERED.includes(this.state.phase);
  }

  /** Asks the main window to install the offered update; the phone has no other way to. */
  requestInstall(): AppUpdateState {
    if (!this.state.installable) throw new ForgeError("VALIDATION", tr().system.update.notInstalledApp);
    if (!this.state.latest || !OFFERED.includes(this.state.phase)) throw new ForgeError("VALIDATION", tr().system.update.noneReady);
    if (!this.d.requestInstall) throw new ForgeError("VALIDATION", tr().system.update.cannotInstallHere);
    this.d.requestInstall();
    return this.state;
  }

  private set(patch: Partial<AppUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.d.emit(this.state);
  }

  /** One check or download at a time; a second call gets the running one. */
  private once(job: () => Promise<AppUpdateState>): Promise<AppUpdateState> {
    this.busy ??= job().finally(() => (this.busy = null));
    return this.busy;
  }

  check(): Promise<AppUpdateState> {
    return this.once(async () => {
      // A downloaded installer of the same release stays usable.
      const keep = this.state.phase === "ready" ? this.state.installerPath : null;
      this.set({ phase: "checking", message: null });
      try {
        const found = await this.source.releases();
        if (!found) {
          this.set({ phase: "uptodate", latest: null, checkedAt: new Date().toISOString(), message: tr().system.update.noRelease });
          return this.state;
        }
        const list = signedOnly(found as Release[]);
        const checkedAt = new Date().toISOString();
        const pick = pickRelease(list, this.state.currentVersion, (this.d.runtimeKey ?? installedRuntimeKey)());
        const range = changeRange(list, this.state.currentVersion);
        const chained = this.takeChain(pick);
        if (!pick || !range) {
          this.asset = null;
          this.range = null;
          // Newer releases, but none this installation can take: say so instead of "up to date".
          const blocked = range ? bare(range.releases[0]!.tag_name!) : null;
          const message = blocked ? tr().system.update.needsFullInstaller(blocked) : null;
          this.set({ phase: "uptodate", latest: null, installerPath: null, autoInstall: false, checkedAt, message });
          return this.state;
        }
        const { newest, release: rel, asset, kind } = pick;
        const tag = newest.tag_name!;
        const sameRelease = this.state.latest?.tag === tag;
        this.asset = { tag: rel.tag_name!, file: asset };
        this.range = range;
        this.set({
          phase: sameRelease && keep ? "ready" : "available",
          installerPath: sameRelease ? keep : null,
          latest: {
            version: bare(tag),
            tag,
            notes: rangeNotes(range),
            since: range.since,
            publishedAt: newest.published_at ?? null,
            size: asset.size ?? null,
            kind,
            via: rel === newest ? null : bare(rel.tag_name!),
          },
          autoInstall: chained,
          checkedAt,
        });
        if (!sameRelease) {
          this.d.log(`Update: FORGE ${tag} ist verfügbar`);
          // Written right away, so it is ready when the update dialog asks for it.
          if (this.d.writeChangelog) this.changelog();
        }
        return this.state;
      } catch (e) {
        this.set({ phase: "error", message: e instanceof Error ? e.message : String(e), checkedAt: new Date().toISOString() });
        return this.state;
      } finally {
        this.checked = true;
      }
    });
  }

  /**
   * State of Claude's summary of the offered release. Starts writing it on the first call and returns
   * at once: while `writing`, the commit messages are already there and the caller asks again.
   * A summary that could not be written is tried again on the next call after it was reported.
   */
  changelog(): AppChangelog | null {
    const latest = this.state.latest;
    const range = this.range;
    if (!latest || !range) return null;
    let entry = this.changelogs.get(latest.tag);
    if (!entry) {
      entry = { state: { tag: latest.tag, status: "writing", text: null, commits: [], unavailable: null, message: null }, done: Promise.resolve() };
      const e = entry;
      e.done = this.writeChangelog(e, range).then((final) => {
        e.state = final;
      });
      this.changelogs.set(latest.tag, entry);
    }
    if (entry.state.status === "unavailable") this.changelogs.delete(latest.tag);
    return entry.state;
  }

  /** Resolves once the summary of the offered release is written or given up. */
  async changelogDone(): Promise<AppChangelog | null> {
    const tag = this.state.latest?.tag;
    const entry = tag ? this.changelogs.get(tag) : undefined;
    if (!entry) return null;
    await entry.done;
    return entry.state;
  }

  private async writeChangelog(entry: { state: AppChangelog }, range: ChangeRange): Promise<AppChangelog> {
    const tag = entry.state.tag;
    const t0 = Date.now();
    const ready = this.d.claudeReady?.() ?? Promise.resolve("no-claude" as const);
    const all = await this.commitsSince(range.sinceTag, tag);
    const commits = all.slice(-MAX_COMMITS);
    entry.state = { ...entry.state, commits };
    const base = { ...entry.state, text: null, message: null };
    try {
      const r = await ready;
      if (r !== "ok" || !this.d.writeChangelog) return { ...base, status: "unavailable", unavailable: r === "ok" ? "no-claude" : r };
      const text = (await this.d.writeChangelog(changelogPrompt(this.state.currentVersion, range, commits, all.length - commits.length))).trim();
      if (!text) throw new Error(tr().system.update.noText);
      this.d.log(`Update: Changelog für ${tag} in ${Date.now() - t0} ms geschrieben`);
      return { ...base, status: "ready", text, unavailable: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.d.log(`Update: Changelog für ${tag} nicht geschrieben nach ${Date.now() - t0} ms: ${message}`);
      return { ...base, status: "unavailable", unavailable: "error", message };
    }
  }

  /** First lines of the commits between two tags, oldest first; empty when the base tag is unknown (a local build). */
  private async commitsSince(base: string, tag: string): Promise<string[]> {
    return this.source.commits(base, tag).catch(() => []);
  }

  /**
   * True when this check finishes a two-step update the user started before the restart: the small
   * update of the version they chose is there now. Read once, so a failing step cannot loop.
   */
  private takeChain(pick: ReturnType<typeof pickRelease>): boolean {
    let target: string | null;
    try {
      target = (JSON.parse(readFileSync(this.chainFile, "utf8")) as { target?: string }).target ?? null;
    } catch {
      return false;
    }
    rmSync(this.chainFile, { force: true });
    return !!target && pick?.kind === "patch" && compareVersions(pick.newest.tag_name!, target) >= 0;
  }

  /** Fetches the installer of the offered release (or the full installer that goes first) and checks it (fetchSigned). */
  download(): Promise<AppUpdateState> {
    return this.once(async () => {
      const latest = this.state.latest;
      const asset = this.asset;
      if (!latest || !asset) {
        this.set({ phase: "error", message: tr().system.update.nothingToDownload });
        return this.state;
      }
      this.set({ phase: "downloading", message: null });
      const dir = path.join(updateDir(), latest.tag.replace(/[^\w.-]/g, "_"));
      try {
        // The full installer of a repair (FullInstallService) keeps its own folder.
        for (const entry of await readdir(updateDir()).catch(() => [] as string[])) {
          if (entry !== FULL_DIR) await rm(path.join(updateDir(), entry), { recursive: true, force: true });
        }
        await mkdir(dir, { recursive: true });
        const full = await fetchSigned(this.source, asset.file, dir, 15 * 60_000, this.d.publicKey);
        // Two steps: after the full installer, the next start picks up the small update by itself.
        if (latest.via) writeFileSync(this.chainFile, JSON.stringify({ target: latest.tag }));
        else rmSync(this.chainFile, { force: true });
        this.set({ phase: "ready", installerPath: full });
        this.d.log(`Update: Installer für ${asset.tag} bereit${latest.via ? `, danach ${latest.tag}` : ""}`);
        return this.state;
      } catch (e) {
        this.set({ phase: "error", message: e instanceof Error ? e.message : String(e) });
        return this.state;
      }
    });
  }
}

/** Runs the GitHub CLI without prompts; FORGE ships it, a system copy is the fallback. */
export async function runGh(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tool = resolveTool("gh");
  if (!tool) throw new Error("GitHub CLI fehlt in dieser Installation.");
  const r = await run(tool.path, args, { env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "", GH_NO_UPDATE_NOTIFIER: "1" }, timeoutMs });
  if (r.spawnError) throw r.spawnError;
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

export function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

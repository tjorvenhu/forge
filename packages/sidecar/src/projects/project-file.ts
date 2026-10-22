import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ForgeError } from "@forge/protocol";
import { tr } from "../i18n/index.js";

/**
 * Settings that belong to the code, not to the person: committed with the repository, so everyone
 * working on the project runs the same commands. Favorite, group, tags, profile and model stay
 * personal (database and sync).
 */
export const PROJECT_FILE = path.join(".forge", "project.json");
export const SHARED_KEYS = ["testCommand", "devCommand"] as const;
export type SharedKey = (typeof SHARED_KEYS)[number];
export type SharedConfig = Partial<Record<SharedKey, string | null>>;

type Raw = { data: Record<string, unknown> | null; broken: boolean };
/** Projects are listed often; the file is only read again when it changed on disk. */
const cache = new Map<string, { mtimeMs: number; size: number; raw: Raw }>();

function readRaw(root: string): Raw {
  const file = path.join(root, PROJECT_FILE);
  const s = statSync(file, { throwIfNoEntry: false });
  if (!s) {
    cache.delete(file);
    return { data: null, broken: false };
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit.raw;
  let raw: Raw = { data: null, broken: true };
  try {
    const j = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) raw = { data: j as Record<string, unknown>, broken: false };
  } catch {
    // A broken file (merge conflict, typo) leaves the local values in effect until it is fixed.
  }
  cache.set(file, { mtimeMs: s.mtimeMs, size: s.size, raw });
  return raw;
}

/** The shared values the repository sets; a key that is missing leaves the local value in effect. */
export function readProjectFile(root: string): SharedConfig {
  const { data } = readRaw(root);
  const out: SharedConfig = {};
  if (!data) return out;
  for (const k of SHARED_KEYS) {
    const v = data[k];
    if (v === null) out[k] = null;
    else if (typeof v === "string") out[k] = v.trim() || null;
  }
  return out;
}

/** Writes `patch` into the file, keeping every other key in it. */
export function writeProjectFile(root: string, patch: SharedConfig): void {
  const raw = readRaw(root);
  if (raw.broken) throw new ForgeError("VALIDATION", tr().system.projects.projectFileInvalid(PROJECT_FILE.replace(/\\/g, "/")));
  const file = path.join(root, PROJECT_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...raw.data, ...patch }, null, 2)}\n`, "utf8");
  cache.delete(file);
}

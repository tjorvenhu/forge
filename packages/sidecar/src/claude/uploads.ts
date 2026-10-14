import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { appendFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ForgeError, MAX_UPLOAD_BYTES } from "@forge/protocol";

/** Long enough for a session that is continued weeks later to still find its files. */
const KEEP_MS = 30 * 24 * 60 * 60_000;
const PRUNE_EVERY_MS = 60 * 60_000;
/** An upload that gets no further chunk for this long was abandoned (window closed, sidecar call failed). */
const STALE_MS = 10 * 60_000;
const MAX_NAME = 120;

interface PendingUpload {
  file: string;
  next: number;
  bytes: number;
  touched: number;
}

/** A file name that is valid on Windows and stays inside its folder. */
export function safeFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in Windows file names
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  const ext = path.extname(base).slice(0, 16);
  const stem = base.slice(0, base.length - path.extname(base).length).slice(0, MAX_NAME - ext.length) || "datei";
  return (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(stem) ? `_${stem}` : stem) + ext;
}

/**
 * Files Claude reads from disk instead of getting them inside the message: files pasted into the
 * composer (uploaded in chunks) and texts or attachments too large for one turn. Each file has a
 * folder of its own, so it keeps its original name.
 */
export class UploadStore {
  private readonly pending = new Map<string, PendingUpload>();
  private lastPrune = 0;

  constructor(
    readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {
    // Sessions get the folder as an additional directory; the CLI checks that it exists.
    mkdirSync(dir, { recursive: true });
  }

  /** One chunk of attachments.upload; the last one returns the path of the complete file. */
  async put(p: { uploadId: string; name: string; index: number; chunk: string; last: boolean }): Promise<{ path: string | null }> {
    let u = this.pending.get(p.uploadId);
    if (p.index === 0) {
      if (u) throw new ForgeError("VALIDATION", "Dieser Upload läuft bereits.");
      await this.prune();
      const folder = path.join(this.dir, p.uploadId);
      await mkdir(folder, { recursive: true });
      u = { file: path.join(folder, safeFileName(p.name)), next: 0, bytes: 0, touched: this.now() };
      await writeFile(u.file, "", { flag: "wx" });
      this.pending.set(p.uploadId, u);
    } else if (!u || u.next !== p.index) {
      throw new ForgeError("VALIDATION", "Upload unvollständig. Bitte die Datei erneut einfügen.");
    }
    const data = Buffer.from(p.chunk, "base64");
    u.bytes += data.length;
    if (u.bytes > MAX_UPLOAD_BYTES) {
      this.pending.delete(p.uploadId);
      await rm(path.dirname(u.file), { recursive: true, force: true });
      throw new ForgeError("VALIDATION", `${path.basename(u.file)} ist größer als ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    }
    await appendFile(u.file, data);
    u.next++;
    u.touched = this.now();
    if (!p.last) return { path: null };
    this.pending.delete(p.uploadId);
    return { path: u.file };
  }

  /** Stores content that does not fit into a message and returns its path. */
  async write(name: string, data: Buffer | string): Promise<string> {
    await this.prune();
    const folder = path.join(this.dir, randomUUID());
    await mkdir(folder, { recursive: true });
    const file = path.join(folder, safeFileName(name));
    await writeFile(file, data);
    return file;
  }

  /** Drops old files and abandoned uploads; runs at most once an hour. */
  private async prune() {
    const now = this.now();
    for (const [id, u] of this.pending) {
      if (now - u.touched < STALE_MS) continue;
      this.pending.delete(id);
      await rm(path.dirname(u.file), { recursive: true, force: true }).catch(() => {});
    }
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const names = await readdir(this.dir).catch(() => [] as string[]);
    for (const name of names) {
      if (this.pending.has(name)) continue;
      const folder = path.join(this.dir, name);
      const s = await stat(folder).catch(() => null);
      if (s && now - s.mtimeMs > KEEP_MS) await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
}

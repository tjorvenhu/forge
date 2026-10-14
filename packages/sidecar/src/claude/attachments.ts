import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type Attachment, type AttachmentMeta } from "@forge/protocol";
import { isSensitivePath } from "../policy/guard.js";

const MAX_TEXT = 512 * 1024;
/** Claude API: at most 5 MB per image, counted on the base64 form (3.7 MB raw stay below it). */
const MAX_IMAGE_BYTES = 3_700_000;
/** Claude API: longer sides are refused. */
const MAX_IMAGE_EDGE = 8000;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
/** Everything placed inside one message together; a request to the API may not exceed 32 MB. */
const MAX_TOTAL = 20 * 1024 * 1024;
/** JPEG keeps its size behind the EXIF block, which may hold a thumbnail of its own. */
const HEADER_BYTES = 512 * 1024;

/** Message texts up to this length go to Claude unchanged (roughly 25,000 to 50,000 tokens). */
export const MAX_INLINE_TEXT = 100_000;
const EXCERPT_HEAD = 30_000;
const EXCERPT_TAIL = 10_000;

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Content blocks in Messages API shape (image, document, text). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string }; title?: string };

/** Stores content that is too large for a message and returns the path Claude reads it from. */
export type Spill = (name: string, data: Buffer | string) => Promise<string>;

interface Source {
  name: string;
  mediaType: string;
  size: number;
  /** file on disk; null for data sent along with the message */
  path: string | null;
  data: Buffer | null;
}

async function load(a: Attachment): Promise<Source> {
  if (a.kind === "data") {
    const data = Buffer.from(a.base64, "base64");
    return { name: a.name, mediaType: a.mediaType, size: data.length, path: null, data };
  }
  if (isSensitivePath(a.path)) throw new ForgeError("POLICY_DENIED", `Diese Datei darf nicht angehängt werden: ${a.path}`);
  let s;
  try {
    s = await stat(a.path);
  } catch {
    throw new ForgeError("PATH_INVALID", `Datei nicht gefunden: ${a.path}`);
  }
  if (!s.isFile()) throw new ForgeError("PATH_INVALID", `Keine Datei: ${a.path}`);
  const ext = path.extname(a.path).toLowerCase();
  const mediaType = IMAGE_TYPES[ext] ?? (ext === ".pdf" ? "application/pdf" : "text/plain");
  return { name: path.basename(a.path), mediaType, size: s.size, path: a.path, data: null };
}

async function head(src: Source, bytes: number): Promise<Buffer> {
  if (src.data) return src.data.subarray(0, bytes);
  const fh = await open(src.path!, "r");
  try {
    const buf = Buffer.alloc(Math.min(bytes, src.size));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Width and height from the header of a PNG, GIF, WebP or JPEG; null when it cannot be read. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR") {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("latin1", 0, 4) === "GIF8") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const chunk = b.toString("latin1", 12, 16);
    if (chunk === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L") {
      const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (chunk === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Start of frame (baseline, progressive, ...); C4, C8 and CC are other tables.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function referenceBlock(src: Source, file: string): ContentBlock {
  const how = src.mediaType.startsWith("image/")
    ? "Sieh es dir bei Bedarf mit dem Read-Werkzeug an, es verkleinert Bilder dabei."
    : src.mediaType === "application/pdf"
      ? "Lies sie bei Bedarf mit dem Read-Werkzeug, bei vielen Seiten abschnittsweise mit dem Parameter pages."
      : "Lies sie bei Bedarf mit dem Read-Werkzeug, bei großen Dateien abschnittsweise mit offset und limit.";
  return { type: "text", text: `Angehängte Datei: ${src.name} (${formatSize(src.size)}), zu groß für die Nachricht selbst. Sie liegt unter ${file}\n${how}` };
}

/** Whether the file goes inside the message; otherwise Claude gets its path. Binary text files are refused. */
async function fitsInline(src: Source, room: number): Promise<boolean> {
  if (src.mediaType.startsWith("image/")) {
    if (!Object.values(IMAGE_TYPES).includes(src.mediaType)) throw new ForgeError("VALIDATION", `Bildformat nicht unterstützt: ${src.name}`);
    if (src.size > MAX_IMAGE_BYTES || src.size > room) return false;
    const dim = imageSize(await head(src, HEADER_BYTES));
    return !dim || Math.max(dim.width, dim.height) <= MAX_IMAGE_EDGE;
  }
  if (src.mediaType === "application/pdf") return src.size <= MAX_PDF_BYTES && src.size <= room;
  if ((await head(src, 8000)).includes(0)) throw new ForgeError("VALIDATION", `${src.name}: Binärdateien können nur als Bild oder PDF angehängt werden.`);
  return src.size <= MAX_TEXT && src.size <= room;
}

async function inlineBlock(src: Source): Promise<ContentBlock> {
  const data = src.data ?? (await readFile(src.path!));
  if (src.mediaType.startsWith("image/")) return { type: "image", source: { type: "base64", media_type: src.mediaType, data: data.toString("base64") } };
  if (src.mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title: src.name };
  }
  const fence = "```";
  return { type: "text", text: `Angehängte Datei: ${src.name}\n${fence}\n${data.toString("utf8")}\n${fence}` };
}

/** The image blocks of one message in a Claude Code transcript, in the order they were sent; null when the message is not in it. */
export function transcriptImages(messages: unknown[], uuid: string): Array<{ mediaType: string; base64: string }> | null {
  const m = (messages as Array<Record<string, unknown> | null>).find((x) => x?.uuid === uuid);
  if (!m) return null;
  const content = (m.message as Record<string, unknown> | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const images: Array<{ mediaType: string; base64: string }> = [];
  for (const b of content as Array<Record<string, unknown> | null>) {
    if (b?.type !== "image") continue;
    const src = (b.source ?? {}) as Record<string, unknown>;
    if (src.type === "base64" && typeof src.data === "string" && typeof src.media_type === "string") images.push({ mediaType: src.media_type, base64: src.data });
  }
  return images;
}

/**
 * Loads attachments and returns content blocks plus metadata for the timeline. What the API would
 * refuse inside a message (too large, too many pixels, over the total) goes to Claude as a path:
 * files from disk keep theirs, sent data is stored via `spill` first.
 */
export async function buildAttachmentBlocks(list: Attachment[], spill: Spill): Promise<{ blocks: ContentBlock[]; meta: AttachmentMeta[] }> {
  const blocks: ContentBlock[] = [];
  const meta: AttachmentMeta[] = [];
  let total = 0;
  for (const a of list) {
    const src = await load(a);
    if (await fitsInline(src, MAX_TOTAL - total)) {
      total += src.size;
      blocks.push(await inlineBlock(src));
    } else {
      blocks.push(referenceBlock(src, src.path ?? (await spill(src.name, src.data!))));
    }
    meta.push({ name: src.name, mediaType: src.mediaType, size: src.size });
  }
  return { blocks, meta };
}

/** Index near `i` that does not split a surrogate pair. */
function cut(text: string, i: number): number {
  const c = text.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i - 1 : i;
}

/**
 * A message text longer than MAX_INLINE_TEXT is stored as a file. Claude gets its start and end plus the
 * path, so the instruction around a pasted log stays in view and nothing is lost without a note.
 */
export async function fitMessageText(text: string, spill: Spill): Promise<string> {
  if (text.length <= MAX_INLINE_TEXT) return text;
  const file = await spill("nachricht.txt", text);
  const headEnd = cut(text, EXCERPT_HEAD);
  const tailStart = cut(text, text.length - EXCERPT_TAIL);
  const n = (v: number) => v.toLocaleString("de-DE");
  const note = `[… ${n(tailStart - headEnd)} Zeichen ausgelassen. Die Nachricht hat ${n(text.length)} Zeichen und ist zu lang für eine Eingabe. Der vollständige Text steht in ${file}. Lies ihn bei Bedarf mit dem Read-Werkzeug, abschnittsweise mit offset und limit.]`;
  return `${text.slice(0, headEnd)}\n\n${note}\n\n${text.slice(tailStart)}`;
}

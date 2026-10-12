import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ForgeError, type Attachment, type AttachmentMeta } from "@forge/protocol";
import { isSensitivePath } from "../policy/guard.js";

const MAX_FILE = 10 * 1024 * 1024;
const MAX_TOTAL = 20 * 1024 * 1024;
const MAX_TEXT = 512 * 1024;

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

interface Loaded {
  name: string;
  mediaType: string;
  data: Buffer;
}

async function load(a: Attachment): Promise<Loaded> {
  if (a.kind === "data") {
    const data = Buffer.from(a.base64, "base64");
    return { name: a.name, mediaType: a.mediaType, data };
  }
  if (isSensitivePath(a.path)) throw new ForgeError("POLICY_DENIED", `Diese Datei darf nicht angehängt werden: ${a.path}`);
  let s;
  try {
    s = await stat(a.path);
  } catch {
    throw new ForgeError("PATH_INVALID", `Datei nicht gefunden: ${a.path}`);
  }
  if (!s.isFile()) throw new ForgeError("PATH_INVALID", `Keine Datei: ${a.path}`);
  if (s.size > MAX_FILE) throw new ForgeError("VALIDATION", `${path.basename(a.path)} ist größer als 10 MB.`);
  const ext = path.extname(a.path).toLowerCase();
  const mediaType = IMAGE_TYPES[ext] ?? (ext === ".pdf" ? "application/pdf" : "text/plain");
  return { name: path.basename(a.path), mediaType, data: await readFile(a.path) };
}

function toBlock(f: Loaded): ContentBlock {
  if (f.mediaType.startsWith("image/")) {
    if (!Object.values(IMAGE_TYPES).includes(f.mediaType)) throw new ForgeError("VALIDATION", `Bildformat nicht unterstützt: ${f.name}`);
    return { type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data.toString("base64") } };
  }
  if (f.mediaType === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data.toString("base64") }, title: f.name };
  }
  if (f.data.subarray(0, 8000).includes(0)) throw new ForgeError("VALIDATION", `${f.name}: Binärdateien können nur als Bild oder PDF angehängt werden.`);
  if (f.data.length > MAX_TEXT) throw new ForgeError("VALIDATION", `${f.name}: Textdateien bis 512 KB.`);
  const fence = "```";
  return { type: "text", text: `Angehängte Datei: ${f.name}\n${fence}\n${f.data.toString("utf8")}\n${fence}` };
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

/** Loads and validates attachments; returns content blocks plus metadata for the timeline. */
export async function buildAttachmentBlocks(list: Attachment[]): Promise<{ blocks: ContentBlock[]; meta: AttachmentMeta[] }> {
  const blocks: ContentBlock[] = [];
  const meta: AttachmentMeta[] = [];
  let total = 0;
  for (const a of list) {
    const f = await load(a);
    total += f.data.length;
    if (total > MAX_TOTAL) throw new ForgeError("VALIDATION", "Anhänge zusammen größer als 20 MB.");
    blocks.push(toBlock(f));
    meta.push({ name: f.name, mediaType: f.mediaType, size: f.data.length });
  }
  return { blocks, meta };
}

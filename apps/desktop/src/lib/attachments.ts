import { MAX_UPLOAD_BYTES, UPLOAD_CHUNK_CHARS } from "@forge/protocol";
import { call } from "@/lib/queries";
import { t } from "@/i18n";

/**
 * Long side of a pasted image. More pixels do not help Claude (the API scales larger images down), and
 * once a conversation holds more than 20 images the API refuses every one over 2000 px.
 */
export const MAX_IMAGE_EDGE = 2000;
/** The API takes 5 MB per image as base64; kept well below, Claude Code sends every image again each turn. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** Formats the API takes; anything else the webview can decode is converted. */
const API_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
/** Sources without loss, worth a PNG attempt first: text in screenshots stays sharp. */
const LOSSLESS = ["image/png", "image/gif", "image/bmp"];
const QUALITIES = [0.9, 0.8, 0.7];
const MAX_ROUNDS = 6;

export type EncodeType = "image/png" | "image/webp";
/** Draws the image at the given size and encodes it. */
export type Encoder = (width: number, height: number, type: EncodeType, quality?: number) => Promise<Blob>;

/** Size to scale a pasted image to; null when it can go as it is. */
export function targetSize(img: { width: number; height: number; bytes: number; type: string }): { width: number; height: number } | null {
  const edge = Math.max(img.width, img.height);
  if (edge <= MAX_IMAGE_EDGE && img.bytes <= MAX_IMAGE_BYTES && API_TYPES.includes(img.type)) return null;
  const scale = Math.min(1, MAX_IMAGE_EDGE / edge);
  return { width: Math.max(1, Math.round(img.width * scale)), height: Math.max(1, Math.round(img.height * scale)) };
}

/** Encodes until the result is at most MAX_IMAGE_BYTES: PNG for lossless sources, then WebP at falling quality, then fewer pixels. */
export async function encodeToFit(size: { width: number; height: number }, sourceType: string, encode: Encoder): Promise<Blob> {
  let { width, height } = size;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (round === 0 && LOSSLESS.includes(sourceType)) {
      const png = await encode(width, height, "image/png");
      if (png.size <= MAX_IMAGE_BYTES) return png;
    }
    for (const q of QUALITIES) {
      const b = await encode(width, height, "image/webp", q);
      if (b.size <= MAX_IMAGE_BYTES) return b;
    }
    width = Math.max(1, Math.round(width * 0.75));
    height = Math.max(1, Math.round(height * 0.75));
  }
  throw new Error(t.lib.attachments.notSmallEnough);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t.lib.attachments.notSaved))), type, quality));
}

function canvasEncoder(image: ImageBitmap): Encoder {
  return async (width, height, type, quality) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error(t.lib.attachments.notResized);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await toBlob(canvas, type, quality);
    if (blob.type === type) return blob;
    // A webview without WebP returns PNG instead; JPEG has no transparency, so it gets a white background.
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    return toBlob(canvas, "image/jpeg", quality);
  };
}

const EXT: Record<string, string> = { "image/png": ".png", "image/webp": ".webp", "image/jpeg": ".jpg" };

export function withExtension(name: string, type: string): string {
  const ext = EXT[type];
  if (!ext) return name;
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name) + ext;
}

/** A pasted image the API takes as it is, or a smaller copy of it. */
export async function prepareImage(file: Blob, name: string): Promise<{ blob: Blob; name: string }> {
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    if (API_TYPES.includes(file.type) && file.size <= MAX_IMAGE_BYTES) return { blob: file, name };
    throw new Error(t.lib.attachments.notRead);
  }
  try {
    const target = targetSize({ width: image.width, height: image.height, bytes: file.size, type: file.type });
    if (!target) return { blob: file, name };
    const blob = await encodeToFit(target, file.type, canvasEncoder(image));
    return { blob, name: withExtension(name, blob.type) };
  } finally {
    image.close();
  }
}

/** Raw bytes per upload call; their base64 form is exactly one chunk. */
const CHUNK_BYTES = (UPLOAD_CHUNK_CHARS / 4) * 3;

function readBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error(t.lib.attachments.readError));
    r.readAsDataURL(blob);
  });
}

/** Uploads a file in chunks to the sidecar; returns the path it is stored under. */
export async function uploadFile(blob: Blob, name: string): Promise<string> {
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error(t.lib.attachments.tooLarge(MAX_UPLOAD_BYTES / 1024 / 1024));
  const uploadId = crypto.randomUUID();
  let index = 0;
  for (let start = 0; ; start += CHUNK_BYTES) {
    const last = start + CHUNK_BYTES >= blob.size;
    const chunk = await readBase64(blob.slice(start, start + CHUNK_BYTES));
    const { path } = await call("attachments.upload", { uploadId, name, index: index++, chunk, last });
    if (last) {
      if (!path) throw new Error(t.lib.attachments.uploadIncomplete);
      return path;
    }
  }
}

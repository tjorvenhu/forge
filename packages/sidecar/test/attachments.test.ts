import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "@forge/protocol";
import { buildAttachmentBlocks, fitMessageText, imageSize, MAX_INLINE_TEXT } from "../src/claude/attachments.js";
import { safeFileName, UploadStore } from "../src/claude/uploads.js";
import { tempDir } from "./helpers.js";

let t: ReturnType<typeof tempDir>;
let store: UploadStore;
beforeEach(() => {
  t = tempDir();
  store = new UploadStore(path.join(t.dir, "uploads"));
});
afterEach(() => t.cleanup());

const spill = (name: string, data: Buffer | string) => store.write(name, data);

function png(width: number, height: number, size = 64): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const data = (name: string, mediaType: string, buf: Buffer) => ({ kind: "data" as const, name, mediaType, base64: buf.toString("base64") });
const textOf = (b: { type: string; text?: string }) => (b.type === "text" ? b.text! : "");

describe("imageSize", () => {
  it("reads PNG, GIF, WebP and JPEG headers", () => {
    expect(imageSize(png(3000, 9001))).toEqual({ width: 3000, height: 9001 });
    const gif = Buffer.alloc(16);
    gif.write("GIF89a", 0, "latin1");
    gif.writeUInt16LE(640, 6);
    gif.writeUInt16LE(480, 8);
    expect(imageSize(gif)).toEqual({ width: 640, height: 480 });
    const webp = Buffer.alloc(32);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBPVP8X", 8, "latin1");
    webp.writeUIntLE(1919, 24, 3);
    webp.writeUIntLE(1079, 27, 3);
    expect(imageSize(webp)).toEqual({ width: 1920, height: 1080 });
    // SOI, an APP0 segment, then a baseline frame header
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(Buffer.from("kein Bild"))).toBeNull();
  });
});

describe("buildAttachmentBlocks", () => {
  it("puts small files into the message", async () => {
    const r = await buildAttachmentBlocks([data("a.txt", "text/plain", Buffer.from("hallo")), data("b.png", "image/png", png(100, 100))], spill);
    expect(textOf(r.blocks[0]!)).toContain("hallo");
    expect(r.blocks[1]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    expect(r.meta.map((m) => m.name)).toEqual(["a.txt", "b.png"]);
  });

  it("stores sent data that is too large and hands Claude the path", async () => {
    const log = Buffer.from("x".repeat(600 * 1024));
    const big = png(1000, 1000, 4_000_000);
    const tall = png(1200, 9000);
    const r = await buildAttachmentBlocks([data("log.txt", "text/plain", log), data("big.png", "image/png", big), data("tall.png", "image/png", tall)], spill);
    expect(r.blocks.every((b) => b.type === "text")).toBe(true);
    for (const [i, name] of ["log.txt", "big.png", "tall.png"].entries()) {
      const file = /liegt unter (.+)\n/.exec(textOf(r.blocks[i]!))![1]!;
      expect(path.basename(file)).toBe(name);
      expect(file.startsWith(store.dir)).toBe(true);
    }
    expect(readFileSync(/liegt unter (.+)\n/.exec(textOf(r.blocks[0]!))![1]!)).toEqual(log);
    expect(r.meta[1]).toMatchObject({ name: "big.png", mediaType: "image/png", size: 4_000_000 });
  });

  it("names a large file from disk by its own path without reading it into the message", async () => {
    const file = path.join(t.dir, "riesig.log");
    writeFileSync(file, "zeile\n".repeat(300_000));
    const r = await buildAttachmentBlocks([{ kind: "path", path: file }], spill);
    expect(textOf(r.blocks[0]!)).toContain(`liegt unter ${file}\n`);
    expect(textOf(r.blocks[0]!)).not.toContain("zeile");
  });

  it("refers to files by path once the message holds 20 MB", async () => {
    const pdf = (n: number) => data(`${n}.pdf`, "application/pdf", Buffer.alloc(8 * 1024 * 1024, n));
    const r = await buildAttachmentBlocks([pdf(1), pdf(2), pdf(3)], spill);
    expect(r.blocks.map((b) => b.type)).toEqual(["document", "document", "text"]);
  });

  it("still refuses binary files that are neither image nor PDF", async () => {
    await expect(buildAttachmentBlocks([data("a.bin", "application/octet-stream", Buffer.from([1, 0, 2]))], spill)).rejects.toThrow(/Binärdateien/);
  });
});

describe("fitMessageText", () => {
  it("keeps normal texts and stores long ones with start, end and path", async () => {
    expect(await fitMessageText("kurz", spill)).toBe("kurz");
    const long = "Anfang " + "y".repeat(MAX_INLINE_TEXT) + " Schluss";
    const fitted = await fitMessageText(long, spill);
    expect(fitted.startsWith("Anfang ")).toBe(true);
    expect(fitted.endsWith(" Schluss")).toBe(true);
    expect(fitted).toMatch(/Die Nachricht hat 100\.015 Zeichen/);
    expect(readFileSync(/steht in (.+?)\. Lies/.exec(fitted)![1]!, "utf8")).toBe(long);
  });

  it("does not split a character made of two UTF-16 units", async () => {
    const fitted = await fitMessageText("😀".repeat(MAX_INLINE_TEXT), spill);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("UploadStore", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("puts the chunks together in order and keeps the name", async () => {
    expect(await store.put({ uploadId: id, name: "bild.png", index: 0, chunk: Buffer.from("abc").toString("base64"), last: false })).toEqual({ path: null });
    const { path: file } = await store.put({ uploadId: id, name: "bild.png", index: 1, chunk: Buffer.from("def").toString("base64"), last: true });
    expect(path.basename(file!)).toBe("bild.png");
    expect(readFileSync(file!, "utf8")).toBe("abcdef");
  });

  it("refuses chunks out of order and uploads over the limit", async () => {
    await expect(store.put({ uploadId: id, name: "a", index: 1, chunk: "", last: true })).rejects.toThrow(/unvollständig/);
    const mb = Buffer.alloc(1024 * 1024).toString("base64");
    let index = 0;
    const upload = async () => {
      for (;;) await store.put({ uploadId: id, name: "a.bin", index: index++, chunk: mb, last: false });
    };
    await expect(upload()).rejects.toThrow(/größer als/);
    expect(index).toBe(MAX_UPLOAD_BYTES / 1024 / 1024 + 1);
  });

  it("makes file names safe for Windows", () => {
    expect(safeFileName("..\\..\\böse:name?.txt")).toBe("böse_name_.txt");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName("")).toBe("datei");
  });
});

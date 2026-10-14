import { beforeEach, describe, expect, it, vi } from "vitest";
import { UPLOAD_CHUNK_CHARS } from "@forge/protocol";
import type * as RpcModuleNs from "@/lib/rpc";

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({
  ...(await orig<typeof RpcModuleNs>()),
  rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} },
}));

const { MAX_IMAGE_BYTES, encodeToFit, targetSize, uploadFile, withExtension } = await import("./attachments");

describe("targetSize", () => {
  it("keeps images the API takes as they are", () => {
    expect(targetSize({ width: 1920, height: 1080, bytes: 900_000, type: "image/png" })).toBeNull();
  });

  it("scales the long side down to 2000 px", () => {
    expect(targetSize({ width: 3840, height: 2160, bytes: 900_000, type: "image/png" })).toEqual({ width: 2000, height: 1125 });
    expect(targetSize({ width: 1200, height: 9000, bytes: 500_000, type: "image/jpeg" })).toEqual({ width: 267, height: 2000 });
  });

  it("re-encodes small images that are too heavy or in a format the API does not take", () => {
    expect(targetSize({ width: 1800, height: 1800, bytes: MAX_IMAGE_BYTES + 1, type: "image/png" })).toEqual({ width: 1800, height: 1800 });
    expect(targetSize({ width: 800, height: 600, bytes: 10_000, type: "image/bmp" })).toEqual({ width: 800, height: 600 });
  });
});

describe("encodeToFit", () => {
  /** Encoder whose output shrinks with pixels and quality, PNG twice as big as WebP at quality 1. */
  const fake = (bytesPerPixel: number) => {
    const calls: string[] = [];
    const encode = vi.fn(async (w: number, h: number, type: string, q = 1) => {
      calls.push(`${type}@${w}x${h}${q === 1 ? "" : `:${q}`}`);
      const size = Math.round(w * h * bytesPerPixel * (type === "image/png" ? 2 : q));
      return { size, type } as Blob;
    });
    return { encode, calls };
  };

  it("takes the PNG of a screenshot when it fits", async () => {
    const { encode, calls } = fake(0.2);
    const b = await encodeToFit({ width: 2000, height: 1125 }, "image/png", encode);
    expect(b.type).toBe("image/png");
    expect(calls).toEqual(["image/png@2000x1125"]);
  });

  it("goes to WebP and then to fewer pixels until the image fits", async () => {
    const { encode, calls } = fake(1);
    const b = await encodeToFit({ width: 2000, height: 2000 }, "image/png", encode);
    expect(b.size).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(b.type).toBe("image/webp");
    expect(calls).toEqual(["image/png@2000x2000", "image/webp@2000x2000:0.9", "image/webp@2000x2000:0.8", "image/webp@2000x2000:0.7", "image/webp@1500x1500:0.9"]);
  });

  it("skips PNG for photos", async () => {
    const { encode, calls } = fake(0.5);
    await encodeToFit({ width: 2000, height: 1500 }, "image/jpeg", encode);
    expect(calls[0]).toBe("image/webp@2000x1500:0.9");
  });
});

describe("withExtension", () => {
  it("names the file after its new format", () => {
    expect(withExtension("screenshot.png", "image/webp")).toBe("screenshot.webp");
    expect(withExtension("einfuegung", "image/jpeg")).toBe("einfuegung.jpg");
    expect(withExtension("a.png", "image/png")).toBe("a.png");
  });
});

describe("uploadFile", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("sends the file in chunks and returns the stored path", async () => {
    const bytes = new Uint8Array((UPLOAD_CHUNK_CHARS / 4) * 3 * 2 + 10).fill(65);
    callMock.mockImplementation(async (_m: string, p: { last: boolean }) => ({ path: p.last ? "C:\\uploads\\x\\a.bin" : null }));
    expect(await uploadFile(new Blob([bytes]), "a.bin")).toBe("C:\\uploads\\x\\a.bin");
    const params = callMock.mock.calls.map((c) => c[1] as { uploadId: string; index: number; chunk: string; last: boolean });
    expect(callMock.mock.calls.every((c) => c[0] === "attachments.upload")).toBe(true);
    expect(params.map((p) => [p.index, p.last])).toEqual([
      [0, false],
      [1, false],
      [2, true],
    ]);
    expect(new Set(params.map((p) => p.uploadId)).size).toBe(1);
    expect(params[0]!.chunk.length).toBe(UPLOAD_CHUNK_CHARS);
    expect(atob(params.map((p) => p.chunk).join("")).length).toBe(bytes.length);
  });

  it("sends an empty file as one chunk", async () => {
    callMock.mockResolvedValue({ path: "C:\\uploads\\y\\leer.txt" });
    expect(await uploadFile(new Blob([]), "leer.txt")).toBe("C:\\uploads\\y\\leer.txt");
    expect(callMock).toHaveBeenCalledTimes(1);
  });
});

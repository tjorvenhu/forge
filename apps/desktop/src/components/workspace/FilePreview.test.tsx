import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as RpcModuleNs from "@/lib/rpc";

type RpcModule = typeof RpcModuleNs;

const callMock = vi.fn();
vi.mock("@/lib/rpc", async (orig) => ({ ...(await orig<RpcModule>()), rpc: { call: (...a: unknown[]) => callMock(...a), subscribe: () => () => {} } }));

const { MediaPreview, mediaType, formatBytes } = await import("./FilePreview");

const blobs: Blob[] = [];
beforeEach(() => {
  blobs.length = 0;
  callMock.mockReset();
  URL.createObjectURL = vi.fn((b: Blob) => {
    blobs.push(b);
    return `blob:test/${blobs.length}`;
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("mediaType", () => {
  it("picks images, PDFs and media by extension, case-insensitive", () => {
    expect(mediaType("docs/Bild.PNG")).toEqual({ kind: "image", mime: "image/png" });
    expect(mediaType("a/b.pdf")).toEqual({ kind: "pdf", mime: "application/pdf" });
    expect(mediaType("x.mp4")?.kind).toBe("video");
    expect(mediaType("x.mp3")?.kind).toBe("audio");
    expect(mediaType("x.zip")).toBeNull();
    expect(mediaType("README")).toBeNull();
  });

  it("formats sizes in German", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(250 * 1024 * 1024)).toBe("250 MB");
  });
});

describe("MediaPreview", () => {
  it("reads the file in chunks and shows it as an image", async () => {
    callMock.mockImplementation((_m: string, p: { offset: number }) => Promise.resolve(p.offset === 0 ? { size: 5, base64: btoa("abc") } : { size: 5, base64: btoa("de") }));
    render(<MediaPreview projectId="p1" path="bild.png" kind="image" mime="image/png" />);
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toBe("blob:test/1");
    expect(callMock.mock.calls.map((c) => (c[1] as { offset: number }).offset)).toEqual([0, 3]);
    expect(blobs[0]!.size).toBe(5);
    expect(blobs[0]!.type).toBe("image/png");
    expect(screen.getByText("5 B")).toBeTruthy();
  });

  it("shows a PDF in a frame and frees the object URL when closed", async () => {
    callMock.mockResolvedValue({ size: 3, base64: btoa("pdf") });
    const { unmount } = render(<MediaPreview projectId="p1" path="doc.pdf" kind="pdf" mime="application/pdf" />);
    await waitFor(() => expect(screen.getByTitle("doc.pdf").getAttribute("src")).toBe("blob:test/1"));
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test/1");
  });

  it("shows the sidecar error, e.g. for files that are too large", async () => {
    callMock.mockRejectedValue(new Error("Datei zu groß für die Vorschau (über 200 MB)."));
    render(<MediaPreview projectId="p1" path="film.mp4" kind="video" mime="video/mp4" />);
    expect(await screen.findByText(/zu groß/)).toBeTruthy();
  });
});

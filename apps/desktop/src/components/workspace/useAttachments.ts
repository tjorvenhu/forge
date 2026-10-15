import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "@/stores/toast";
import { NO_FILES, useDrafts, type PendingFile } from "@/stores/drafts";
import { prepareImage, uploadFile } from "@/lib/attachments";
import { errorMessage } from "@/lib/rpc";

export const MAX_ATTACHMENTS = 10;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const PASTE_EXT: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "application/pdf": ".pdf" };

/** A pasted file on its way to the sidecar; shown as a placeholder chip. */
export interface PreparingFile {
  id: string;
  name: string;
  isImage: boolean;
}

/** Name for a pasted file without one; the sidecar takes the type from the extension, so it matches the content. */
export function pastedName(f: File, base = "einfuegung"): string {
  return f.name || `${base}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${PASTE_EXT[f.type] ?? ".txt"}`;
}

/**
 * A pasted file uploaded to the sidecar, images first scaled down to what the API takes. The draft
 * then holds only a path: no protocol line and no chat window move carries the content.
 */
export async function uploadPasted(f: File, name: string, id: string = crypto.randomUUID()): Promise<PendingFile> {
  const isImage = f.type.startsWith("image/");
  const { blob, name: stored } = isImage ? await prepareImage(f, name) : { blob: f, name };
  const path = await uploadFile(blob, stored);
  return { id, name: stored, attachment: { kind: "path", path }, preview: isImage ? URL.createObjectURL(blob) : null, isImage };
}

/** Attachments of one composer draft: file picker, native drag and drop and pasted files. */
export function useAttachments(draftKey: string) {
  const files = useDrafts((s) => s.drafts[draftKey]?.files ?? NO_FILES);
  const setFiles = useCallback((fn: (cur: PendingFile[]) => PendingFile[]) => useDrafts.getState().updateFiles(draftKey, fn), [draftKey]);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState<PreparingFile[]>([]);
  const running = useRef(new Set<Promise<void>>());

  const addPaths = useCallback(
    (paths: string[]) => {
      setFiles((cur) => {
        const room = MAX_ATTACHMENTS - cur.length;
        if (paths.length > room) toast.info(`Höchstens ${MAX_ATTACHMENTS} Anhänge`);
        const add = paths.slice(0, Math.max(0, room)).map((p) => ({
          id: crypto.randomUUID(),
          name: p.split(/[\\/]/).pop() ?? p,
          attachment: { kind: "path" as const, path: p },
          preview: null,
          isImage: IMAGE_EXT.test(p),
        }));
        return [...cur, ...add];
      });
    },
    [setFiles],
  );

  /** Pasted files go to the sidecar right away (uploadPasted). */
  const addBlob = async (f: File) => {
    const id = crypto.randomUUID();
    const name = pastedName(f);
    setPreparing((p) => [...p, { id, name, isImage: f.type.startsWith("image/") }]);
    try {
      const file = await uploadPasted(f, name, id);
      setFiles((cur) => [...cur, file]);
    } catch (e) {
      toast.error("Anhang nicht hinzugefügt", `${name}: ${errorMessage(e)}`);
    } finally {
      setPreparing((p) => p.filter((x) => x.id !== id));
    }
  };

  const addBlobs = async (list: File[]) => {
    const room = MAX_ATTACHMENTS - files.length - preparing.length;
    if (list.length > room) toast.info(`Höchstens ${MAX_ATTACHMENTS} Anhänge`);
    const jobs = list.slice(0, Math.max(0, room)).map((f) => {
      const job = addBlob(f).finally(() => running.current.delete(job));
      running.current.add(job);
      return job;
    });
    await Promise.all(jobs);
  };

  /** The draft's attachments once every pasted file is uploaded; sending waits for it. */
  const settled = useCallback(async () => {
    await Promise.all([...running.current]);
    return useDrafts.getState().drafts[draftKey]?.files ?? NO_FILES;
  }, [draftKey]);

  const remove = (f: PendingFile) => {
    if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles((cur) => cur.filter((x) => x.id !== f.id));
  };

  // Native drag and drop (Tauri delivers real file paths).
  useEffect(() => {
    // The listener arrives asynchronously; when cleanup ran first it is removed right away.
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type === "over" || e.payload.type === "enter") setDragging(true);
        else if (e.payload.type === "leave") setDragging(false);
        else if (e.payload.type === "drop") {
          setDragging(false);
          addPaths(e.payload.paths);
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addPaths]);

  const pick = async () => {
    const r = await open({
      multiple: true,
      title: "Dateien anhängen",
      filters: [
        { name: "Bilder, PDF, Text", extensions: ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "json", "csv", "log", "ts", "tsx", "js", "py", "rs", "go", "java", "cs", "html", "css", "yaml", "yml", "toml", "xml", "sql"] },
        { name: "Alle Dateien", extensions: ["*"] },
      ],
    });
    if (Array.isArray(r)) addPaths(r);
    else if (typeof r === "string") addPaths([r]);
  };

  return { files, preparing, dragging, addBlobs, settled, remove, pick, full: files.length + preparing.length >= MAX_ATTACHMENTS };
}

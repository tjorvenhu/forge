import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { toast } from "@/stores/toast";
import { NO_FILES, useDrafts, type PendingFile } from "@/stores/drafts";

export const MAX_ATTACHMENTS = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error ?? new Error("Lesefehler"));
    r.readAsDataURL(file);
  });
}

/** Attachments of one composer draft: file picker, native drag and drop and pasted files. */
export function useAttachments(draftKey: string) {
  const files = useDrafts((s) => s.drafts[draftKey]?.files ?? NO_FILES);
  const setFiles = useCallback((fn: (cur: PendingFile[]) => PendingFile[]) => useDrafts.getState().updateFiles(draftKey, fn), [draftKey]);
  const [dragging, setDragging] = useState(false);

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

  const addBlobs = async (list: File[]) => {
    for (const f of list.slice(0, MAX_ATTACHMENTS - files.length)) {
      if (f.size > MAX_BYTES) {
        toast.error("Datei zu groß", `${f.name || "Einfügung"} ist größer als 10 MB.`);
        continue;
      }
      const base64 = await readAsBase64(f);
      const name = f.name || `einfuegung-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.png`;
      setFiles((cur) => [
        ...cur,
        {
          id: crypto.randomUUID(),
          name,
          attachment: { kind: "data", name, mediaType: f.type || "application/octet-stream", base64 },
          preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null,
          isImage: f.type.startsWith("image/"),
        },
      ]);
    }
  };

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

  return { files, dragging, addBlobs, remove, pick, full: files.length >= MAX_ATTACHMENTS };
}

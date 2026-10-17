import { useEffect, useState, type ReactNode } from "react";
import { FileQuestion, FolderOpen } from "lucide-react";
import { call } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";

export type PreviewKind = "image" | "pdf" | "audio" | "video";

/** Formats the WebView shows itself, by file extension; a PDF often has no NUL byte and would pass as text. */
const MEDIA: Record<string, [PreviewKind, string]> = {
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  avif: ["image", "image/avif"],
  bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"],
  svg: ["image", "image/svg+xml"],
  pdf: ["pdf", "application/pdf"],
  mp3: ["audio", "audio/mpeg"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  oga: ["audio", "audio/ogg"],
  opus: ["audio", "audio/ogg"],
  m4a: ["audio", "audio/mp4"],
  aac: ["audio", "audio/aac"],
  flac: ["audio", "audio/flac"],
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  ogv: ["video", "video/ogg"],
  mov: ["video", "video/quicktime"],
};

export function mediaType(path: string): { kind: PreviewKind; mime: string } | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  const m = ext ? MEDIA[ext] : undefined;
  return m ? { kind: m[0], mime: m[1] } : null;
}

export function formatBytes(n: number): string {
  const de = (v: number) => v.toLocaleString("de-DE", { maximumFractionDigits: v < 10 ? 1 : 0 });
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${de(n / 1024)} KB`;
  return `${de(n / 1024 / 1024)} MB`;
}

function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Loaded = { url: string; size: number } | { error: string } | null;

/** The file as an object URL, read from the sidecar in chunks; revoked when the path changes or the view closes. */
function useFileUrl(projectId: string, path: string, mime: string): Loaded {
  const [state, setState] = useState<Loaded>(null);
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    setState(null);
    (async () => {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let offset = 0;
      let size = Infinity;
      while (offset < size) {
        const r = await call("projects.readFileChunk", { projectId, path, offset });
        if (!alive) return;
        size = r.size;
        const bytes = base64Bytes(r.base64);
        if (!bytes.length) break;
        parts.push(bytes);
        offset += bytes.length;
      }
      url = URL.createObjectURL(new Blob(parts, { type: mime }));
      setState({ url, size: offset });
    })().catch((e: unknown) => alive && setState({ error: errorMessage(e) }));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, path, mime]);
  return state;
}

/** Images, PDFs, audio and video of a project file, shown by the WebView itself. */
export function MediaPreview({ projectId, path, kind, mime }: { projectId: string; path: string; kind: PreviewKind; mime: string }) {
  const file = useFileUrl(projectId, path, mime);
  if (!file)
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6" aria-busy aria-label="Vorschau lädt">
        <Skeleton className={kind === "audio" ? "h-12 w-80 rounded-full" : "aspect-[4/3] h-auto w-full max-w-md"} />
      </div>
    );
  if ("error" in file)
    return (
      <div className="p-3">
        <ErrorBanner>{file.error}</ErrorBanner>
      </div>
    );
  if (kind === "image") return <ImagePreview url={file.url} size={file.size} path={path} />;
  if (kind === "pdf") return <iframe src={file.url} title={path} className="min-h-0 w-full flex-1 border-0 bg-surface" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {kind === "video" ? (
          <video src={file.url} controls className="max-h-full max-w-full rounded-md bg-black" />
        ) : (
          <audio src={file.url} controls className="w-full max-w-lg" />
        )}
      </div>
      <StatusBar>
        <span className="ml-auto">{formatBytes(file.size)}</span>
        <span>{mime}</span>
      </StatusBar>
    </div>
  );
}

const CHECKER = {
  backgroundImage: "conic-gradient(var(--color-surface-2) 25%, transparent 0 50%, var(--color-surface-2) 0 75%, transparent 0)",
  backgroundSize: "16px 16px",
};

function ImagePreview({ url, size, path }: { url: string; size: number; path: string }) {
  // Fit into the view by default; a click shows the real pixels and scrolls.
  const [actual, setActual] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    setActual(false);
    setDims(null);
    setBroken(false);
  }, [url]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto bg-bg">
        {broken ? (
          <div className="flex h-full items-center justify-center p-6 text-small text-muted">Das Bild lässt sich nicht anzeigen (Format oder Datei beschädigt).</div>
        ) : (
          <div className={cn("flex p-4", actual ? "min-h-full min-w-full w-max" : "h-full w-full items-center justify-center")}>
            <img
              src={url}
              alt={path}
              draggable={false}
              onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              onError={() => setBroken(true)}
              onClick={() => setActual(!actual)}
              style={CHECKER}
              className={cn("block shadow-sm", actual ? "m-auto max-w-none cursor-zoom-out" : "max-h-full max-w-full object-contain cursor-zoom-in")}
            />
          </div>
        )}
      </div>
      <StatusBar>
        {!broken && (
          <button type="button" onClick={() => setActual(!actual)} className="hover:text-fg">
            {actual ? "Originalgröße" : "Eingepasst"}
          </button>
        )}
        {dims && <span className="ml-auto tabular-nums">{`${dims.w} × ${dims.h} px`}</span>}
        <span className={cn("tabular-nums", !dims && "ml-auto")}>{formatBytes(size)}</span>
      </StatusBar>
    </div>
  );
}

function StatusBar({ children }: { children: ReactNode }) {
  return <div className="flex h-6 shrink-0 items-center gap-4 border-t border-border px-3 text-2xs text-muted">{children}</div>;
}

/** Binary files the WebView cannot show: say so and offer the Explorer. */
export function NoPreview({ path, onReveal }: { path: string; onReveal: () => void }) {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toUpperCase();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <FileQuestion className="h-8 w-8 text-subtle" />
      <div className="text-small text-muted">{ext ? `Für ${ext}-Dateien gibt es in FORGE keine Vorschau.` : "Für diese Datei gibt es in FORGE keine Vorschau."}</div>
      <Button size="sm" variant="outline" onClick={onReveal}>
        <FolderOpen className="h-3.5 w-3.5" />
        Im Explorer zeigen
      </Button>
    </div>
  );
}

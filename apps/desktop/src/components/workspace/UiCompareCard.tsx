import { useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Blend, Columns2, Copy, ExternalLink, FolderOpen, GitCompareArrows, ImageOff, Maximize2, RefreshCw } from "lucide-react";
import type { UiCompare } from "@forge/protocol";
import { contextItems, copyText } from "@/lib/context-menu";
import { openExternal } from "@/lib/native";
import { call, keys, useRpcMutation } from "@/lib/queries";
import { RpcCallError } from "@/lib/rpc";
import { clockTime, cn } from "@/lib/utils";
import { cardKey, useCardState } from "@/stores/card-state";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton, SkeletonRegion } from "@/components/ui/skeleton";
import type { ChatItem } from "./chat-items";
import { ChatRow, HoverTime } from "./ChatRow";
import { EVENT_ICON } from "./EventCard";
import { revealPath } from "./file-links";
import { FORGE_ICON_TONE, FORGE_MARKER_OFFSET, ForgeHighlight, ForgeLabel, type ForgeTone } from "./forge-highlight";

export type CompareMode = "side" | "slider" | "before" | "after";
type Side = "before" | "after";

const MODES: ReadonlyArray<{ value: CompareMode; label: string; icon: ReactNode }> = [
  { value: "side", label: "Nebeneinander", icon: <Columns2 className="h-3.5 w-3.5" /> },
  { value: "slider", label: "Schieber", icon: <Blend className="h-3.5 w-3.5" /> },
  { value: "before", label: "Vorher", icon: null },
  { value: "after", label: "Nachher", icon: null },
];

/** The viewport FORGE takes the shots in; placeholders keep this ratio until the real size is known. */
const DEFAULT_SIZE = { width: 1280, height: 800 };

/** Address without origin for the card title: "/settings" instead of "http://localhost:5173/settings". */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}` || "/";
  } catch {
    return url;
  }
}

export function useUiCompare(sessionId: string, compareId: string) {
  return useQuery({
    queryKey: keys.uiCompare(sessionId, compareId),
    queryFn: () => call("uiCompare.get", { sessionId, compareId }),
    staleTime: Infinity,
    retry: (n, e) => !(e instanceof RpcCallError && e.code === "NOT_FOUND") && n < 2,
  });
}

/** Actions of a comparison, for the context menu of the card and of the enlarged view. */
function useCompareActions(sessionId: string, c: UiCompare | undefined, open: (mode: CompareMode) => void) {
  const qc = useQueryClient();
  const retake = useRpcMutation("uiCompare.retake", {
    errorTitle: "Neu aufnehmen fehlgeschlagen",
    onSuccess: (next) => qc.setQueryData(keys.uiCompare(sessionId, next.id), next),
  });
  const menu = contextItems(() => {
    if (!c) return [];
    return [
      { label: "Vorher-Bild öffnen", icon: <Maximize2 className="h-3.5 w-3.5" />, onSelect: () => open("before") },
      ...(c.after ? [{ label: "Nachher-Bild öffnen", icon: <Maximize2 className="h-3.5 w-3.5" />, onSelect: () => open("after") }] : []),
      { label: "Vorher-Bild im Explorer zeigen", icon: <FolderOpen className="h-3.5 w-3.5" />, onSelect: () => void revealPath(c.before.path) },
      ...(c.after ? [{ label: "Nachher-Bild im Explorer zeigen", icon: <FolderOpen className="h-3.5 w-3.5" />, onSelect: () => void revealPath(c.after!.path) }] : []),
      ...(c.status !== "capturing" ? [{ label: "Nachher-Bild neu aufnehmen", icon: <RefreshCw className="h-3.5 w-3.5" />, onSelect: () => retake.mutate({ sessionId, compareId: c.id }) }] : []),
      { label: "Seite im Browser öffnen", icon: <ExternalLink className="h-3.5 w-3.5" />, onSelect: () => void openExternal(c.url) },
      { label: "Adresse kopieren", icon: <Copy className="h-3.5 w-3.5" />, onSelect: () => copyText(c.url) },
    ];
  });
  return { retake, menu };
}

/**
 * Before/after screenshots of the web app around a turn that changed UI files. The images come from
 * FORGE's data folder; while the after image is being taken, a placeholder of its size stands in.
 */
export function UiCompareCard({ item, sessionId }: { item: Extract<ChatItem, { kind: "uiCompare" }>; sessionId: string }) {
  const b = item.body;
  const q = useUiCompare(sessionId, b.compareId);
  const [mode, setMode] = useCardState<CompareMode>(cardKey(sessionId, b.compareId, "mode"), "side");
  const [zoom, setZoom] = useState<CompareMode | null>(null);
  const c = q.data;
  const { retake, menu } = useCompareActions(sessionId, c, setZoom);
  const gone = q.isError;
  const tone: ForgeTone = gone ? "warning" : c?.status === "failed" ? "danger" : "accent";
  const files = b.files.length === 1 ? "1 UI-Datei" : `${b.files.length} UI-Dateien`;

  return (
    <ChatRow className="group text-body" markerClassName={FORGE_MARKER_OFFSET} marker={<GitCompareArrows className={cn(EVENT_ICON, FORGE_ICON_TONE[tone])} />}>
      <div onContextMenu={menu}>
        <ForgeHighlight tone={tone}>
          <div className="flex min-w-0 items-baseline gap-2">
            <div className="min-w-0 flex-1 break-words">
              <span className="font-medium text-fg">Vorher und nachher</span>
              <span className="ml-2 font-mono text-small text-accent">{pagePath(b.url)}</span>
              <span className="ml-2 text-muted" title={b.files.join("\n")}>
                {files} geändert
              </span>
            </div>
            <ForgeLabel />
            <HoverTime time={clockTime(item.ts)} />
          </div>
          {gone ? (
            <p className="mt-1.5 flex items-center gap-1.5 text-small text-muted">
              <ImageOff className="h-3.5 w-3.5" /> Bilder nicht mehr vorhanden. FORGE räumt sie nach 14 Tagen weg.
            </p>
          ) : (
            <>
              <ModeBar value={mode} onChange={setMode} className="mt-2" />
              <CompareView sessionId={sessionId} compare={c} mode={mode} onOpen={(m) => setZoom(m)} className="mt-2 max-w-3xl" />
              {c?.status === "failed" && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-small text-danger">Nachher-Bild fehlgeschlagen: {c.error}</span>
                  <Button size="sm" variant="outline" loading={retake.isPending} onClick={() => retake.mutate({ sessionId, compareId: c.id })}>
                    <RefreshCw className="h-3.5 w-3.5" /> Neu aufnehmen
                  </Button>
                </div>
              )}
            </>
          )}
        </ForgeHighlight>
      </div>
      {zoom && <UiCompareDialog sessionId={sessionId} compareId={b.compareId} initialMode={zoom} onClose={() => setZoom(null)} />}
    </ChatRow>
  );
}

function ModeBar({ value, onChange, className }: { value: CompareMode; onChange: (m: CompareMode) => void; className?: string }) {
  return (
    <div role="radiogroup" aria-label="Ansicht" className={cn("flex flex-wrap items-center gap-1", className)}>
      {MODES.map((m) => (
        <Button
          key={m.value}
          role="radio"
          aria-checked={value === m.value}
          size="sm"
          variant="ghost"
          className={cn("h-6 px-2", value === m.value && "bg-surface-3 text-fg")}
          onClick={() => onChange(m.value)}
        >
          {m.icon}
          {m.label}
        </Button>
      ))}
    </div>
  );
}

/** The images in the chosen view; a click opens the enlarged view in the same mode. */
function CompareView({ sessionId, compare, mode, onOpen, className, large = false }: { sessionId: string; compare: UiCompare | undefined; mode: CompareMode; onOpen?: (mode: CompareMode) => void; className?: string; large?: boolean }) {
  const size = compare?.before ?? DEFAULT_SIZE;
  const ratio: CSSProperties = { aspectRatio: `${size.width} / ${size.height}` };
  const open = (m: CompareMode) => onOpen?.(m);
  if (mode === "slider") return <SliderView sessionId={sessionId} compare={compare} ratio={ratio} className={className} onOpen={onOpen ? () => open("slider") : undefined} large={large} />;
  if (mode === "before" || mode === "after")
    return (
      <div className={className}>
        <Shot sessionId={sessionId} compare={compare} side={mode} ratio={ratio} onClick={onOpen ? () => open(mode) : undefined} large={large} />
      </div>
    );
  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      {(["before", "after"] as const).map((side) => (
        <figure key={side} className="min-w-0">
          <Shot sessionId={sessionId} compare={compare} side={side} ratio={ratio} onClick={onOpen ? () => open(side) : undefined} large={large} />
          <figcaption className="mt-1 text-caption text-subtle">{side === "before" ? "Vorher" : "Nachher"}</figcaption>
        </figure>
      ))}
    </div>
  );
}

function useShot(sessionId: string, compare: UiCompare | undefined, side: Side) {
  const shot = compare ? (side === "before" ? compare.before : compare.after) : null;
  const q = useQuery({
    queryKey: keys.uiCompareImage(sessionId, compare?.id ?? "", side, shot?.takenAt ?? ""),
    queryFn: () => call("uiCompare.image", { sessionId, compareId: compare!.id, side }),
    enabled: !!compare && !!shot && !(side === "after" && compare.status === "capturing"),
    staleTime: Infinity,
    retry: 1,
  });
  const capturing = !compare || (side === "after" && compare.status === "capturing");
  const missing = !!compare && !shot && !capturing;
  return { img: q.data, loading: capturing || (!!shot && q.isPending), missing: missing || q.isError };
}

function Shot({ sessionId, compare, side, ratio, onClick, large }: { sessionId: string; compare: UiCompare | undefined; side: Side; ratio: CSSProperties; onClick?: () => void; large: boolean }) {
  const { img, loading, missing } = useShot(sessionId, compare, side);
  const label = side === "before" ? "Vorher" : "Nachher";
  const box = cn("block w-full overflow-hidden rounded-md border border-border bg-surface-2", large && "max-h-[60vh]");
  if (loading)
    return (
      <SkeletonRegion label={`Lädt ${label}-Bild`} className={box} style={ratio}>
        <Skeleton className="h-full w-full rounded-none" />
      </SkeletonRegion>
    );
  if (missing || !img)
    return (
      <div className={cn(box, "flex items-center justify-center")} style={ratio}>
        <span className="flex items-center gap-1.5 text-small text-subtle">
          <ImageOff className="h-3.5 w-3.5" /> Kein {label}-Bild
        </span>
      </div>
    );
  const image = <img src={`data:${img.mediaType};base64,${img.base64}`} alt={`${label}: Screenshot der Web-App`} className="block h-full w-full object-contain" />;
  if (!onClick)
    return (
      <div className={box} style={ratio}>
        {image}
      </div>
    );
  return (
    <button type="button" className={cn(box, "cursor-zoom-in")} style={ratio} onClick={onClick} title="Vergrößern">
      {image}
    </button>
  );
}

/** Both images on top of each other; the handle shows the before image left of it. */
function SliderView({ sessionId, compare, ratio, className, onOpen, large }: { sessionId: string; compare: UiCompare | undefined; ratio: CSSProperties; className?: string; onOpen?: () => void; large: boolean }) {
  const [pos, setPos] = useState(50);
  const before = useShot(sessionId, compare, "before");
  const after = useShot(sessionId, compare, "after");
  const box = cn("relative block w-full overflow-hidden rounded-md border border-border bg-surface-2", large && "max-h-[60vh]");
  if (before.loading || after.loading || !before.img || !after.img) {
    if (before.loading || after.loading)
      return (
        <SkeletonRegion label="Lädt Vergleich" className={cn(box, className)} style={ratio}>
          <Skeleton className="h-full w-full rounded-none" />
        </SkeletonRegion>
      );
    return (
      <div className={cn(box, "flex items-center justify-center", className)} style={ratio}>
        <span className="flex items-center gap-1.5 text-small text-subtle">
          <ImageOff className="h-3.5 w-3.5" /> Für den Schieber fehlt ein Bild
        </span>
      </div>
    );
  }
  const src = (i: { mediaType: string; base64: string }) => `data:${i.mediaType};base64,${i.base64}`;
  const follow = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0) setPos(Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))));
  };
  return (
    <div className={className}>
      <div
        className={cn(box, "cursor-ew-resize touch-none select-none")}
        style={ratio}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          follow(e);
        }}
        onPointerMove={(e) => e.buttons === 1 && follow(e)}
        onDoubleClick={onOpen}
        title={onOpen ? "Ziehen verschiebt die Grenze, Doppelklick vergrößert" : "Ziehen verschiebt die Grenze"}
      >
        <img draggable={false} src={src(after.img)} alt="Nachher: Screenshot der Web-App" className="absolute inset-0 h-full w-full object-contain" />
        <img draggable={false} src={src(before.img)} alt="Vorher: Screenshot der Web-App" className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-accent" style={{ left: `calc(${pos}% - 1px)` }} />
        <span className="pointer-events-none absolute left-2 top-2 rounded border border-border bg-surface px-1.5 py-0.5 text-caption text-fg">Vorher</span>
        <span className="pointer-events-none absolute right-2 top-2 rounded border border-border bg-surface px-1.5 py-0.5 text-caption text-fg">Nachher</span>
      </div>
      <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-label="Grenze zwischen Vorher und Nachher" className="mt-2 w-full accent-accent" />
    </div>
  );
}

/** The comparison enlarged; also opened from the command palette for the latest one. */
export function UiCompareDialog({ sessionId, compareId, initialMode, onClose }: { sessionId: string; compareId: string; initialMode: CompareMode; onClose: () => void }) {
  const [mode, setMode] = useState<CompareMode>(initialMode);
  const q = useUiCompare(sessionId, compareId);
  const c = q.data;
  const { retake, menu } = useCompareActions(sessionId, c, setMode);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Vorher und nachher"
      description={c ? `${c.url} · ${c.files.length === 1 ? "1 UI-Datei" : `${c.files.length} UI-Dateien`} geändert` : undefined}
      className="w-[min(1600px,94vw)]"
      footer={
        c && c.status !== "capturing" ? (
          <Button variant="outline" loading={retake.isPending} onClick={() => retake.mutate({ sessionId, compareId })}>
            <RefreshCw className="h-3.5 w-3.5" /> Nachher-Bild neu aufnehmen
          </Button>
        ) : undefined
      }
    >
      {q.isError ? (
        <p className="flex items-center gap-1.5 text-body text-muted">
          <ImageOff className="h-4 w-4" /> Bilder nicht mehr vorhanden. FORGE räumt sie nach 14 Tagen weg.
        </p>
      ) : (
        <div onContextMenu={menu}>
          <ModeBar value={mode} onChange={setMode} />
          <CompareView sessionId={sessionId} compare={c} mode={mode} className="mt-3" large />
          {c?.status === "failed" && <p className="mt-2 text-small text-danger">Nachher-Bild fehlgeschlagen: {c.error}</p>}
        </div>
      )}
    </Dialog>
  );
}

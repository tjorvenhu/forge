import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  AppWindow,
  Check,
  Copy,
  Grid3x3,
  Hash,
  Highlighter,
  Lasso,
  Monitor,
  MousePointer2,
  MoveUpRight,
  Pen,
  Redo2,
  Square,
  SquareDashed,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { errorMessage } from "@/lib/rpc";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/ui/misc";
import { compose, type Snip } from "./compose";
import { bigEnough, boundsOf, clampRect, contains, HANDLES, monitorAt, moveWithin, rectFromPoints, resize, toolbarSpot, windowAt, type FrameInfo, type Handle, type Point, type Rect } from "./geometry";
import { isVisible, MARK_COLORS, MARK_FONT, MarkShape, pixelate, resolveColor, type Mark, type Tool } from "./marks";

const FRAME = "screenshot://frame";
/** Esc and Enter, caught by the shell's keyboard hook while the overlay is open (payload: the key). */
const KEY = "screenshot://key";
/** Mode, tool and colour of the last snip; the next one starts with them. */
const PREFS_KEY = "forge.snip";

type Mode = "rect" | "free" | "window" | "screen";

const MODES: Array<{ id: Mode; label: string; key: string; icon: ReactNode; hint: string }> = [
  { id: "rect", label: "Rechteck", key: "R", icon: <SquareDashed className="h-4 w-4" />, hint: "Bereich aufziehen" },
  { id: "free", label: "Freihand", key: "F", icon: <Lasso className="h-4 w-4" />, hint: "Bereich umfahren" },
  { id: "window", label: "Fenster", key: "W", icon: <AppWindow className="h-4 w-4" />, hint: "Fenster anklicken" },
  { id: "screen", label: "Bildschirm", key: "B", icon: <Monitor className="h-4 w-4" />, hint: "Bildschirm anklicken" },
];

/** `label` stays visible under the icon, `tip` explains it on hover. */
const TOOLS: Array<{ id: Tool; label: string; tip: string; key: string; icon: ReactNode }> = [
  { id: "select", label: "Auswahl", tip: "Auswahl verschieben und an den Ecken anpassen", key: "V", icon: <MousePointer2 className="h-4 w-4" /> },
  { id: "pen", label: "Stift", tip: "Frei zeichnen", key: "P", icon: <Pen className="h-4 w-4" /> },
  { id: "marker", label: "Marker", tip: "Textmarker, durchscheinend", key: "M", icon: <Highlighter className="h-4 w-4" /> },
  { id: "arrow", label: "Pfeil", tip: "Pfeil ziehen", key: "A", icon: <MoveUpRight className="h-4 w-4" /> },
  { id: "box", label: "Rahmen", tip: "Rahmen aufziehen", key: "R", icon: <Square className="h-4 w-4" /> },
  { id: "text", label: "Text", tip: "Klicken und schreiben, Enter setzt den Text", key: "T", icon: <Type className="h-4 w-4" /> },
  { id: "number", label: "Nummer", tip: "Klicken setzt die nächste Nummer", key: "N", icon: <Hash className="h-4 w-4" /> },
  { id: "pixelate", label: "Verpixeln", tip: "Bereich aufziehen, der unkenntlich wird", key: "X", icon: <Grid3x3 className="h-4 w-4" /> },
];

/** Line widths and sizes in CSS pixels; marks store them in physical pixels. */
const SIZE = { pen: 3, marker: 18, arrow: 4, box: 3, text: 22, number: 14 } as const;
/** Gap between a selection and its tool bar, and to the screen edge (CSS pixels). */
const GAP = 12;
const LOUPE_CELLS = 17;
const LOUPE_ZOOM = 8;

const CURSOR: Record<Handle, string> = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize" };

interface Prefs {
  mode: Mode;
  tool: Tool;
  color: string;
}

function readPrefs(): Prefs {
  const fallback: Prefs = { mode: "rect", tool: "select", color: MARK_COLORS[0].token };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      mode: MODES.some((m) => m.id === raw.mode) ? raw.mode! : fallback.mode,
      tool: TOOLS.some((t) => t.id === raw.tool) ? raw.tool! : fallback.tool,
      color: MARK_COLORS.some((c) => c.token === raw.color) ? raw.color! : fallback.color,
    };
  } catch {
    return fallback;
  }
}

interface Shot {
  info: FrameInfo;
  url: string;
  image: HTMLImageElement;
}

/**
 * The overlay window of the Print key (screenshot.rs). It is built once and then only hidden; every
 * capture arrives as a new frame and gets a fresh snipper.
 */
export function ScreenshotOverlay() {
  const [shot, setShot] = useState<Shot | null>(null);

  useEffect(() => {
    let current = 0;
    let url: string | null = null;
    const load = async (info: FrameInfo) => {
      if (info.id <= current) return;
      current = info.id;
      try {
        const bytes = await invoke<ArrayBuffer>("screenshot_image", { id: info.id });
        if (current !== info.id) return;
        const next = URL.createObjectURL(new Blob([bytes], { type: "image/bmp" }));
        const image = new Image();
        image.src = next;
        await image.decode();
        if (url) URL.revokeObjectURL(url);
        url = next;
        setShot({ info, url: next, image });
      } catch {
        // Without a picture there is nothing to show; the shell must not keep waiting for it.
        void invoke("screenshot_cancel").catch(() => {});
      }
    };
    const offs = [listen<FrameInfo>(FRAME, (e) => void load(e.payload))];
    // A capture that came while this page was still loading.
    void invoke<FrameInfo | null>("screenshot_frame")
      .then((info) => info && load(info))
      .catch(() => {});
    const block = (e: Event) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => {
      for (const off of offs) void off.then((u) => u());
      window.removeEventListener("contextmenu", block);
    };
  }, []);

  return shot ? <Snipper key={shot.info.id} shot={shot} /> : null;
}

type Action =
  | { type: "pick-rect"; start: Point }
  | { type: "pick-free"; points: Point[] }
  | { type: "move"; start: Point; orig: Snip }
  | { type: "resize"; handle: Handle; start: Point; orig: Rect }
  | { type: "draw"; mark: Mark; from: Point };

function Snipper({ shot }: { shot: Shot }) {
  const { info, url, image } = shot;
  const frame: Rect = useMemo(() => ({ x: 0, y: 0, width: info.width, height: info.height }), [info]);
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  /** physical pixels per CSS pixel */
  const scale = info.width / viewport.width;
  const css = (n: number) => n / scale;

  const prefs = useMemo(readPrefs, []);
  const [mode, setMode] = useState<Mode>(prefs.mode);
  const [tool, setTool] = useState<Tool>(prefs.tool);
  const [colorToken, setColorToken] = useState(prefs.color);
  const color = useMemo(() => resolveColor(colorToken), [colorToken]);
  useEffect(() => localStorage.setItem(PREFS_KEY, JSON.stringify({ mode, tool, color: colorToken } satisfies Prefs)), [mode, tool, colorToken]);

  const [shown, setShown] = useState(false);
  const [closing, setClosing] = useState(false);
  const [flash, setFlash] = useState(false);
  const [snip, setSnip] = useState<Snip | null>(null);
  const [draft, setDraft] = useState<Snip | null>(null);
  const [pointer, setPointer] = useState<Point>({ x: info.cursorX, y: info.cursorY });
  const [overBar, setOverBar] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [redo, setRedo] = useState<Mark[]>([]);
  const [drawing, setDrawing] = useState<Mark | null>(null);
  const [text, setText] = useState<{ at: Point; value: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = useRef<Action | null>(null);
  /** a drag is running (selection, move, resize); hides what would get in the way */
  const [busy, setBusy] = useState(false);
  const marksSvg = useRef<SVGSVGElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const capture = (e: ReactPointerEvent) => root.current?.setPointerCapture(e.pointerId);

  const home = monitorAt(info.monitors, { x: info.cursorX, y: info.cursorY }) ?? frame;
  const hover = !snip && !draft && !busy ? (mode === "window" ? windowAt(info.windows, pointer, frame) : mode === "screen" ? monitorAt(info.monitors, pointer) : null) : null;

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    // Shown only once the picture is on screen, so the user never sees a blank window.
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        void invoke("screenshot_ready", { id: info.id })
          .then(() => {
            // The shell activates the window; the page itself still has to take the keys.
            window.focus();
            root.current?.focus({ preventScroll: true });
          })
          .catch(() => {});
        setShown(true);
      });
    });
    return () => {
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(raf);
    };
  }, [info.id]);

  const toPoint = (e: { clientX: number; clientY: number }): Point => ({
    x: Math.min(Math.max(0, Math.round(e.clientX * scale)), info.width),
    y: Math.min(Math.max(0, Math.round(e.clientY * scale)), info.height),
  });

  // ---------- finishing

  const close = async () => {
    if (closing) return;
    setClosing(true);
    await new Promise((r) => setTimeout(r, 130));
    await invoke("screenshot_cancel").catch(() => {});
  };

  const finish = async (toForge: boolean) => {
    if (!snip || closing) return;
    commitText();
    setError(null);
    setClosing(true);
    setFlash(true);
    try {
      // The marks SVG has to show a text just committed before it is copied.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const [out] = await Promise.all([compose(image, snip, marksSvg.current), new Promise((r) => setTimeout(r, 160))]);
      await invoke("screenshot_take", out.rgba, { headers: { "x-width": String(out.width), "x-height": String(out.height), "x-forge": toForge ? "1" : "0" } });
    } catch (e) {
      setClosing(false);
      setFlash(false);
      setError(errorMessage(e));
    }
  };

  // ---------- marks

  const addMark = (m: Mark) => {
    setMarks((cur) => [...cur, m]);
    setRedo([]);
  };

  /** Puts an open text field down as a mark; true when there was one. */
  const commitText = () => {
    if (!text) return false;
    if (text.value.trim()) addMark({ kind: "text", color, size: SIZE.text * scale, at: text.at, text: text.value });
    setText(null);
    return true;
  };

  const undo = () => {
    if (text) return setText(null);
    setMarks((cur) => {
      const last = cur[cur.length - 1];
      if (last) setRedo((r) => [...r, last]);
      return cur.slice(0, -1);
    });
  };

  const redoLast = () =>
    setRedo((cur) => {
      const last = cur[cur.length - 1];
      if (last) setMarks((m) => [...m, last]);
      return cur.slice(0, -1);
    });

  const startMark = (p: Point): Mark | null => {
    switch (tool) {
      case "pen":
        return { kind: "pen", color, width: SIZE.pen * scale, points: [p] };
      case "marker":
        return { kind: "marker", color, width: SIZE.marker * scale, points: [p] };
      case "arrow":
        return { kind: "arrow", color, width: SIZE.arrow * scale, from: p, to: p };
      case "box":
        return { kind: "box", color, width: SIZE.box * scale, rect: { ...p, width: 0, height: 0 } };
      case "pixelate":
        return { kind: "pixelate", rect: { ...p, width: 0, height: 0 }, image: "" };
      default:
        return null;
    }
  };

  const extendMark = (m: Mark, p: Point, from: Point): Mark => {
    switch (m.kind) {
      case "pen":
      case "marker": {
        const last = m.points[m.points.length - 1]!;
        return Math.hypot(p.x - last.x, p.y - last.y) < 2 * scale ? m : { ...m, points: [...m.points, p] };
      }
      case "arrow":
        return { ...m, to: p };
      case "box":
      case "pixelate":
        return { ...m, rect: rectFromPoints(from, p) };
      default:
        return m;
    }
  };

  // ---------- selecting

  const select = (next: Snip) => {
    setSnip(next);
    setDraft(null);
    setError(null);
  };

  const restart = (next: Mode) => {
    setMode(next);
    setSnip(null);
    setDraft(null);
    setMarks([]);
    setRedo([]);
    setText(null);
    setError(null);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (closing || e.button !== 0) {
      if (e.button === 2) {
        act.current = null;
        setDraft(null);
        setDrawing(null);
      }
      return;
    }
    const p = toPoint(e);
    // The click would move the focus away from a text field, which commits or drops it at once.
    if (text || tool === "text") e.preventDefault();
    if (text) {
      commitText();
      if (tool !== "text") return;
    }
    if (snip && tool !== "select") {
      if (tool === "text") return setText({ at: p, value: "" });
      if (tool === "number") return addMark({ kind: "number", color, radius: SIZE.number * scale, at: p, n: marks.filter((m) => m.kind === "number").length + 1 });
      const m = startMark(p);
      if (m) {
        act.current = { type: "draw", mark: m, from: p };
        setDrawing(m);
        capture(e);
      }
      return;
    }
    if (snip && contains(snip.rect, p)) {
      act.current = { type: "move", start: p, orig: snip };
      setBusy(true);
      capture(e);
      return;
    }
    // Outside the selection, or nothing selected yet: a new selection.
    const pickMode = snip ? (snip.path ? "free" : "rect") : mode;
    if (pickMode === "window" || pickMode === "screen") {
      if (hover) select({ rect: hover });
      return;
    }
    setSnip(null);
    act.current = pickMode === "free" ? { type: "pick-free", points: [p] } : { type: "pick-rect", start: p };
    setDraft(pickMode === "free" ? { rect: { ...p, width: 0, height: 0 }, path: [p] } : { rect: { ...p, width: 0, height: 0 } });
    setBusy(true);
    capture(e);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const p = toPoint(e);
    setPointer(p);
    const a = act.current;
    if (!a) return;
    if (a.type === "pick-rect") setDraft({ rect: clampRect(rectFromPoints(a.start, p), frame) ?? { ...p, width: 0, height: 0 } });
    else if (a.type === "pick-free") {
      const last = a.points[a.points.length - 1]!;
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 2 * scale) a.points.push(p);
      setDraft({ rect: boundsOf(a.points), path: [...a.points] });
    } else if (a.type === "move") {
      const dx = p.x - a.start.x;
      const dy = p.y - a.start.y;
      const rect = moveWithin(a.orig.rect, dx, dy, frame);
      const ox = rect.x - a.orig.rect.x;
      const oy = rect.y - a.orig.rect.y;
      setSnip({ rect, path: a.orig.path?.map((q) => ({ x: q.x + ox, y: q.y + oy })) });
    } else if (a.type === "resize") {
      const r = clampRect(resize(a.orig, a.handle, p.x - a.start.x, p.y - a.start.y), frame);
      if (r) setSnip({ rect: r });
    } else if (a.type === "draw") {
      let m = extendMark(a.mark, p, a.from);
      // Pixelated while it is dragged, so the user sees what will be hidden.
      if (m.kind === "pixelate") {
        const r = clampRect(m.rect, frame);
        m = r ? { ...m, rect: r, image: pixelate(image, r) } : m;
      }
      a.mark = m;
      setDrawing(m);
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    const a = act.current;
    act.current = null;
    setBusy(false);
    if (!a) return;
    if (a.type === "pick-rect") {
      setDraft(null);
      const r = clampRect(rectFromPoints(a.start, toPoint(e)), frame);
      if (bigEnough(r)) select({ rect: r });
    } else if (a.type === "pick-free") {
      setDraft(null);
      const r = clampRect(boundsOf(a.points), frame);
      if (bigEnough(r) && a.points.length > 2) select({ rect: r, path: a.points });
    } else if (a.type === "draw") {
      setDrawing(null);
      const m = a.mark;
      if (!isVisible(m, 4 * scale) || (m.kind === "pixelate" && !m.image)) return;
      addMark(m);
    }
  };

  // ---------- keys

  /** Esc: drop the text field or the running drag, else close. Enter: set the text, else send to FORGE. */
  const special = (key: string) => {
    if (key === "Enter") {
      if (text) commitText();
      else if (snip) void finish(true);
      return;
    }
    if (key !== "Escape") return;
    if (text) return setText(null);
    if (act.current) {
      act.current = null;
      setDraft(null);
      setDrawing(null);
      setBusy(false);
      return;
    }
    void close();
  };

  const latest = useRef({ finish, undo, redoLast, special, text, snip });
  latest.current = { finish, undo, redoLast, special, text, snip };

  // While the overlay is open the shell's hook catches Esc and Enter, whether or not the page has the focus.
  useEffect(() => {
    const off = listen<string>(KEY, (e) => latest.current.special(e.payload));
    return () => void off.then((u) => u());
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const l = latest.current;
      if (e.repeat) return;
      // Only arrives here when the hook is not running.
      if (e.key === "Escape" || (e.key === "Enter" && !l.text)) {
        e.preventDefault();
        return l.special(e.key);
      }
      if (l.text) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "z") {
        e.preventDefault();
        if (e.shiftKey) l.redoLast();
        else l.undo();
      } else if (e.ctrlKey && k === "y") {
        e.preventDefault();
        l.redoLast();
      } else if (e.ctrlKey && k === "c" && l.snip) {
        e.preventDefault();
        void l.finish(false);
      } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        if (l.snip) {
          const t = TOOLS.find((x) => x.key.toLowerCase() === k);
          if (t) setTool(t.id);
        } else {
          const m = MODES.find((x) => x.key.toLowerCase() === k);
          if (m) setMode(m.id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- layout

  const shape = snip ?? draft ?? (hover ? { rect: hover } : null);
  const picking = !snip && (mode === "rect" || mode === "free");
  const showLoupe = picking && shown && !closing && !overBar;
  const cursor = closing
    ? "default"
    : !snip
      ? mode === "window" || mode === "screen"
        ? "pointer"
        : "crosshair"
      : tool === "select"
        ? contains(snip.rect, pointer)
          ? "move"
          : "crosshair"
        : tool === "text"
          ? "text"
          : "crosshair";

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="fixed inset-0 select-none overflow-hidden bg-black outline-none"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <img src={url} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />

      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${info.width} ${info.height}`} preserveAspectRatio="none">
        <defs>
          <mask id="snip-dim">
            <rect width={info.width} height={info.height} fill="white" />
            {shape && <SnipShape snip={shape} fill="black" animate={!!hover} />}
          </mask>
        </defs>
        <rect
          width={info.width}
          height={info.height}
          fill="black"
          mask="url(#snip-dim)"
          style={{ opacity: shown && !closing ? 0.5 : 0, transition: `opacity ${closing ? 120 : 220}ms var(--ease-snappy)` }}
        />
        {shape?.path && <polygon points={shape.path.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke="white" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>

      <svg ref={marksSvg} className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${info.width} ${info.height}`} preserveAspectRatio="none">
        {snip && (
          <>
            <defs>
              <clipPath id="snip-clip">
                <SnipShape snip={snip} fill="black" />
              </clipPath>
            </defs>
            <g clipPath="url(#snip-clip)">
              {marks.map((m, i) => (
                <g key={i} data-mark="">
                  <MarkShape mark={m} />
                </g>
              ))}
              {drawing && <MarkShape mark={drawing} />}
              {drawing?.kind === "pixelate" && (
                <g fill="none" vectorEffect="non-scaling-stroke">
                  <rect {...drawing.rect} stroke="black" strokeOpacity={0.5} strokeWidth={3} vectorEffect="non-scaling-stroke" />
                  <rect {...drawing.rect} stroke="white" strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />
                </g>
              )}
            </g>
          </>
        )}
      </svg>

      {shape && !shape.path && <Frame rect={shape.rect} scale={scale} hover={!!hover} closing={closing} />}
      {flash && snip && (
        <div className="pointer-events-none absolute animate-snip-flash bg-white" style={{ left: css(snip.rect.x), top: css(snip.rect.y), width: css(snip.rect.width), height: css(snip.rect.height) }} />
      )}

      {snip && !closing && tool === "select" && !snip.path && !busy && (
        <Handles
          rect={snip.rect}
          scale={scale}
          onStart={(handle, e) => {
            e.stopPropagation();
            act.current = { type: "resize", handle, start: toPoint(e), orig: snip.rect };
            setBusy(true);
            capture(e);
          }}
        />
      )}

      {(draft || busy) && shape && !closing && <SizeBadge rect={shape.rect} scale={scale} />}

      {showLoupe && <Crosshair at={pointer} scale={scale} />}
      {showLoupe && <Loupe image={image} at={pointer} scale={scale} viewport={viewport} />}

      {text && (
        <input
          autoFocus
          value={text.value}
          onChange={(e) => setText({ ...text, value: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText();
            }
          }}
          onBlur={() => commitText()}
          placeholder="Text"
          className="absolute min-w-24 border-0 bg-transparent p-0 font-semibold outline-none ring-1 ring-white/60 placeholder:text-white/50"
          style={{ left: css(text.at.x), top: css(text.at.y), fontSize: SIZE.text, color, fontFamily: MARK_FONT, lineHeight: 1, width: `${Math.max(6, text.value.length + 2)}ch` }}
        />
      )}

      <ModeBar
        monitor={home}
        scale={scale}
        mode={snip ? (snip.path ? "free" : mode) : mode}
        shown={shown}
        closing={closing}
        hint={snip ? null : MODES.find((m) => m.id === mode)!.hint}
        onMode={restart}
        onClose={() => void close()}
        onHover={setOverBar}
      />

      {snip && (
        <EditBar
          snip={snip}
          scale={scale}
          monitors={info.monitors}
          frame={frame}
          tool={tool}
          colorToken={colorToken}
          canUndo={marks.length > 0 || !!text}
          canRedo={redo.length > 0}
          moving={busy}
          closing={closing}
          error={error}
          onTool={(t) => {
            commitText();
            setTool(t);
          }}
          onColor={setColorToken}
          onUndo={undo}
          onRedo={redoLast}
          onCopy={() => void finish(false)}
          onDone={() => void finish(true)}
          onHover={setOverBar}
        />
      )}
    </div>
  );
}

function SnipShape({ snip, fill, animate = false }: { snip: Snip; fill: string; animate?: boolean }) {
  if (snip.path) return <polygon points={snip.path.map((q) => `${q.x},${q.y}`).join(" ")} fill={fill} />;
  const r = snip.rect;
  // Geometry as CSS properties, so a window or screen highlight glides from one to the next.
  return animate ? (
    <rect fill={fill} style={{ x: r.x, y: r.y, width: r.width, height: r.height, transition: "all 140ms var(--ease-snappy)" }} />
  ) : (
    <rect x={r.x} y={r.y} width={r.width} height={r.height} fill={fill} />
  );
}

/** Border of the selection or of the window or screen under the mouse. */
function Frame({ rect, scale, hover, closing }: { rect: Rect; scale: number; hover: boolean; closing: boolean }) {
  return (
    <div
      className={cn("pointer-events-none absolute", hover ? "border-2 border-accent" : "border border-white/90 shadow-[0_0_0_1px_rgb(0_0_0/0.35)]")}
      style={{
        left: rect.x / scale,
        top: rect.y / scale,
        width: rect.width / scale,
        height: rect.height / scale,
        opacity: closing ? 0 : 1,
        transition: hover ? "all 140ms var(--ease-snappy)" : "opacity 120ms",
      }}
    />
  );
}

function Handles({ rect, scale, onStart }: { rect: Rect; scale: number; onStart: (h: Handle, e: ReactPointerEvent<HTMLDivElement>) => void }) {
  const x = rect.x / scale;
  const y = rect.y / scale;
  const w = rect.width / scale;
  const h = rect.height / scale;
  const at: Record<Handle, [number, number]> = { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + h / 2], se: [x + w, y + h], s: [x + w / 2, y + h], sw: [x, y + h], w: [x, y + h / 2] };
  return (
    <div className="absolute inset-0 animate-fade-in" style={{ pointerEvents: "none" }}>
      {HANDLES.map((hd) => (
        <div
          key={hd}
          onPointerDown={(e) => onStart(hd, e)}
          className="pointer-events-auto absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/40 bg-white shadow"
          style={{ left: at[hd][0], top: at[hd][1], cursor: CURSOR[hd] }}
        />
      ))}
    </div>
  );
}

function SizeBadge({ rect, scale }: { rect: Rect; scale: number }) {
  const top = rect.y / scale;
  return (
    <div
      className="pointer-events-none absolute rounded-md bg-black/75 px-1.5 py-0.5 font-mono text-caption text-white tabular-nums"
      style={{ left: rect.x / scale, top: top > 26 ? top - 24 : top + 6 }}
    >
      {rect.width} × {rect.height}
    </div>
  );
}

function Crosshair({ at, scale }: { at: Point; scale: number }) {
  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 h-px bg-white/35" style={{ top: at.y / scale }} />
      <div className="pointer-events-none absolute inset-y-0 w-px bg-white/35" style={{ left: at.x / scale }} />
    </>
  );
}

/** Pixel-exact magnifier next to the cursor, with position and the colour under it. */
function Loupe({ image, at, scale, viewport }: { image: HTMLImageElement; at: Point; scale: number; viewport: { width: number; height: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hex, setHex] = useState("");
  const size = LOUPE_CELLS * LOUPE_ZOOM;
  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const half = Math.floor(LOUPE_CELLS / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(image, at.x - half, at.y - half, LOUPE_CELLS, LOUPE_CELLS, 0, 0, size, size);
    const [r, g, b] = ctx.getImageData(half * LOUPE_ZOOM + 1, half * LOUPE_ZOOM + 1, 1, 1).data;
    setHex(`#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("").toUpperCase()}`);
  }, [image, at, size]);
  const cx = at.x / scale;
  const cy = at.y / scale;
  const left = cx + 24 + size > viewport.width ? cx - 24 - size : cx + 24;
  const top = cy + 24 + size + 40 > viewport.height ? cy - 24 - size - 40 : cy + 24;
  const mid = Math.floor(LOUPE_CELLS / 2) * LOUPE_ZOOM;
  return (
    <div className="pointer-events-none absolute overflow-hidden rounded-xl border border-white/20 bg-surface shadow-2xl" style={{ left, top, width: size }}>
      <div className="relative" style={{ width: size, height: size }}>
        <canvas ref={canvas} width={size} height={size} className="block" />
        <div className="absolute border border-white shadow-[0_0_0_1px_rgb(0_0_0/0.6)]" style={{ left: mid, top: mid, width: LOUPE_ZOOM, height: LOUPE_ZOOM }} />
      </div>
      <div className="flex items-center justify-between gap-1.5 whitespace-nowrap px-2 py-1 font-mono text-3xs text-muted tabular-nums">
        <span>
          {at.x}, {at.y}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm border border-white/30" style={{ background: hex }} />
          {hex}
        </span>
      </div>
    </div>
  );
}

/** Tooltips of a bar stay on the monitor it is on (the overlay spans all monitors, also gaps between them). */
interface TipPlace {
  side: "top" | "bottom";
  boundary: Element | null;
}

/** Icon with its name underneath; the tooltip adds what it does and the key. */
function BarButton({
  label,
  tip,
  shortcut,
  active,
  disabled,
  place,
  onClick,
  children,
}: {
  label: string;
  tip?: string;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  place: TipPlace;
  onClick: () => void;
  children: ReactNode;
}) {
  const text = tip ?? label;
  return (
    <Tooltip content={shortcut ? `${text} (${shortcut})` : text} delay={300} side={place.side} boundary={place.boundary}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          "flex h-12 min-w-13 flex-col items-center justify-center gap-1 rounded-lg px-1.5 transition-colors duration-120 disabled:opacity-35",
          active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-3 hover:text-fg",
        )}
      >
        {children}
        <span className="whitespace-nowrap text-2xs leading-none">{label}</span>
      </button>
    </Tooltip>
  );
}

const BAR = "flex items-center gap-0.5 rounded-xl border border-border bg-surface/95 p-1 shadow-2xl backdrop-blur-md";

/** An invisible box over one monitor, the area a bar's tooltips have to stay in. */
function MonitorBox({ monitor, scale, onBox }: { monitor: Rect; scale: number; onBox: (el: HTMLDivElement | null) => void }) {
  return <div ref={onBox} className="pointer-events-none absolute" style={{ left: monitor.x / scale, top: monitor.y / scale, width: monitor.width / scale, height: monitor.height / scale }} />;
}

function ModeBar({
  monitor,
  scale,
  mode,
  shown,
  closing,
  hint,
  onMode,
  onClose,
  onHover,
}: {
  monitor: Rect;
  scale: number;
  mode: Mode;
  shown: boolean;
  closing: boolean;
  hint: string | null;
  onMode: (m: Mode) => void;
  onClose: () => void;
  onHover: (over: boolean) => void;
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  if (!shown) return null;
  const place: TipPlace = { side: "bottom", boundary: box };
  return (
    <>
      <MonitorBox monitor={monitor} scale={scale} onBox={setBox} />
      <div
        className={cn("absolute flex -translate-x-1/2 flex-col items-center gap-2", closing ? "animate-fade-out" : "animate-palette-in")}
        style={{ left: (monitor.x + monitor.width / 2) / scale, top: monitor.y / scale + 16 }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
      >
        <div className={BAR} style={{ cursor: "default" }}>
          {MODES.map((m) => (
            <BarButton key={m.id} label={m.label} tip={m.hint} shortcut={m.key} active={mode === m.id} place={place} onClick={() => onMode(m.id)}>
              {m.icon}
            </BarButton>
          ))}
          <div className="mx-0.5 h-8 w-px bg-border" />
          <BarButton label="Abbrechen" tip="Screenshot verwerfen" shortcut="Esc" place={place} onClick={onClose}>
            <X className="h-4 w-4" />
          </BarButton>
        </div>
        {hint && (
          <div key={hint} className="animate-fade-in rounded-full bg-black/65 px-3 py-1 text-caption text-white/85">
            {hint}, Esc bricht ab
          </div>
        )}
      </div>
    </>
  );
}

function EditBar({
  snip,
  scale,
  monitors,
  frame,
  tool,
  colorToken,
  canUndo,
  canRedo,
  moving,
  closing,
  error,
  onTool,
  onColor,
  onUndo,
  onRedo,
  onCopy,
  onDone,
  onHover,
}: {
  snip: Snip;
  scale: number;
  monitors: Rect[];
  frame: Rect;
  tool: Tool;
  colorToken: string;
  canUndo: boolean;
  canRedo: boolean;
  moving: boolean;
  closing: boolean;
  error: string | null;
  onTool: (t: Tool) => void;
  onColor: (token: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onCopy: () => void;
  onDone: () => void;
  onHover: (over: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 720, height: 44 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const center = { x: snip.rect.x + snip.rect.width / 2, y: snip.rect.y + snip.rect.height / 2 };
  const screen = monitorAt(monitors, center) ?? frame;
  const cssRect = (r: Rect): Rect => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale });
  const spot = toolbarSpot(cssRect(snip.rect), size, cssRect(screen), GAP);
  const colors = tool !== "select" && tool !== "pixelate";
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const place: TipPlace = { side: spot.y >= (snip.rect.y + snip.rect.height) / scale ? "bottom" : "top", boundary: box };
  return (
    <>
      <MonitorBox monitor={screen} scale={scale} onBox={setBox} />
      <div
        ref={ref}
        className={cn("absolute flex flex-col items-center gap-1.5", closing ? "animate-fade-out" : "animate-pop-in")}
        style={{ left: spot.x, top: spot.y, transition: moving ? "none" : "left 140ms var(--ease-snappy), top 140ms var(--ease-snappy)", cursor: "default" }}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerEnter={() => onHover(true)}
        onPointerLeave={() => onHover(false)}
      >
        <div className={BAR}>
          {TOOLS.map((t) => (
            <BarButton key={t.id} label={t.label} tip={t.tip} shortcut={t.key} active={tool === t.id} place={place} onClick={() => onTool(t.id)}>
              {t.icon}
            </BarButton>
          ))}
          <div className={cn("flex items-center gap-1 overflow-hidden transition-all duration-150", colors ? "max-w-64 px-1.5 py-1 opacity-100" : "max-w-0 px-0 opacity-0")}>
            {MARK_COLORS.map((c) => (
              <Tooltip key={c.token} content={c.label} delay={300} side={place.side} boundary={box}>
                <button
                  type="button"
                  aria-label={`Farbe ${c.label}`}
                  aria-pressed={colorToken === c.token}
                  onClick={() => onColor(c.token)}
                  className={cn(
                    "h-5 w-5 shrink-0 rounded-full border border-white/25 transition-transform duration-120",
                    colorToken === c.token ? "scale-110 ring-2 ring-fg ring-offset-2 ring-offset-surface" : "hover:scale-110",
                  )}
                  style={{ background: resolveColor(c.token) }}
                />
              </Tooltip>
            ))}
          </div>
          <div className="mx-0.5 h-8 w-px bg-border" />
          <BarButton label="Rückgängig" shortcut="Strg+Z" disabled={!canUndo} place={place} onClick={onUndo}>
            <Undo2 className="h-4 w-4" />
          </BarButton>
          <BarButton label="Wiederholen" shortcut="Strg+Y" disabled={!canRedo} place={place} onClick={onRedo}>
            <Redo2 className="h-4 w-4" />
          </BarButton>
          <div className="mx-0.5 h-8 w-px bg-border" />
          <BarButton label="Kopieren" tip="Nur in die Zwischenablage, nicht an FORGE" shortcut="Strg+C" place={place} onClick={onCopy}>
            <Copy className="h-4 w-4" />
          </BarButton>
          <Tooltip content="In die Zwischenablage und als Anhang an FORGE (Enter)" delay={300} side={place.side} boundary={box}>
            <button
              type="button"
              onClick={onDone}
              className="ml-1 flex h-12 items-center gap-2 rounded-lg bg-accent px-4 text-body font-medium text-accent-fg transition-colors duration-120 hover:bg-accent-strong"
            >
              <Check className="h-4 w-4" />
              <span className="flex flex-col items-start leading-tight">
                An FORGE
                <span className="text-2xs font-normal opacity-80">Enter</span>
              </span>
            </button>
          </Tooltip>
        </div>
        {error && <div className="animate-fade-in rounded-lg bg-danger px-3 py-1 text-caption text-white">{error}</div>}
      </div>
    </>
  );
}

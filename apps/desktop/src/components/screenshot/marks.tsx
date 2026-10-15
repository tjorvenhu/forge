import type { Point, Rect } from "./geometry";

/**
 * Marks drawn on a snip. Coordinates are physical pixels of the frame, so a mark stays where it was
 * drawn when the selection moves. The SVG they are drawn in is serialized as it is for the final
 * picture, so every style is a plain attribute here, nothing comes from CSS classes.
 */
export type Mark =
  | { kind: "pen" | "marker"; color: string; width: number; points: Point[] }
  | { kind: "arrow"; color: string; width: number; from: Point; to: Point }
  | { kind: "box"; color: string; width: number; rect: Rect }
  | { kind: "text"; color: string; size: number; at: Point; text: string }
  | { kind: "number"; color: string; radius: number; at: Point; n: number }
  | { kind: "pixelate"; rect: Rect; image: string };

export type Tool = "select" | "pen" | "marker" | "arrow" | "box" | "text" | "number" | "pixelate";

/** Marking colours: the theme's signal colours plus white and black, read when the overlay starts. */
export const MARK_COLORS = [
  { token: "--color-danger", label: "Rot" },
  { token: "--color-warning", label: "Gelb" },
  { token: "--color-success", label: "Grün" },
  { token: "--color-graph-blue", label: "Blau" },
  { token: "--color-accent", label: "Orange" },
  { token: "white", label: "Weiß" },
  { token: "black", label: "Schwarz" },
] as const;

export function resolveColor(token: string): string {
  if (!token.startsWith("--")) return token;
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || token;
}

/** Text in marks; system fonts only, the serialized SVG cannot load the app's fonts. */
export const MARK_FONT = "Segoe UI, system-ui, sans-serif";

/** A smooth path through the points: quadratic curves through the midpoints. */
export function smoothPath(points: Point[]): string {
  if (!points.length) return "";
  const [first, ...rest] = points;
  if (!rest.length) return `M${first!.x} ${first!.y}l0.01 0`;
  let d = `M${first!.x} ${first!.y}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const p = rest[i]!;
    const q = rest[i + 1]!;
    d += `Q${p.x} ${p.y} ${(p.x + q.x) / 2} ${(p.y + q.y) / 2}`;
  }
  const last = rest[rest.length - 1]!;
  return `${d}L${last.x} ${last.y}`;
}

/** Outline of an arrow from `from` to `to`: a shaft and a filled head that grows with the line width. */
export function arrowHead(from: Point, to: Point, width: number): { shaftEnd: Point; head: string } {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const size = Math.min(len, width * 4.5);
  const back = { x: to.x - ux * size, y: to.y - uy * size };
  const half = size * 0.55;
  const left = { x: back.x - uy * half, y: back.y + ux * half };
  const right = { x: back.x + uy * half, y: back.y - ux * half };
  return { shaftEnd: { x: to.x - ux * size * 0.6, y: to.y - uy * size * 0.6 }, head: `${to.x},${to.y} ${left.x},${left.y} ${right.x},${right.y}` };
}

/** Whether a colour is light enough that dark text and a dark halo go with it. */
export function isLight(color: string): boolean {
  if (color === "white") return true;
  const hex = /^#([0-9a-f]{6})/i.exec(color)?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.6;
}

/** Halo behind text and numbers, so they read on light and dark backgrounds alike. */
function halo(color: string): string {
  return isLight(color) ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.85)";
}

export function MarkShape({ mark }: { mark: Mark }) {
  switch (mark.kind) {
    case "pen":
    case "marker":
      return (
        <path
          d={smoothPath(mark.points)}
          fill="none"
          stroke={mark.color}
          strokeWidth={mark.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeOpacity={mark.kind === "marker" ? 0.42 : 1}
        />
      );
    case "arrow": {
      const { shaftEnd, head } = arrowHead(mark.from, mark.to, mark.width);
      return (
        <g>
          <line x1={mark.from.x} y1={mark.from.y} x2={shaftEnd.x} y2={shaftEnd.y} stroke={mark.color} strokeWidth={mark.width} strokeLinecap="round" />
          <polygon points={head} fill={mark.color} stroke={mark.color} strokeWidth={mark.width * 0.4} strokeLinejoin="round" />
        </g>
      );
    }
    case "box":
      return <rect x={mark.rect.x} y={mark.rect.y} width={mark.rect.width} height={mark.rect.height} rx={mark.width * 1.5} fill="none" stroke={mark.color} strokeWidth={mark.width} />;
    case "text":
      return (
        <text
          x={mark.at.x}
          y={mark.at.y}
          fill={mark.color}
          fontSize={mark.size}
          fontFamily={MARK_FONT}
          fontWeight={600}
          dominantBaseline="hanging"
          stroke={halo(mark.color)}
          strokeWidth={mark.size * 0.14}
          paintOrder="stroke"
          strokeLinejoin="round"
          style={{ whiteSpace: "pre" }}
        >
          {mark.text}
        </text>
      );
    case "number":
      return (
        <g>
          <circle cx={mark.at.x} cy={mark.at.y} r={mark.radius} fill={mark.color} stroke={halo(mark.color)} strokeWidth={mark.radius * 0.14} />
          <text
            x={mark.at.x}
            y={mark.at.y}
            fill={isLight(mark.color) ? "black" : "white"}
            fontSize={mark.radius * 1.15}
            fontFamily={MARK_FONT}
            fontWeight={700}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {mark.n}
          </text>
        </g>
      );
    case "pixelate":
      return (
        <image href={mark.image} x={mark.rect.x} y={mark.rect.y} width={mark.rect.width} height={mark.rect.height} preserveAspectRatio="none" imageRendering="pixelated" style={{ imageRendering: "pixelated" }} />
      );
  }
}

/** A mark worth keeping: a click without a drag draws nothing (text and numbers are placed by a click). */
export function isVisible(m: Mark, min: number): boolean {
  switch (m.kind) {
    case "pen":
    case "marker":
      return m.points.length > 1;
    case "arrow":
      return Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y) >= min;
    case "box":
    case "pixelate":
      return m.rect.width >= min && m.rect.height >= min;
    case "text":
      return m.text.trim().length > 0;
    case "number":
      return true;
  }
}

/** Physical pixels per block when hiding something: coarse enough that text cannot be read. */
export function pixelSize(r: Rect): number {
  return Math.max(8, Math.round(Math.min(r.width, r.height) / 6));
}

/** The pixelated copy of a part of the picture, as a data URL to draw stretched without smoothing. */
export function pixelate(image: CanvasImageSource, r: Rect): string {
  const cell = Math.min(pixelSize(r), 24);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(r.width / cell));
  canvas.height = Math.max(1, Math.ceil(r.height / cell));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

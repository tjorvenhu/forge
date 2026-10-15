import type { Point, Rect } from "./geometry";

export interface Snip {
  rect: Rect;
  /** outline of a freehand snip; outside of it the picture stays transparent (white in the clipboard) */
  path?: Point[];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Markierungen konnten nicht gezeichnet werden."));
    img.src = src;
  });
}

/**
 * The finished picture at full resolution: the selected part of the capture, cut to the freehand
 * outline, with the marks on top. The marks come as the overlay's own SVG, shown through a viewBox on
 * the selection; drawing that SVG keeps one implementation of every mark.
 */
export async function compose(capture: HTMLImageElement, snip: Snip, marks: SVGSVGElement | null): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const { x, y, width, height } = snip.rect;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Bild konnte nicht erstellt werden.");
  if (snip.path && snip.path.length > 2) {
    ctx.beginPath();
    snip.path.forEach((p, i) => (i ? ctx.lineTo(p.x - x, p.y - y) : ctx.moveTo(p.x - x, p.y - y)));
    ctx.closePath();
    ctx.clip();
  }
  ctx.drawImage(capture, x, y, width, height, 0, 0, width, height);
  if (marks?.querySelector("[data-mark]")) {
    const svg = marks.cloneNode(true) as SVGSVGElement;
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.removeAttribute("class");
    svg.removeAttribute("style");
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    ctx.drawImage(await loadImage(src), 0, 0, width, height);
  }
  return { rgba: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer), width, height };
}

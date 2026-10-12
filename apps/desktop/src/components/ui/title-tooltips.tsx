import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

const DELAY_MS = 400;
/** Moving from one tooltip straight to the next shows it at once, like native menus and toolbars. */
const WARM_MS = 300;
const GAP = 6;
const MARGIN = 8;

interface Tip {
  text: string;
  rect: DOMRect;
  /** shown without delay right after another one: no fade either */
  warm: boolean;
}

/**
 * Replaces the browser's native `title` tooltips app-wide with FORGE-styled ones (same look as the
 * Tooltip primitive). The title moves to `data-forge-title` while hovered so the native one never
 * appears, and is put back afterwards for accessibility and later hovers.
 */
export function TitleTooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: number | undefined;
    let showing = false;
    let warmUntil = 0;

    const restore = () => {
      window.clearTimeout(timer);
      if (showing) warmUntil = Date.now() + WARM_MS;
      showing = false;
      if (target?.dataset.forgeTitle !== undefined) {
        if (!target.hasAttribute("title")) target.setAttribute("title", target.dataset.forgeTitle);
        delete target.dataset.forgeTitle;
      }
      if (target?.dataset.forgeAriaLabel !== undefined) {
        target.removeAttribute("aria-label");
        delete target.dataset.forgeAriaLabel;
      }
      target = null;
      setTip(null);
    };

    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[title], [data-forge-title]") ?? null;
      if (el === target) return;
      restore();
      const text = el?.getAttribute("title")?.trim();
      if (!el || !text) return;
      target = el;
      // Without the title an icon-only button would lose its accessible name while hovered.
      if (!el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !el.textContent?.trim()) {
        el.setAttribute("aria-label", text);
        el.dataset.forgeAriaLabel = "";
      }
      el.dataset.forgeTitle = el.getAttribute("title") ?? "";
      el.removeAttribute("title");
      const warm = Date.now() < warmUntil;
      timer = window.setTimeout(
        () => {
          if (target !== el || !el.isConnected) return;
          showing = true;
          setTip({ text, rect: el.getBoundingClientRect(), warm });
        },
        warm ? 0 : DELAY_MS,
      );
    };

    const onOut = (e: PointerEvent) => {
      if (target && !target.contains(e.relatedTarget as Node | null)) restore();
    };
    // Clicking or typing ends the warm phase: the next tooltip waits again.
    const cool = () => {
      restore();
      warmUntil = 0;
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", cool, true);
    document.addEventListener("keydown", cool, true);
    window.addEventListener("scroll", restore, true);
    window.addEventListener("blur", restore);
    return () => {
      restore();
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", cool, true);
      document.removeEventListener("keydown", cool, true);
      window.removeEventListener("scroll", restore, true);
      window.removeEventListener("blur", restore);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return setPos(null);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = tip.rect.bottom + GAP;
    if (top + h > vh - MARGIN) top = tip.rect.top - GAP - h;
    const left = Math.min(Math.max(tip.rect.left + tip.rect.width / 2 - w / 2, MARGIN), vw - w - MARGIN);
    setPos({ left, top: Math.max(top, MARGIN) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      className={cn("pointer-events-none fixed z-[100] max-w-xs whitespace-pre-line break-words rounded-md border border-border bg-surface-3 px-2 py-1 text-xs text-fg shadow-lg", pos && !tip.warm && "animate-fade-in")}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

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
    /** ancestors with their own title: muted too, else the browser shows theirs natively next to ours */
    let muted: HTMLElement[] = [];
    let timer: number | undefined;
    let showing = false;
    let warmUntil = 0;

    const unmute = (el: HTMLElement) => {
      if (el.dataset.forgeTitle === undefined) return;
      if (!el.hasAttribute("title")) el.setAttribute("title", el.dataset.forgeTitle);
      delete el.dataset.forgeTitle;
    };

    const restore = () => {
      window.clearTimeout(timer);
      if (showing) warmUntil = Date.now() + WARM_MS;
      showing = false;
      if (target) unmute(target);
      muted.forEach(unmute);
      muted = [];
      if (target?.dataset.forgeAriaLabel !== undefined) {
        target.removeAttribute("aria-label");
        delete target.dataset.forgeAriaLabel;
      }
      target = null;
      setTip(null);
    };

    const onOver = (e: PointerEvent) => {
      let el = (e.target as Element | null)?.closest?.<HTMLElement>("[title], [data-forge-title]") ?? null;
      if (el === target) return;
      restore();
      // el may be a muted ancestor of the previous target; its title is only back after restore().
      el = (e.target as Element | null)?.closest?.<HTMLElement>("[title]") ?? null;
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
      for (let p = el.parentElement?.closest<HTMLElement>("[title]"); p; p = p.parentElement?.closest<HTMLElement>("[title]")) {
        p.dataset.forgeTitle = p.getAttribute("title") ?? "";
        p.removeAttribute("title");
        muted.push(p);
      }
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
      className={cn("pointer-events-none fixed z-[100] max-w-xs break-words rounded-md border border-border bg-surface-3 px-2.5 py-1.5 text-xs text-fg shadow-lg", pos && !tip.warm && "animate-fade-in")}
    >
      <TipText text={tip.text} />
    </div>,
    document.body,
  );
}

/** A keyboard shortcut at the end of a line: "Untere Leiste (Strg+J)". */
const SHORTCUT_RE = /\s*\(((?:Strg|Ctrl|Alt|Umschalt|Shift)\+[^)]+|F\d{1,2})\)$/;

/**
 * Tooltip text with a little structure, written as plain text in `title`: with several lines the
 * first is the heading, lines starting with "- " are list items, a shortcut in brackets at the end of
 * a line becomes a key. One line stays one plain line.
 */
export function TipText({ text }: { text: string }) {
  const lines = text.split("\n").map((l) => l.trim());
  const heading = lines.filter(Boolean).length > 1;
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line, i) => {
        if (!line) return <div key={i} aria-hidden className="h-1" />;
        const item = /^[-•]\s+(.*)$/.exec(line);
        if (item)
          return (
            <div key={i} className="flex gap-1.5 text-fg/90">
              <span aria-hidden className="font-medium text-accent">
                -
              </span>
              <span className="min-w-0">{item[1]}</span>
            </div>
          );
        const key = SHORTCUT_RE.exec(line);
        return (
          <div key={i} className={cn("flex items-baseline justify-between gap-3", i === 0 ? (heading ? "font-medium text-fg" : "text-fg") : "text-muted")}>
            <span className="min-w-0">{key ? line.slice(0, key.index) : line}</span>
            {key && <kbd className="shrink-0 rounded border border-accent/30 bg-accent-soft px-1 font-mono text-caption text-accent">{key[1]}</kbd>}
          </div>
        );
      })}
    </div>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { FollowState, SCROLL_KEYS } from "./follow";
import { t } from "@/i18n";

/** "new": content grew while scrolled up; "end": far from the end. */
export type JumpKind = "new" | "end";

/** The scrollbar can be released outside the scroll area, even outside the window. */
export function useDragRelease(follow: FollowState) {
  useEffect(() => {
    const release = () => follow.setDragging(false);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", release);
    };
  }, [follow]);
}

export function JumpToEnd({ kind, onClick, newLabel = t.chat.follow.newMessages }: { kind: JumpKind; onClick: () => void; newLabel?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 animate-rise-in items-center gap-1.5 rounded-full border border-border bg-surface-3 px-3 py-1 text-small text-fg shadow-lg transition-[background-color,transform] duration-120 hover:bg-border-strong active:scale-[0.97]"
    >
      <ArrowDown className="h-3.5 w-3.5" /> {kind === "new" ? newLabel : t.chat.follow.toEnd}
    </button>
  );
}

/**
 * A scroll area that follows its growing content like the chat thread: scrolling up stops it,
 * scrolling back to the end (or the jump button) makes it follow again.
 */
export function FollowScroll({ children, className }: { children: ReactNode; className?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [follow] = useState(() => new FollowState());
  const [jump, setJump] = useState<JumpKind | null>(null);
  useDragRelease(follow);

  // Growth is reported by a ResizeObserver, so content that grows in place (streamed text, a
  // longer progress line) is followed too, not only new rows.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    let lastHeight = 0;
    let lastViewport = 0;
    const onResize = () => {
      const h = content.offsetHeight;
      const viewport = el.clientHeight;
      const grew = h > lastHeight;
      if (follow.pinned && (grew || viewport < lastViewport)) el.scrollTop = el.scrollHeight;
      else if (!follow.pinned && lastHeight > 0 && grew) setJump("new");
      lastHeight = h;
      lastViewport = viewport;
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [follow]);

  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    follow.pin();
    setJump(null);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className={cn("min-h-0 flex-1 overflow-y-auto", className)}
        onWheel={(e) => follow.wheel(e.deltaY, performance.now())}
        onKeyDown={(e) => {
          if (SCROLL_KEYS.has(e.key)) follow.userInput(performance.now());
        }}
        onTouchMove={() => follow.userInput(performance.now())}
        onPointerDown={(e) => {
          // A press on the scroll container itself, not on its content, is a press on its scrollbar.
          if (e.target === e.currentTarget) follow.setDragging(true);
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const hint = follow.scrolled(el.scrollTop, el.scrollHeight, el.clientHeight, performance.now());
          if (hint === "pinned") setJump(null);
          else if (hint === "far") setJump((j) => j ?? "end");
        }}
      >
        <div ref={contentRef}>{children}</div>
      </div>
      {jump && <JumpToEnd kind={jump} onClick={jumpToEnd} newLabel={t.chat.follow.newEntries} />}
    </div>
  );
}

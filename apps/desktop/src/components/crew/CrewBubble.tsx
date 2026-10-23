import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Maximize2, MessagesSquare, X } from "lucide-react";
import type { Crew } from "@forge/protocol";
import { call, useProjects } from "@/lib/queries";
import { openCrew, unreadMessages, useCrewRead } from "@/lib/crew";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { CrewChat } from "./CrewChat";
import { MemberAvatar } from "./CrewDialogs";
import { t } from "@/i18n";

const m = t.crew;
const POS_KEY = "forge.crew.bubble";
const SIZE = 52;
const MARGIN = 16;
const PANEL_W = 380;
const PANEL_H = 540;
/** a press that moves less than this is a click, not a drag */
const DRAG_PX = 5;

interface Pos {
  /** distance of the bubble from the right and bottom window edge */
  right: number;
  bottom: number;
}

function loadPos(): Pos {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) ?? "null") as Pos | null;
    if (p && typeof p.right === "number" && typeof p.bottom === "number") return p;
  } catch {
    /* default */
  }
  return { right: 24, bottom: 24 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** All crews of this installation (any project); crew.updated keeps them fresh. */
function useAllCrews() {
  return useQuery({ queryKey: ["crews", "*"], queryFn: () => call("crew.list", {}), staleTime: 30_000, refetchInterval: 60_000 });
}

/**
 * The crew chat everywhere in FORGE: a round bubble in a corner (dragged anywhere, the place is kept),
 * with the count of unread messages; a click opens the chat beside it. The crew is the one of the open
 * project, else the first one. Hidden while the Crew tab of that crew is on screen.
 */
export function CrewBubble() {
  const crews = useAllCrews();
  const activeProjectId = useUi((s) => s.activeProjectId);
  const view = useUi((s) => s.view);
  const tab = useUi((s) => (s.toolbarOpen ? s.workspaceTab : null));
  const read = useCrewRead((s) => s.read);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Pos>(loadPos);
  const [to, setTo] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  const [win, setWin] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));

  useEffect(() => {
    const onResize = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const projects = useProjects();
  const members = (crews.data ?? []).filter((c) => c.membership === "member");
  // A worktree belongs to the crew of its main project.
  const active = (projects.data ?? []).find((p) => p.id === activeProjectId);
  const rootId = active?.parentId ?? activeProjectId;
  const crew: Crew | null = members.find((c) => c.projectId === rootId) ?? members[0] ?? null;
  const tabShowsIt = !!crew && view === "workspace" && tab === "crew" && rootId === crew.projectId;

  // Keep the bubble inside the window when it gets smaller.
  const right = clamp(pos.right, MARGIN / 2, win.w - SIZE - MARGIN / 2);
  const bottom = clamp(pos.bottom, MARGIN / 2, win.h - SIZE - MARGIN / 2);

  useLayoutEffect(() => {
    if (tabShowsIt) setOpen(false);
  }, [tabShowsIt]);

  if (!crew || tabShowsIt) return null;
  const unread = unreadMessages(crew, read[crew.id]);
  const online = crew.members.filter((x) => x.online && !x.self).length;

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, right, bottom, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return;
    d.moved = true;
    setPos({ right: clamp(d.right - dx, MARGIN / 2, win.w - SIZE - MARGIN / 2), bottom: clamp(d.bottom - dy, MARGIN / 2, win.h - SIZE - MARGIN / 2) });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!d) return;
    if (d.moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({ right, bottom }));
      } catch {
        /* private mode */
      }
    } else setOpen((o) => !o);
  };

  // The panel opens towards the middle of the window: above the bubble when there is room, else below.
  const bx = win.w - right - SIZE;
  const by = win.h - bottom - SIZE;
  const w = Math.min(PANEL_W, win.w - 2 * MARGIN);
  const h = Math.min(PANEL_H, win.h - 2 * MARGIN);
  const left = clamp(bx + SIZE / 2 < win.w / 2 ? bx : bx + SIZE - w, MARGIN, win.w - w - MARGIN);
  const top = clamp(by - h - 10 >= MARGIN ? by - h - 10 : by + SIZE + 10, MARGIN, win.h - h - MARGIN);

  return (
    <>
      {open && (
        <div
          role="dialog"
          aria-label={crew.name}
          className="fixed z-40 flex animate-pop-in flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
          style={{ left, top, width: w, height: h }}
          onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <div className="flex -space-x-1.5">
              {crew.members
                .filter((x) => !x.self)
                .slice(0, 4)
                .map((x) => (
                  <MemberAvatar key={x.id} name={x.name} color={x.color} avatar={x.avatar} online={x.online} size={24} className="ring-2 ring-surface" />
                ))}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-small font-semibold leading-tight">{crew.name}</div>
              <div className="text-caption text-subtle">{m.memberCount(crew.members.filter((x) => x.online).length, crew.members.length)}</div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              title={m.bubbleToTab}
              aria-label={m.bubbleToTab}
              onClick={() => {
                setOpen(false);
                openCrew(crew.projectId);
              }}
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" title={m.bubbleClose} aria-label={m.bubbleClose} onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </header>
          <CrewChat crew={crew} to={to} onTo={setTo} autoFocus className="min-h-0 flex-1" />
        </div>
      )}
      <button
        type="button"
        aria-label={open ? m.bubbleClose : `${m.bubbleOpen}${unread ? ` (${m.unread(unread)})` : ""}`}
        title={`${open ? m.bubbleClose : m.bubbleOpen} · ${m.bubbleDrag}`}
        className={cn(
          "fixed z-40 flex touch-none select-none items-center justify-center rounded-full shadow-xl transition-[transform,background-color] active:scale-95",
          open ? "bg-surface-3 text-fg ring-1 ring-border" : "bg-accent text-accent-fg hover:bg-accent-strong",
        )}
        style={{ right, bottom, width: SIZE, height: SIZE }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
      >
        {open ? <X className="h-5 w-5" /> : <MessagesSquare className="h-5 w-5" />}
        {!open && unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1 text-[11px] font-bold tabular-nums text-white ring-2 ring-bg">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
        {!open && unread === 0 && online > 0 && <span className="absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full bg-success ring-2 ring-accent" aria-hidden />}
      </button>
    </>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Quote, Search, X } from "lucide-react";
import type { SearchFilter, SearchHit } from "@forge/protocol";
import { useFilteredSearch } from "@/lib/queries";
import { findWords } from "@/lib/find-text";
import { useFindMarks } from "@/lib/chat-find";
import { shownSessionIds } from "@/lib/session-tabs";
import { cn } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchHitRow, SearchHitsSkeleton } from "@/components/search/SearchHits";
import { openChat, useChatSlot } from "./chat-slot";
import { useChatSurface } from "./chat-surface";

export type FindScope = "session" | "project" | "all";

/** Opening the bar again (Ctrl+F while open) focuses the field; `seed` replaces the query when set. */
export interface FindRequest {
  seed: string;
  n: number;
}

/** Hits of one session to step through; more is "1000+". */
export const SESSION_HIT_LIMIT = 1000;
/** Hits listed for a project or all sessions. */
export const LIST_HIT_LIMIT = 50;

const SCOPES: { value: FindScope; label: string; title: string }[] = [
  { value: "session", label: "Session", title: "Nur diese Session" },
  { value: "project", label: "Projekt", title: "Alle Sessions dieses Projekts, auch die seiner Agenten" },
  { value: "all", label: "Alle", title: "Alle Sessions aller Projekte" },
];

const PLACEHOLDER: Record<FindScope, string> = {
  session: "In dieser Session suchen",
  project: "In allen Sessions des Projekts suchen",
  all: "In allen Sessions suchen",
};

/**
 * The search in the chat (Ctrl+F). Searches the stored history in the sidecar, not only the loaded rows:
 * in one session it steps from hit to hit (newest first) and scrolls the thread there, for a project or
 * all sessions it lists the hits. All words in any order, case and accents ignored; optionally the exact
 * phrase. The words are marked in the text on screen.
 */
export function ChatFindBar({
  request,
  projectId,
  sessionId,
  detached = false,
  onClose,
}: {
  request: FindRequest;
  projectId: string;
  sessionId: string | null;
  /** in a chat window: no "all", hits open in this window */
  detached?: boolean;
  onClose: () => void;
}) {
  const slot = useChatSlot();
  const surface = useChatSurface();
  const inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(request.seed);
  const [query, setQuery] = useState(request.seed);
  const [scope, setScope] = useState<FindScope>(sessionId ? "session" : "project");
  const [phrase, setPhrase] = useState(false);
  const [index, setIndex] = useState(0);
  const [active, setActive] = useState(0);

  // Each request (Ctrl+F, palette, context menu) focuses the field and takes over a selected text.
  useEffect(() => {
    if (request.seed) {
      setInput(request.seed);
      setQuery(request.seed);
    }
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [request]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(input), 200);
    return () => clearTimeout(t);
  }, [input]);

  const effective: FindScope = scope === "session" && !sessionId ? "project" : scope;
  const inSession = effective === "session";
  const words = useMemo(() => findWords(query), [query]);
  const filter = useMemo<SearchFilter>(
    () => (inSession ? { sessionId: sessionId!, order: "time", phrase } : effective === "project" ? { projectId, phrase } : { phrase }),
    [inSession, sessionId, effective, projectId, phrase],
  );
  const search = useFilteredSearch(query, filter, inSession ? SESSION_HIT_LIMIT : LIST_HIT_LIMIT, words.length > 0);
  const ready = !!search.data && !search.isPlaceholderData && words.length > 0 && query.trim().length >= 2;
  const hits = ready ? search.data! : [];
  const loading = words.length > 0 && query.trim().length >= 2 && !ready && !search.isError;

  useFindMarks(surface, words, phrase);

  const jump = useCallback((hit: SearchHit) => useUi.getState().setFocusEvent({ sessionId: hit.sessionId, seq: hit.seq }), []);

  // New hits in a session: go to the newest one, like a browser jumps to the first match while typing.
  const resultKey = ready ? JSON.stringify([query.trim(), filter]) : null;
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (!resultKey || resultKey === shownKey.current) return;
    shownKey.current = resultKey;
    setIndex(0);
    setActive(0);
    if (inSession && search.data?.[0]) jump(search.data[0]);
  }, [resultKey, inSession, search.data, jump]);

  /** +1: the next older hit, -1: the next newer one; wraps around. */
  const step = (d: number) => {
    if (!hits.length) return;
    const i = (index + d + hits.length) % hits.length;
    setIndex(i);
    jump(hits[i]!);
  };

  const open = (hit: SearchHit) => {
    const ui = useUi.getState();
    jump(hit);
    if (hit.sessionId === sessionId) return;
    if (detached) return slot.select(hit.projectId, hit.sessionId);
    // Already on screen in another area of the split view: go there instead of showing it twice.
    if (shownSessionIds(ui).includes(hit.sessionId)) return openChat(hit.projectId, hit.sessionId);
    if (slot.pane || hit.projectId === projectId) slot.select(hit.projectId, hit.sessionId);
    else ui.openProject(hit.projectId, hit.sessionId);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" || e.key === "F3") {
      e.preventDefault();
      if (inSession) step(e.shiftKey ? -1 : 1);
      else if (hits[active]) open(hits[active]);
    } else if (!inSession && (e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
    }
  };

  const capped = hits.length >= (inSession ? SESSION_HIT_LIMIT : LIST_HIT_LIMIT) ? "+" : "";
  let count: ReactNode = null;
  if (loading)
    count = (
      <span role="status" aria-label="Lädt Treffer" className="flex h-5 items-center">
        <Skeleton className="h-3 w-14 rounded-sm bg-surface-3" />
      </span>
    );
  else if (search.isError && words.length) count = <span className="text-danger">Fehler</span>;
  else if (ready) count = !hits.length ? "Keine Treffer" : inSession ? `${index + 1} von ${hits.length}${capped}` : `${hits.length}${capped} Treffer`;

  return (
    <div
      data-find-skip
      role="search"
      aria-label="Im Chat suchen"
      onKeyDown={onKeyDown}
      className="absolute right-4 top-13 z-30 flex w-[min(30rem,calc(100%-2rem))] animate-drop-in flex-col overflow-hidden rounded-lg border border-border bg-surface-2 shadow-xl"
    >
      <div className="flex items-center gap-1 py-1 pl-2.5 pr-1">
        <Search className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden />
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={PLACEHOLDER[effective]}
          aria-label="Suchbegriff"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent px-1 text-body text-fg placeholder:text-subtle focus:outline-none"
        />
        <span className="shrink-0 whitespace-nowrap px-1 text-small tabular-nums text-muted" aria-live="polite">
          {count}
        </span>
        {inSession && (
          <>
            <Button size="icon-sm" variant="ghost" title="Älterer Treffer (Enter)" aria-label="Älterer Treffer" disabled={!hits.length} onClick={() => step(1)}>
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button size="icon-sm" variant="ghost" title="Neuerer Treffer (Umschalt+Enter)" aria-label="Neuerer Treffer" disabled={!hits.length} onClick={() => step(-1)}>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </>
        )}
        <Button size="icon-sm" variant="ghost" title="Schließen (Esc)" aria-label="Suche schließen" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex items-center gap-1 border-t border-border px-1.5 py-1">
        <div role="group" aria-label="Suchbereich" className="flex items-center gap-0.5 rounded-md bg-surface p-0.5">
          {SCOPES.filter((s) => !(detached && s.value === "all")).map((s) => (
            <button
              key={s.value}
              type="button"
              title={s.title}
              aria-pressed={effective === s.value}
              disabled={s.value === "session" && !sessionId}
              onClick={() => {
                setScope(s.value);
                inputRef.current?.focus();
              }}
              className={cn(
                "h-6 rounded px-2 text-small transition-colors disabled:opacity-40",
                effective === s.value ? "bg-surface-3 text-fg" : "text-muted hover:text-fg",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          type="button"
          title="Nur die genaue Wortfolge finden statt aller Wörter in beliebiger Reihenfolge"
          aria-pressed={phrase}
          onClick={() => {
            setPhrase((p) => !p);
            inputRef.current?.focus();
          }}
          className={cn("flex h-6 items-center gap-1 rounded px-2 text-small transition-colors", phrase ? "bg-accent-soft text-fg" : "text-muted hover:bg-surface-3 hover:text-fg")}
        >
          <Quote className="h-3 w-3" /> Exakte Wortfolge
        </button>
      </div>
      {!inSession && words.length > 0 && query.trim().length >= 2 && (
        <div className="max-h-[min(22rem,50vh)] overflow-y-auto border-t border-border bg-surface p-1">
          {loading ? (
            <SearchHitsSkeleton rows={3} />
          ) : !hits.length ? (
            <div className="px-2.5 py-2 text-body text-muted">{effective === "project" ? "In keiner Session dieses Projekts steht das." : "In keiner Session steht das."}</div>
          ) : (
            hits.map((h, i) => <SearchHitRow key={`${h.sessionId}:${h.seq}`} hit={h} active={i === active} onSelect={() => open(h)} />)
          )}
        </div>
      )}
    </div>
  );
}

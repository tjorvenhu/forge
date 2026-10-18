import { useEffect, useId, useMemo, useRef, useState } from "react";
import * as D from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CornerDownLeft, Search } from "lucide-react";
import { call, keys, useGitHubAccount, usePhoneState, useProjects, useRuntimeInfo, useSearch, useSession, useSettings, useTemplates } from "@/lib/queries";
import type { ProjectWithStatus, PromptTemplate } from "@forge/protocol";
import { useChatWindows } from "@/lib/chat-windows";
import { cn } from "@/lib/utils";
import { OVERLAY_MOTION } from "@/lib/motion";
import { splitActive, useUi } from "@/stores/ui";
import { Kbd, Spinner } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/skeleton";
import { HIT_ROLE_LABEL, openSearchHit, Snippet } from "@/components/search/SearchHits";
import { buildActions, type PaletteDialog, type PaletteEntry, type PaletteGroup } from "./palette-actions";
import { usePaletteSources } from "./palette-sources";
import { PaletteDialogs } from "./PaletteDialogs";
import { t } from "@/i18n";

const NO_TEMPLATES: PromptTemplate[] = [];
const NO_AGENTS: ProjectWithStatus[] = [];
const GROUP_ORDER: PaletteGroup[] = ["Aktionen", "Einstellungen", "Projekte", "Sessions", "Erweiterungen", "Wissen", "Dateien", "Commits", "In Verläufen"];

/** Rows per group; without a query only the most useful groups show. */
const CAPS_TYPED: Record<PaletteGroup, number> = { Aktionen: 6, Einstellungen: 6, Projekte: 6, Sessions: 8, Erweiterungen: 5, Wissen: 5, Dateien: 8, Commits: 5, "In Verläufen": 8 };
const CAPS_EMPTY: Record<PaletteGroup, number> = { Aktionen: 6, Einstellungen: 0, Projekte: 5, Sessions: 5, Erweiterungen: 0, Wissen: 0, Dateien: 0, Commits: 0, "In Verläufen": 0 };

/** Lowercase without accents, so "uberblick" finds "Überblick". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Lower is better, -1 is no match: the label starting with the query beats a word of it, beats keywords. */
export function rank(label: string, hay: string, words: string[]): number {
  if (!words.every((w) => hay.includes(w))) return -1;
  if (label.startsWith(words.join(" "))) return 0;
  if (!words.every((w) => label.includes(w))) return 3;
  return label.split(/[\s:/._-]+/).some((t) => t.startsWith(words[0]!)) ? 1 : 2;
}

/** Ctrl+K: jump to projects, sessions, settings, files and messages, or run an action, from anywhere. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const [dialog, setDialog] = useState<PaletteDialog | null>(null);
  return (
    <>
      <D.Root open={open} onOpenChange={setOpen}>
        <D.Portal>
          <D.Overlay className={cn("fixed inset-0 z-40 bg-overlay backdrop-blur-sm", OVERLAY_MOTION)} />
          <D.Content
            className={cn(
              "fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-160 max-w-[92vw] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl",
              "data-[state=open]:animate-palette-in data-[state=closed]:animate-fade-out",
            )}
            aria-describedby={undefined}
            // The dialog an entry opened has the focus by now.
            onCloseAutoFocus={(e) => dialog && e.preventDefault()}
          >
            <D.Title className="sr-only">{t.layout.palette.title}</D.Title>
            {/* Content is mounted only while open or closing; the body stays for the exit animation. */}
            <PaletteBody onClose={() => setOpen(false)} openDialog={setDialog} />
          </D.Content>
        </D.Portal>
      </D.Root>
      <PaletteDialogs dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function PaletteBody({ onClose, openDialog }: { onClose: () => void; openDialog: (d: PaletteDialog) => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const qc = useQueryClient();
  const view = useUi((s) => s.view);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const activeSessions = useUi((s) => s.activeSession);
  const projects = useProjects();
  const hits = useSearch(query, 8);
  const settings = useSettings().data;
  const models = useRuntimeInfo().data?.models;
  const phone = usePhoneState().data;
  const githubConnected = !!useGitHubAccount().data;
  const remote = useQuery({ queryKey: keys.remote, queryFn: () => call("remote.state", {}) }).data;
  const projectId = view === "workspace" ? activeProjectId : null;
  const project = projects.data?.find((p) => p.id === projectId) ?? null;
  const root = project?.parentId ? (projects.data?.find((p) => p.id === project.parentId) ?? null) : project;
  const allProjects = projects.data;
  const agents = useMemo(() => (root ? (allProjects ?? []).filter((p) => p.parentId === root.id && p.exists) : NO_AGENTS), [allProjects, root]);
  const devServer = useQuery({ queryKey: keys.devServer(projectId ?? ""), queryFn: () => call("devserver.state", { projectId: projectId! }), enabled: !!projectId }).data;
  const testDb = useQuery({ queryKey: keys.testDb(projectId ?? ""), queryFn: () => call("testdb.state", { projectId: projectId! }), enabled: !!projectId, staleTime: Infinity }).data;
  const session = useSession(projectId ? splitActive(activeSessions[projectId]).sessionId : null).data ?? null;
  const sources = usePaletteSources(query, project);
  const templates = useTemplates(projectId).data ?? NO_TEMPLATES;
  const chatSessions = useChatWindows((s) => s.sessions);
  const chatPinned = useChatWindows((s) => s.pinned);
  const chatWindows = useMemo(() => ({ sessions: chatSessions, pinned: chatPinned }), [chatSessions, chatPinned]);

  const actions = useMemo(
    () => buildActions({ qc, project, root, agents, session, settings, models: models ?? [], devServer, testDb, phone, remote, githubConnected, templates, chatWindows, openDialog }),
    [qc, project, root, agents, session, settings, models, devServer, testDb, phone, remote, githubConnected, templates, chatWindows, openDialog],
  );

  const indexed = useMemo(
    () => [...actions, ...sources.entries].map((e) => ({ e, label: fold(e.label), hay: fold(`${e.label} ${e.keywords ?? ""} ${e.hint ?? ""}`) })),
    [actions, sources.entries],
  );

  const fullText = query.trim().length >= 3;
  // Hits of the previous query stay as placeholder until the new ones arrive; they would not match.
  const hitsPending = fullText && hits.isFetching && (!hits.data || hits.isPlaceholderData);

  const shown = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const caps = words.length ? CAPS_TYPED : CAPS_EMPTY;
    const byGroup = new Map<PaletteGroup, Array<{ e: PaletteEntry; r: number }>>();
    for (const x of indexed) {
      if (!caps[x.e.group]) continue;
      const r = words.length ? rank(x.label, x.hay, words) : 0;
      if (r < 0) continue;
      const list = byGroup.get(x.e.group) ?? [];
      list.push({ e: x.e, r });
      byGroup.set(x.e.group, list);
    }
    const out: PaletteEntry[] = [];
    for (const g of GROUP_ORDER) {
      if (g === "In Verläufen") continue;
      const list = byGroup.get(g) ?? [];
      out.push(...list.sort((a, b) => a.r - b.r).slice(0, caps[g]).map((x) => x.e));
    }
    if (fullText && !hitsPending) {
      for (const h of (hits.data ?? []).slice(0, caps["In Verläufen"])) {
        out.push({ id: `hit-${h.sessionId}-${h.seq}`, group: "In Verläufen", label: h.snippet, icon: null, hit: h, run: () => openSearchHit(h) });
      }
    }
    return out;
  }, [indexed, query, fullText, hits.data, hitsPending]);

  const loading = sources.loading || hitsPending;

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const runAt = (i: number) => {
    const e = shown[i];
    if (!e) return;
    onClose();
    e.run();
  };

  let lastGroup: PaletteGroup | null = null;
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-border px-4">
        <Search className="h-4 w-4 shrink-0 text-subtle" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (shown.length) setIndex((i) => (i + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(index);
            }
          }}
          placeholder={t.layout.palette.placeholder}
          aria-label={t.layout.palette.searchLabel}
          role="combobox"
          aria-expanded
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={shown[index] ? `${listId}-${index}` : undefined}
          className="h-12 min-w-0 flex-1 bg-transparent text-ui text-fg placeholder:text-subtle focus:outline-none"
        />
        {hits.isFetching && <Spinner className="h-3.5 w-3.5" />}
      </div>
      <div ref={listRef} id={listId} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label={t.layout.palette.results}>
        {shown.length === 0 && !loading && <div className="px-3 py-6 text-center text-body text-muted">{t.layout.palette.nothingFound}</div>}
        {shown.map((e, i) => {
          const header = e.group !== lastGroup ? e.group : null;
          lastGroup = e.group;
          return (
            <div key={e.id} role="none">
              {header && (
                <div role="presentation" className="px-2.5 pb-1 pt-2 text-caption font-semibold uppercase tracking-wide text-subtle">
                  {t.layout.palette.groups[header]}
                </div>
              )}
              <button
                id={`${listId}-${i}`}
                tabIndex={-1}
                data-index={i}
                role="option"
                aria-selected={i === index}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => runAt(i)}
                className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left", i === index ? "bg-surface-3" : "")}
              >
                {e.hit ? (
                  <span className="min-w-0 flex-1">
                    <Snippet text={e.hit.snippet} className="line-clamp-1 block text-body" />
                    <span className="block truncate text-caption text-subtle">
                      {HIT_ROLE_LABEL[e.hit.role]} ·{e.hit.sessionTitle ?? t.layout.palette.untitled} · {e.hit.projectName}
                    </span>
                  </span>
                ) : (
                  <>
                    <span className="flex w-5 shrink-0 justify-center text-muted">{e.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-body">{e.label}</span>
                    {e.hint && <span className="max-w-56 shrink-0 truncate text-caption text-subtle">{e.hint}</span>}
                  </>
                )}
                {i === index && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-subtle" />}
              </button>
            </div>
          );
        })}
        {loading && <ResultSkeleton twoLine={hitsPending} />}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-caption text-subtle">
        <span className="flex items-center gap-1">
          <Kbd>
            <ArrowUp className="inline h-2.5 w-2.5" aria-label={t.layout.palette.arrowUp} />
          </Kbd>
          <Kbd>
            <ArrowDown className="inline h-2.5 w-2.5" aria-label={t.layout.palette.arrowDown} />
          </Kbd>
          {t.layout.palette.select}
        </span>
        <span>
          <Kbd>Enter</Kbd> {t.layout.palette.run}
        </span>
        <span>
          <Kbd>Esc</Kbd> {t.layout.palette.close}
        </span>
        <span className="flex-1 text-right">{t.layout.palette.footerHint}</span>
      </div>
    </>
  );
}

/** Result rows still loading, shaped like a group with its rows; full-text hits have two lines. */
function ResultSkeleton({ twoLine }: { twoLine: boolean }) {
  return (
    <div role="status" aria-label={t.layout.palette.loading}>
      <div className="px-2.5 pb-2 pt-3">
        <Skeleton className="h-2.5 w-20 rounded-sm" />
      </div>
      {[62, 48, 55].map((w) => (
        <div key={w} className="flex items-center gap-2.5 px-2.5 py-1.5">
          {twoLine ? (
            <span className="flex min-w-0 flex-1 flex-col gap-1.5 py-0.5">
              <Skeleton className="h-3.5 rounded-sm" style={{ width: `${w + 20}%` }} />
              <Skeleton className="h-2.5 rounded-sm" style={{ width: `${w - 10}%` }} />
            </span>
          ) : (
            <>
              <span className="flex w-5 shrink-0 justify-center">
                <Skeleton className="h-4 w-4 rounded-sm" />
              </span>
              <Skeleton className="h-3.5 rounded-sm" style={{ width: `${w}%` }} />
              <Skeleton className="ml-auto h-3 w-16 shrink-0 rounded-sm" />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

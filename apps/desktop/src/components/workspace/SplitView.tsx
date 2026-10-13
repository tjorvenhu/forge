import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { EyeOff, FolderX, LayoutGrid } from "lucide-react";
import { useLiveSessions, useProject } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { paneCapacity, paneRows, SPLIT_BAR_HEIGHT } from "@/lib/split-view";
import { cn, relativeTime } from "@/lib/utils";
import { useUi, type SplitPane } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorBanner } from "@/components/ui/misc";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { ChatPanel, ChatPanelSkeleton } from "./ChatPanel";
import { sessionStatusLabel } from "./SessionStatusBadge";
import { PaneActions, SplitControlBar, useProjectChoices, WorkspaceHeader } from "./WorkspaceHeader";
import { SplitLayoutContext, type SplitLayout } from "./chat-slot";

type Shown = { projectId: string | null; active: string | null };

const sameChat = (a: Shown, b: Shown) => !!a.active && a.projectId === b.projectId && a.active === b.active;

/** Panes that show something else than the main area and the panes before them. */
export function distinctPanes(panes: readonly SplitPane[], main: Shown): SplitPane[] {
  const out: SplitPane[] = [];
  for (const p of panes) if (!sameChat(p, main) && !out.some((o) => sameChat(o, p))) out.push(p);
  return out;
}

/** Width and height of an element, measured before paint and on every resize. */
function useSize(ref: RefObject<HTMLElement | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s && s.width === el.clientWidth && s.height === el.clientHeight ? s : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const lcm = (a: number, b: number): number => {
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  return (a * b) / gcd(a, b);
};

/**
 * The workspace, split into several areas when asked: the main area (`children`, the open project with
 * its tabs and panels) first, then further areas with a project and chat each, in a grid as large as the
 * window allows (e.g. two above two). Areas that do not fit stay in the list and come back once the
 * window is large enough again.
 */
export function SplitWorkspace({ projectId, children }: { projectId: string; children: ReactNode }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const area = useSize(areaRef);
  const size = area && { width: area.width, height: area.height - SPLIT_BAR_HEIGHT };
  const panes = useUi((s) => s.splitPanes);
  const main = useUi(useShallow((s) => ({ projectId, active: s.activeSession[projectId] ?? null })));
  const distinct = useMemo(() => distinctPanes(panes, main), [panes, main]);
  const capacity = size ? paneCapacity(size.width, size.height) : 1;
  const visible = distinct.slice(0, Math.max(0, capacity - 1));
  const hidden = distinct.slice(visible.length);
  const rows = size ? paneRows(1 + visible.length, size.width, size.height) : [1];
  // One grid track per smallest share, so rows with fewer areas split the same width evenly.
  const cols = rows.reduce(lcm, 1);
  const spans = rows.flatMap((count) => Array.from({ length: count }, () => cols / count));
  const mainWidth = size ? Math.floor((size.width * spans[0]!) / cols) : null;
  const layout = useMemo<SplitLayout>(() => ({ shown: 1 + visible.length, capacity, mainWidth }), [visible.length, capacity, mainWidth]);
  const room = Math.max(0, capacity - 1 - distinct.length);
  const setRoom = useUi((s) => s.setSplitRoom);
  useEffect(() => setRoom(room), [room, setRoom]);
  useEffect(() => () => setRoom(0), [setRoom]);

  const cells: { key: string; node: ReactNode }[] = [{ key: "main", node: children }, ...visible.map((p) => ({ key: p.id, node: <PaneArea pane={p} /> }))];

  return (
    <SplitLayoutContext.Provider value={layout}>
      <div ref={areaRef} className="flex h-full min-h-0 flex-col">
        {cells.length > 1 && <SplitControlBar projectId={projectId} />}
        {hidden.length > 0 && <HiddenPanes panes={hidden} />}
        <div
          className={cn("grid min-h-0 flex-1", cells.length > 1 && "gap-px bg-border")}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))` }}
        >
          {cells.map((c, i) => (
            // Keyed by area, so it keeps its state when the grid rearranges around it. A container, so headers fit their area.
            <div key={c.key} className="@container min-h-0 min-w-0 overflow-hidden bg-bg" style={{ gridColumn: `span ${spans[i] ?? cols}` }}>
              {c.node}
            </div>
          ))}
        </div>
      </div>
    </SplitLayoutContext.Provider>
  );
}

/** Areas that do not fit at the current window size; they come back by themselves when it grows. */
function HiddenPanes({ panes }: { panes: SplitPane[] }) {
  const close = useUi((s) => s.closeSplitPane);
  const text =
    panes.length === 1
      ? "Ein weiterer Bereich ist ausgeblendet, das Fenster ist zu klein. Mit mehr Platz erscheint er wieder."
      : `${panes.length} weitere Bereiche sind ausgeblendet, das Fenster ist zu klein. Mit mehr Platz erscheinen sie wieder.`;
  return (
    <div role="status" className="flex h-9 shrink-0 animate-fade-in items-center gap-2 border-b border-border bg-surface px-4 text-caption-lg text-muted">
      <EyeOff className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </span>
      <Button size="sm" variant="ghost" onClick={() => panes.forEach((p) => close(p.id))}>
        Schließen
      </Button>
    </div>
  );
}

function PaneArea({ pane }: { pane: SplitPane }) {
  if (!pane.projectId) return <PanePicker pane={pane} />;
  return <PaneProject key={pane.projectId} pane={pane} projectId={pane.projectId} />;
}

/** A further area: the project's header and one of its chats. */
function PaneProject({ pane, projectId }: { pane: SplitPane; projectId: string }) {
  const project = useProject(projectId);
  const close = useUi((s) => s.closeSplitPane);
  const missing = project.error instanceof RpcCallError && project.error.code === "NOT_FOUND";
  useEffect(() => {
    // The project was removed meanwhile: its area goes with it.
    if (missing) close(pane.id);
  }, [missing, close, pane.id]);

  if (project.isLoading) return <PaneSkeleton />;
  if (!project.data) {
    return (
      <PaneMessage pane={pane}>
        <div className="p-4">
          <ErrorBanner title="Projekt nicht geladen">{errorMessage(project.error)}</ErrorBanner>
        </div>
      </PaneMessage>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader projectId={projectId} pane={pane} />
      <div className="min-h-0 flex-1">
        {project.data.exists ? (
          <ChatPanel project={project.data} pane={pane} />
        ) : (
          <EmptyState icon={<FolderX className="h-9 w-9" />} title="Chat nicht verfügbar">
            Der Projektordner von {project.data.name} fehlt.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/** Header and chat of an area at their final sizes, while its project loads. */
function PaneSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5" aria-hidden>
        <Skeleton className="h-6.5 w-6.5 rounded-lg" />
        <Skeleton className="h-4 w-36" />
        <div className="flex-1" />
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-7 w-7" />
        <Skeleton className="h-7 w-7" />
      </div>
      <div className="min-h-0 flex-1">
        <ChatPanelSkeleton />
      </div>
    </div>
  );
}

/** An area without a project (picker, error): a bar with the way to close it. */
function PaneMessage({ pane, title = "Bereich", children }: { pane: SplitPane; title?: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-5">
        <LayoutGrid className="h-4 w-4 shrink-0 text-muted" />
        <h1 className="min-w-0 flex-1 truncate text-title-sm font-semibold">{title}</h1>
        <PaneActions pane={pane} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

/** A new area: running sessions of all projects not yet on screen, and every project. */
function PanePicker({ pane }: { pane: SplitPane }) {
  const live = useLiveSessions();
  const { projects, loading: projectsLoading } = useProjectChoices();
  const setPane = useUi((s) => s.setSplitPane);
  const shown = useUi(useShallow((s) => [...(s.activeProjectId ? [s.activeSession[s.activeProjectId] ?? null] : []), ...s.splitPanes.map((p) => p.active)]));
  const running = (live.data ?? []).filter((s) => !shown.includes(s.id));
  const loading = live.isPending || projectsLoading;

  return (
    <PaneMessage pane={pane} title="Projekt oder Session wählen">
      <div className="mx-auto flex max-w-xl animate-view-in flex-col gap-5 px-4 py-4">
        {loading ? (
          <PickerSkeleton />
        ) : (
          <>
            {running.length > 0 && (
              <PickerSection title="Laufende Sessions">
                {running.map((s) => (
                  <PickerRow
                    key={s.id}
                    iconId={s.projectId}
                    iconName={s.projectName}
                    label={s.title ?? "Ohne Titel"}
                    hint={`${s.projectName}, ${sessionStatusLabel(s.status, s.live, s.autoContinueAt)}`}
                    onPick={() => setPane(pane.id, s.projectId, s.id)}
                  />
                ))}
              </PickerSection>
            )}
            <PickerSection title="Projekte">
              {projects.map((p) => (
                <PickerRow
                  key={p.id}
                  iconId={p.id}
                  iconName={p.name}
                  label={p.name}
                  hint={p.favorite ? "Favorit" : p.lastOpenedAt ? relativeTime(p.lastOpenedAt) : ""}
                  onPick={() => setPane(pane.id, p.id)}
                />
              ))}
              {!projects.length && <p className="px-2 text-body text-muted">Noch keine Projekte.</p>}
            </PickerSection>
          </>
        )}
      </div>
    </PaneMessage>
  );
}

function PickerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-2 pb-1 text-caption-lg font-medium text-subtle">{title}</h3>
      {children}
    </section>
  );
}

function PickerRow({ iconId, iconName, label, hint, onPick }: { iconId: string; iconName: string; label: string; hint: string; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} className="flex h-9 min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-body text-muted transition-colors duration-120 hover:bg-surface-2 hover:text-fg">
      <ProjectIcon id={iconId} name={iconName} size={18} className="rounded-md" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="max-w-[45%] shrink-0 truncate text-caption text-subtle">{hint}</span>
    </button>
  );
}

/** Two sections of rows, at the sizes of PickerRow. */
function PickerSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[3, 6].map((rows) => (
        <div key={rows} className="flex flex-col gap-1">
          <Skeleton className="mx-2 mb-1 h-3 w-28" />
          <ListSkeleton rows={rows} className="gap-0 p-0 [&>div]:h-9 [&>div]:px-2" label="Lädt Projekte und Sessions" />
        </div>
      ))}
    </div>
  );
}

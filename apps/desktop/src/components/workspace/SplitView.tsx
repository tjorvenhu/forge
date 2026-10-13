import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { EyeOff, FolderX, LayoutGrid, MessageSquarePlus, X } from "lucide-react";
import type { Project } from "@forge/protocol";
import { useLiveSessions, useProject, useSessions } from "@/lib/queries";
import { errorMessage, RpcCallError } from "@/lib/rpc";
import { paneCapacity, paneRows } from "@/lib/split-view";
import { cn, relativeTime } from "@/lib/utils";
import { useUi, type SplitPane } from "@/stores/ui";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorBanner, Tooltip } from "@/components/ui/misc";
import { ListSkeleton, Skeleton } from "@/components/ui/skeleton";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { ChatPanel, ChatPanelSkeleton } from "./ChatPanel";
import { sessionStatusLabel } from "./SessionStatusBadge";
import { SplitLayoutContext, type SplitLayout } from "./chat-slot";

type Shown = { projectId: string | null; active: string | null };

const sameChat = (a: Shown, b: Shown) => !!a.active && a.projectId === b.projectId && a.active === b.active;

/** Panes that show something else than the main chat and the panes before them. */
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
 * The chat of the workspace, split into several chats when asked: the main chat first, then the further
 * panes, in a grid as large as the area allows (e.g. two above two). Panes that do not fit stay in the
 * list and come back once the window is large enough again.
 */
export function SplitChat({ project, workingInPanel }: { project: Project; workingInPanel: boolean }) {
  const gridRef = useRef<HTMLDivElement>(null);
  const size = useSize(gridRef);
  const panes = useUi((s) => s.splitPanes);
  const main = useUi(useShallow((s) => ({ projectId: project.id, active: s.activeSession[project.id] ?? null })));
  const distinct = useMemo(() => distinctPanes(panes, main), [panes, main]);
  const capacity = size ? paneCapacity(size.width, size.height) : 1;
  const visible = distinct.slice(0, Math.max(0, capacity - 1));
  const hidden = distinct.slice(visible.length);
  const rows = size ? paneRows(1 + visible.length, size.width, size.height) : [1];
  const layout = useMemo<SplitLayout>(() => ({ shown: 1 + visible.length, capacity }), [visible.length, capacity]);
  const room = Math.max(0, capacity - 1 - distinct.length);
  const setRoom = useUi((s) => s.setSplitRoom);
  useEffect(() => setRoom(room), [room, setRoom]);
  useEffect(() => () => setRoom(0), [setRoom]);

  // One grid track per smallest share, so rows with fewer chats split the same width evenly.
  const cols = rows.reduce(lcm, 1);
  const cells: { key: string; node: ReactNode }[] = [
    { key: "main", node: <ChatPanel project={project} workingInPanel={workingInPanel} /> },
    ...visible.map((p) => ({ key: p.id, node: <PaneChat pane={p} mainProject={project} /> })),
  ];
  const spans = rows.flatMap((count) => Array.from({ length: count }, () => cols / count));

  return (
    <SplitLayoutContext.Provider value={layout}>
      <div className="flex h-full min-h-0 flex-col">
        {hidden.length > 0 && <HiddenPanes panes={hidden} />}
        <div
          ref={gridRef}
          className={cn("grid min-h-0 flex-1", cells.length > 1 && "gap-px bg-border")}
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows.length}, minmax(0, 1fr))` }}
        >
          {cells.map((c, i) => (
            // Keyed by pane, so a chat keeps its state when the grid rearranges around it.
            <div key={c.key} className="min-h-0 min-w-0 overflow-hidden bg-bg" style={{ gridColumn: `span ${spans[i] ?? cols}` }}>
              {c.node}
            </div>
          ))}
        </div>
      </div>
    </SplitLayoutContext.Provider>
  );
}

/** Chats that do not fit at the current window size; they come back by themselves when it grows. */
function HiddenPanes({ panes }: { panes: SplitPane[] }) {
  const close = useUi((s) => s.closeSplitPane);
  const text =
    panes.length === 1
      ? "Ein weiterer Chat ist ausgeblendet, das Fenster ist zu klein. Mit mehr Platz erscheint er wieder."
      : `${panes.length} weitere Chats sind ausgeblendet, das Fenster ist zu klein. Mit mehr Platz erscheinen sie wieder.`;
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

function PaneChat({ pane, mainProject }: { pane: SplitPane; mainProject: Project }) {
  if (!pane.projectId) return <PanePicker pane={pane} mainProject={mainProject} />;
  return <PaneProject pane={pane} projectId={pane.projectId} />;
}

function PaneProject({ pane, projectId }: { pane: SplitPane; projectId: string }) {
  const project = useProject(projectId);
  const close = useUi((s) => s.closeSplitPane);
  const missing = project.error instanceof RpcCallError && project.error.code === "NOT_FOUND";
  useEffect(() => {
    // The project was removed meanwhile: its pane goes with it.
    if (missing) close(pane.id);
  }, [missing, close, pane.id]);

  if (project.isLoading) return <ChatPanelSkeleton />;
  if (!project.data) {
    return (
      <PaneMessage pane={pane}>
        <div className="p-4">
          <ErrorBanner title="Projekt nicht geladen">{errorMessage(project.error)}</ErrorBanner>
        </div>
      </PaneMessage>
    );
  }
  if (!project.data.exists) {
    return (
      <PaneMessage pane={pane}>
        <EmptyState icon={<FolderX className="h-9 w-9" />} title="Chat nicht verfügbar">
          Der Projektordner von {project.data.name} fehlt.
        </EmptyState>
      </PaneMessage>
    );
  }
  return <ChatPanel project={project.data} pane={pane} />;
}

/** A pane without a chat (error, missing folder): the bar keeps the way to close it. */
function PaneMessage({ pane, children }: { pane: SplitPane; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneBar pane={pane} title="Chat" />
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}

function PaneBar({ pane, title }: { pane: SplitPane; title: string }) {
  const close = useUi((s) => s.closeSplitPane);
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-body">{title}</span>
      <Tooltip content="Bereich schließen">
        <Button size="icon-sm" variant="ghost" aria-label="Bereich schließen" onClick={() => close(pane.id)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}

/** Sessions on screen in the workspace (main chat and panes), as "projectId\nactive" keys. */
function useShownKeys(): ReadonlySet<string> {
  const key = useUi((s) => {
    const shown = s.splitPanes.filter((p) => p.projectId && p.active).map((p) => `${p.projectId}\n${p.active}`);
    if (s.activeProjectId && s.activeSession[s.activeProjectId]) shown.push(`${s.activeProjectId}\n${s.activeSession[s.activeProjectId]}`);
    return shown.sort().join("\t");
  });
  return useMemo(() => new Set(key ? key.split("\t") : []), [key]);
}

/** A new pane: running sessions of all projects and the recent ones of the open project, not yet on screen. */
function PanePicker({ pane, mainProject }: { pane: SplitPane; mainProject: Project }) {
  const live = useLiveSessions();
  const recent = useSessions(mainProject.id);
  const setPane = useUi((s) => s.setSplitPane);
  const shown = useShownKeys();
  const free = (projectId: string, id: string) => !shown.has(`${projectId}\n${id}`);
  const running = (live.data ?? []).filter((s) => free(s.projectId, s.id));
  const liveIds = new Set((live.data ?? []).map((s) => s.id));
  const earlier = (recent.data?.sessions ?? []).filter((s) => !liveIds.has(s.id) && free(s.projectId, s.id)).slice(0, 8);
  const loading = live.isPending || recent.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PaneBar pane={pane} title="Chat wählen" />
      <div className="min-h-0 flex-1 animate-view-in overflow-y-auto px-4 py-4">
        <div className="mx-auto flex max-w-xl flex-col gap-5">
          <Button variant="outline" className="justify-start gap-2" onClick={() => setPane(pane.id, mainProject.id, null)}>
            <MessageSquarePlus className="h-4 w-4" />
            <span className="truncate">Neue Session in {mainProject.name}</span>
          </Button>
          {loading ? (
            <PickerSkeleton />
          ) : (
            <>
              {running.length > 0 && (
                <PickerSection title="Laufende Sessions">
                  {running.map((s) => (
                    <PickerRow
                      key={s.id}
                      projectId={s.projectId}
                      projectName={s.projectName}
                      title={s.title}
                      hint={sessionStatusLabel(s.status, s.live, s.autoContinueAt)}
                      live
                      onPick={() => setPane(pane.id, s.projectId, s.id)}
                    />
                  ))}
                </PickerSection>
              )}
              {earlier.length > 0 && (
                <PickerSection title={`Zuletzt in ${mainProject.name}`}>
                  {earlier.map((s) => (
                    <PickerRow key={s.id} projectId={mainProject.parentId ?? mainProject.id} projectName={mainProject.name} title={s.title} hint={relativeTime(s.updatedAt)} onPick={() => setPane(pane.id, s.projectId, s.id)} />
                  ))}
                </PickerSection>
              )}
              {!running.length && !earlier.length && (
                <p className="text-center text-body text-muted">Alle Sessions sind schon auf dem Bildschirm. Starte hier eine neue.</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
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

function PickerRow({ projectId, projectName, title, hint, live = false, onPick }: { projectId: string; projectName: string; title: string | null; hint: string; live?: boolean; onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} className="flex h-9 min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-body text-muted transition-colors duration-120 hover:bg-surface-2 hover:text-fg">
      <ProjectIcon id={projectId} name={projectName} size={18} className="rounded-md" />
      <span className={cn("min-w-0 flex-1 truncate", !live && "italic")}>{title ?? "Ohne Titel"}</span>
      <span className="shrink-0 truncate text-caption text-subtle">{live ? `${projectName}, ${hint}` : hint}</span>
    </button>
  );
}

/** Two short sections of rows, at the sizes of PickerRow. */
function PickerSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[3, 4].map((rows) => (
        <div key={rows} className="flex flex-col gap-1">
          <Skeleton className="mx-2 mb-1 h-3 w-28" />
          <ListSkeleton rows={rows} className="gap-0 p-0 [&>div]:h-9 [&>div]:px-2" label="Lädt Sessions" />
        </div>
      ))}
    </div>
  );
}

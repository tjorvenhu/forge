import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as D from "@radix-ui/react-dialog";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Blocks,
  Bot,
  CornerDownLeft,
  FileText,
  FolderKanban,
  FolderPlus,
  GitBranch,
  GitPullRequest,
  History,
  Home,
  MessageSquarePlus,
  PanelBottom,
  PanelRight,
  Play,
  Search,
  Settings,
  Settings2,
  Shield,
  Shrink,
  Square,
  SquareTerminal,
} from "lucide-react";
import type { ProfileId, ResultOf, SearchHit } from "@forge/protocol";
import { call, keys, useProjects, useSearch } from "@/lib/queries";
import { errorMessage } from "@/lib/rpc";
import { cn, relativeTime } from "@/lib/utils";
import { useUi, type View } from "@/stores/ui";
import { toast } from "@/stores/toast";
import { Kbd, Spinner } from "@/components/ui/misc";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { PROFILE_IDS, PROFILE_INFO } from "@/components/projects/ProfileBadge";
import { openSearchHit, Snippet } from "@/components/search/SearchHits";

type Group = "Aktionen" | "Projekte" | "Sessions" | "In Verläufen";

interface Entry {
  id: string;
  group: Group;
  label: string;
  /** extra words the filter matches on */
  keywords?: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
  /** full-text hits are already filtered by the sidecar */
  hit?: SearchHit;
}

const GROUP_ORDER: Group[] = ["Aktionen", "Projekte", "Sessions", "In Verläufen"];

/** Lowercase without accents, so "uberblick" finds "Überblick". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function matches(entry: Entry, words: string[]): boolean {
  const hay = fold(`${entry.label} ${entry.keywords ?? ""} ${entry.hint ?? ""}`);
  return words.every((w) => hay.includes(w));
}

const NAV: Array<{ view: View; label: string; icon: ReactNode }> = [
  { view: "home", label: "Home", icon: <Home className="h-4 w-4" /> },
  { view: "projects", label: "Projekte", icon: <FolderKanban className="h-4 w-4" /> },
  { view: "sessions", label: "Sessions", icon: <History className="h-4 w-4" /> },
  { view: "github", label: "GitHub", icon: <GitPullRequest className="h-4 w-4" /> },
  { view: "agents", label: "Agenten", icon: <Bot className="h-4 w-4" /> },
  { view: "mcp", label: "Erweiterungen", icon: <Blocks className="h-4 w-4" /> },
  { view: "settings", label: "Einstellungen", icon: <Settings className="h-4 w-4" /> },
];

async function setProfile(qc: QueryClient, id: string, profile: ProfileId) {
  try {
    await call("projects.update", { projectId: id, profile });
    void qc.invalidateQueries({ queryKey: keys.project(id) });
    void qc.invalidateQueries({ queryKey: keys.projects });
    toast.success(`Profil ${PROFILE_INFO[profile].label}`, "Gilt sofort, auch für laufende Sessions.");
  } catch (e) {
    toast.error("Profil nicht geändert", errorMessage(e));
  }
}

/** Ctrl+K: jump to projects, sessions and messages, or run an action, from anywhere. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <D.Content
          className="fixed left-1/2 top-[12vh] z-50 flex max-h-[70vh] w-[640px] max-w-[92vw] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
          aria-describedby={undefined}
        >
          <D.Title className="sr-only">Befehlspalette</D.Title>
          {open && <PaletteBody onClose={() => setOpen(false)} />}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const view = useUi((s) => s.view);
  const activeProjectId = useUi((s) => s.activeProjectId);
  const activeSessions = useUi((s) => s.activeSession);
  const projects = useProjects();
  const sessions = useQuery({ queryKey: keys.allSessions("", "all"), queryFn: () => call("sessions.listAll", {}), staleTime: 10_000 });
  const hits = useSearch(query, 8);
  const projectId = view === "workspace" ? activeProjectId : null;
  const project = projects.data?.find((p) => p.id === projectId) ?? null;
  const devServer = useQuery({ queryKey: keys.devServer(projectId ?? ""), queryFn: () => call("devserver.state", { projectId: projectId! }), enabled: !!projectId });
  const activeSessionId = projectId ? (activeSessions[projectId] ?? null) : null;
  const activeSession = activeSessionId ? qc.getQueryData<ResultOf<"sessions.get">>(keys.session(activeSessionId)) : undefined;

  const entries = useMemo(() => {
    // Actions read the store when they run, so the list does not depend on unrelated UI state.
    const ui = useUi.getState();
    const list: Entry[] = [];
    const act = (id: string, label: string, icon: ReactNode, run: () => void, extra: Partial<Entry> = {}) => list.push({ id, group: "Aktionen", label, icon, run, ...extra });

    if (project) {
      act("new-session", `Neue Session in ${project.name}`, <MessageSquarePlus className="h-4 w-4" />, () => {
        ui.setActiveSession(project.id, null);
        ui.setWorkspaceTab("chat");
        requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
      }, { hint: "Strg+N", keywords: "chat starten" });
      if (activeSession?.live && activeSession.status === "idle") {
        act("compact", "Kontext komprimieren", <Shrink className="h-4 w-4" />, () => {
          call("sessions.send", { sessionId: activeSession.id, text: "/compact", attachments: [] }).catch((e: unknown) => toast.error("Komprimieren fehlgeschlagen", errorMessage(e)));
        }, { keywords: "compact zusammenfassen" });
      }
      const dev = devServer.data;
      if (dev?.status === "running") {
        act("dev-stop", "Dev-Server stoppen", <Square className="h-4 w-4" />, () => {
          call("devserver.stop", { projectId: project.id }).then((s) => qc.setQueryData(keys.devServer(project.id), s)).catch((e: unknown) => toast.error("Dev-Server nicht gestoppt", errorMessage(e)));
        });
      } else if (dev?.effectiveCommand) {
        act("dev-start", "Dev-Server starten", <Play className="h-4 w-4" />, () => {
          call("devserver.start", { projectId: project.id }).then((s) => qc.setQueryData(keys.devServer(project.id), s)).catch((e: unknown) => toast.error("Dev-Server nicht gestartet", errorMessage(e)));
        }, { hint: dev.effectiveCommand });
      }
      act("tab-git", "Git öffnen", <GitBranch className="h-4 w-4" />, () => ui.setWorkspaceTab("git"), { hint: "Strg+2", keywords: "commit diff änderungen" });
      act("tab-files", "Dateien öffnen", <FileText className="h-4 w-4" />, () => ui.setWorkspaceTab("files"), { hint: "Strg+3" });
      act("tab-settings", "Projekt-Einstellungen", <Settings2 className="h-4 w-4" />, () => ui.setWorkspaceTab("settings"), { hint: "Strg+4", keywords: "claude.md tags testbefehl" });
      act("terminal", "Terminal öffnen", <SquareTerminal className="h-4 w-4" />, () => ui.openTerminal(project.id, "shell"), { keywords: "shell konsole" });
      act("bottom", "Unteres Panel ein- oder ausblenden", <PanelBottom className="h-4 w-4" />, () => ui.toggleBottomPanel(), { hint: "Strg+J" });
      act("right", "Seitenleiste ein- oder ausblenden", <PanelRight className="h-4 w-4" />, () => ui.toggleRightPanel(), { hint: "Strg+Umschalt+E" });
      for (const p of PROFILE_IDS) {
        if (p === project.profile || (p === "autonomous" && project.tags.includes("sandbox-only"))) continue;
        act(`profile-${p}`, `Profil wechseln: ${PROFILE_INFO[p].label}`, <Shield className="h-4 w-4" />, () => void setProfile(qc, project.id, p), { keywords: "rechte permission" });
      }
    }
    act("add-project", "Projekt hinzufügen", <FolderPlus className="h-4 w-4" />, () => ui.setNewProject("import"), { hint: "Strg+O", keywords: "importieren ordner" });
    act("create-project", "Neues Projekt anlegen", <FolderPlus className="h-4 w-4" />, () => ui.setNewProject("create"));
    for (const n of NAV) act(`nav-${n.view}`, `Gehe zu ${n.label}`, n.icon, () => ui.setView(n.view));

    for (const p of projects.data ?? []) {
      list.push({
        id: `project-${p.id}`,
        group: "Projekte",
        label: p.name,
        keywords: `${p.path} ${p.technologies.join(" ")} ${p.tags.join(" ")}`,
        hint: p.git?.branch ?? undefined,
        icon: <ProjectIcon name={p.name} size={18} />,
        run: () => ui.openProject(p.id),
      });
    }
    for (const s of sessions.data ?? []) {
      list.push({
        id: `session-${s.id}`,
        group: "Sessions",
        label: s.title ?? "Ohne Titel",
        keywords: s.projectName,
        hint: `${s.projectName} · ${relativeTime(s.updatedAt)}`,
        icon: <History className="h-4 w-4" />,
        run: () => ui.openProject(s.projectId, s.id),
      });
    }
    return list;
  }, [project, projects.data, sessions.data, devServer.data, activeSession, qc]);

  const shown = useMemo(() => {
    const words = fold(query).split(/\s+/).filter(Boolean);
    const caps: Record<Group, number> = words.length ? { Aktionen: 6, Projekte: 6, Sessions: 8, "In Verläufen": 8 } : { Aktionen: 6, Projekte: 5, Sessions: 5, "In Verläufen": 0 };
    const out: Entry[] = [];
    for (const g of GROUP_ORDER) {
      if (g === "In Verläufen") continue;
      out.push(...entries.filter((e) => e.group === g && (!words.length || matches(e, words))).slice(0, caps[g]));
    }
    if (query.trim().length >= 3) {
      for (const h of (hits.data ?? []).slice(0, caps["In Verläufen"])) {
        out.push({ id: `hit-${h.sessionId}-${h.seq}`, group: "In Verläufen", label: h.snippet, icon: null, hit: h, run: () => openSearchHit(h) });
      }
    }
    return out;
  }, [entries, query, hits.data]);

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

  let lastGroup: Group | null = null;
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
          placeholder="Projekt, Session, Aktion oder Text aus einem Verlauf"
          aria-label="Befehlspalette durchsuchen"
          className="h-12 min-w-0 flex-1 bg-transparent text-[14px] text-fg placeholder:text-subtle focus:outline-none"
        />
        {hits.isFetching && <Spinner className="h-3.5 w-3.5" />}
      </div>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="Ergebnisse">
        {shown.length === 0 && <div className="px-3 py-6 text-center text-[13px] text-muted">Nichts gefunden.</div>}
        {shown.map((e, i) => {
          const header = e.group !== lastGroup ? e.group : null;
          lastGroup = e.group;
          return (
            <div key={e.id}>
              {header && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{header}</div>}
              <button
                data-index={i}
                role="option"
                aria-selected={i === index}
                onMouseMove={() => i !== index && setIndex(i)}
                onClick={() => runAt(i)}
                className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left", i === index ? "bg-surface-3" : "")}
              >
                {e.hit ? (
                  <span className="min-w-0 flex-1">
                    <Snippet text={e.hit.snippet} className="line-clamp-1 block text-[13px]" />
                    <span className="block truncate text-[11px] text-subtle">
                      {e.hit.role === "user" ? "Du" : "Claude"} · {e.hit.sessionTitle ?? "Ohne Titel"} · {e.hit.projectName}
                    </span>
                  </span>
                ) : (
                  <>
                    <span className="flex w-5 shrink-0 justify-center text-muted">{e.icon}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">{e.label}</span>
                    {e.hint && <span className="max-w-56 shrink-0 truncate text-[11px] text-subtle">{e.hint}</span>}
                  </>
                )}
                {i === index && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-subtle" />}
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-subtle">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> auswählen
        </span>
        <span>
          <Kbd>Enter</Kbd> ausführen
        </span>
        <span>
          <Kbd>Esc</Kbd> schließen
        </span>
        <span className="flex-1 text-right">Ab drei Zeichen werden auch die Verläufe durchsucht.</span>
      </div>
    </>
  );
}

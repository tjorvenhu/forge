import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Blocks, FileText, GitBranch, History, PackageSearch, PenLine, Server } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, keys, useProjects } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";
import { useUi } from "@/stores/ui";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { checkoutBranch } from "@/components/git/GitCenter";
import type { PaletteEntry } from "./palette-actions";

/** Folders the file search does not descend into: generated or installed, rarely what one looks for. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "vendor", "__pycache__", ".git", ".next", ".turbo", ".venv", ".cache"]);
/** Dot folders that hold project files worth finding. */
const DOT_DIRS = new Set([".github", ".claude", ".forge", ".vscode"]);
const MAX_DIR_CALLS = 150;
const MAX_FILES = 3000;
/** Folders listed at once; each is one call to the sidecar. */
const BATCH = 8;

type FileItem = { name: string; path: string };

/** Files of a project, breadth first, so shallow files come first when a cap is reached. */
export async function crawlFiles(list: (dir: string) => Promise<Array<FileItem & { isDir: boolean }>>): Promise<FileItem[]> {
  const files: FileItem[] = [];
  const queue = [""];
  let calls = 0;
  while (queue.length && calls < MAX_DIR_CALLS && files.length < MAX_FILES) {
    const batch = queue.splice(0, Math.min(BATCH, MAX_DIR_CALLS - calls));
    calls += batch.length;
    const listed = await Promise.all(batch.map((dir) => list(dir).catch(() => [])));
    for (const entries of listed) {
      for (const e of entries) {
        if (!e.isDir) files.push({ name: e.name, path: e.path });
        else if (!SKIP_DIRS.has(e.name) && (!e.name.startsWith(".") || DOT_DIRS.has(e.name))) queue.push(e.path);
      }
    }
  }
  return files.slice(0, MAX_FILES);
}

/**
 * Entries loaded from the sidecar: projects, sessions, and once something is typed, branches,
 * knowledge and files of the open project as well as MCP servers and skills. `loading` is true while
 * one of the sources the query needs has no data yet.
 */
export function usePaletteSources(query: string, project: ProjectWithStatus | null) {
  const qc = useQueryClient();
  const typed = query.trim().length >= 2;
  const activeProjectId = useUi((s) => s.activeProjectId);
  const extProjectId = activeProjectId ?? undefined;
  const owner = project ? (project.parentId ?? project.id) : null;

  const projects = useProjects();
  const sessions = useQuery({ queryKey: keys.allSessions("", "all"), queryFn: () => call("sessions.listAll", {}), staleTime: 10_000 });
  const branches = useQuery({
    queryKey: keys.branches(project?.id ?? ""),
    queryFn: () => call("git.branches", { projectId: project!.id }),
    enabled: typed && !!project?.git?.isRepo,
    retry: false,
  });
  const knowledge = useQuery({
    queryKey: keys.knowledge(owner ?? ""),
    queryFn: () => call("knowledge.list", { projectId: owner! }),
    enabled: typed && !!owner,
    staleTime: 60_000,
  });
  const files = useQuery({
    queryKey: ["paletteFiles", project?.id ?? ""],
    queryFn: () => crawlFiles((dir) => call("projects.listFiles", { projectId: project!.id, dir })),
    enabled: typed && !!project?.exists,
    staleTime: 60_000,
  });
  // Same keys as the Erweiterungen view, so both share what is loaded.
  const mcp = useQuery({ queryKey: ["mcp", extProjectId ?? "global"], queryFn: () => call("mcp.list", { projectId: extProjectId }), enabled: typed, staleTime: 60_000 });
  const skills = useQuery({ queryKey: ["docs", "skill", extProjectId ?? "global"], queryFn: () => call("config.docs", { kind: "skill", projectId: extProjectId }), enabled: typed });
  const plugins = useQuery({ queryKey: ["plugins"], queryFn: () => call("plugins.catalog", {}), enabled: typed, staleTime: 10 * 60_000 });

  const entries = useMemo(() => {
    const ui = useUi.getState();
    const list: PaletteEntry[] = [];
    for (const p of projects.data ?? []) {
      list.push({
        id: `project-${p.id}`,
        group: "Projekte",
        label: p.name,
        keywords: `${p.path} ${p.technologies.join(" ")} ${p.tags.join(" ")}`,
        hint: p.git?.branch ?? undefined,
        icon: <ProjectIcon id={p.parentId ?? p.id} name={p.name} size={18} />,
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
    if (project) {
      const id = project.id;
      for (const b of branches.data ?? []) {
        if (b.current) continue;
        list.push({
          id: `branch-${b.name}`,
          group: "Aktionen",
          label: `Branch wechseln: ${b.name}`,
          keywords: "git checkout",
          hint: b.upstream ?? undefined,
          icon: <GitBranch className="h-4 w-4" />,
          run: () => {
            checkoutBranch(id, b.name, false)
              .then(() => {
                void qc.invalidateQueries({ queryKey: keys.git(id) });
                void qc.invalidateQueries({ queryKey: keys.branches(id) });
                void qc.invalidateQueries({ queryKey: keys.log(id) });
                void qc.invalidateQueries({ queryKey: keys.projects });
              })
              .catch(() => {});
          },
        });
      }
      for (const k of knowledge.data ?? []) {
        list.push({
          id: `knowledge-${k.id}`,
          group: "Wissen",
          label: k.title,
          keywords: `${k.summary} ${k.tags.join(" ")}`,
          hint: k.tags.slice(0, 3).join(", ") || undefined,
          icon: <BookOpen className="h-4 w-4" />,
          run: () => ui.openKnowledge(k.id),
        });
      }
      for (const f of files.data ?? []) {
        const dir = f.path.slice(0, -f.name.length).replace(/\/$/, "");
        list.push({
          id: `file-${f.path}`,
          group: "Dateien",
          label: f.name,
          keywords: dir,
          hint: dir || undefined,
          icon: <FileText className="h-4 w-4" />,
          run: () => ui.openFile(id, f.path),
        });
      }
    }
    for (const m of mcp.data ?? []) {
      list.push({
        id: `mcp-${m.name}`,
        group: "Erweiterungen",
        label: m.name,
        keywords: `mcp server ${m.target}`,
        hint: `MCP Server · ${m.statusText}`,
        icon: <Server className="h-4 w-4" />,
        run: () => ui.openExtensions("mcp"),
      });
    }
    for (const s of skills.data ?? []) {
      list.push({
        id: `skill-${s.scope}-${s.name}`,
        group: "Erweiterungen",
        label: s.name,
        keywords: `skill ${s.description ?? ""}`,
        hint: s.scope === "project" ? "Eigener Skill im Projekt" : "Eigener Skill",
        icon: <PenLine className="h-4 w-4" />,
        run: () => ui.openExtensions("skills", "own"),
      });
    }
    for (const p of plugins.data ?? []) {
      list.push({
        id: `plugin-${p.id}`,
        group: "Erweiterungen",
        label: p.name,
        keywords: `skill plugin marketplace ${p.marketplace} ${p.description}`,
        hint: p.installed ? "installiert" : `Marketplace · ${p.marketplace}`,
        icon: p.installed ? <Blocks className="h-4 w-4" /> : <PackageSearch className="h-4 w-4" />,
        run: () => ui.openExtensions("skills", "marketplace"),
      });
    }
    return list;
  }, [projects.data, sessions.data, project, branches.data, knowledge.data, files.data, mcp.data, skills.data, plugins.data, qc]);

  const pending = [branches, knowledge, files, mcp, skills, plugins].some((q) => q.isLoading);
  return { entries, loading: typed && pending };
}

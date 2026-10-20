import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Blocks, CheckCheck, FileText, FolderMinus, Folders, GitBranch, GitCommitHorizontal, History, PackageSearch, Pencil, PenLine, Server, Sparkles } from "lucide-react";
import type { ProjectWithStatus } from "@forge/protocol";
import { call, keys, useKnowledgeStale, useProjects } from "@/lib/queries";
import { relativeTime } from "@/lib/utils";
import { knowledgeFixRequest, useUi } from "@/stores/ui";
import { useProjectGroupDialogs } from "@/stores/project-groups";
import { groupKey, groupProjects } from "@/lib/project-tree";
import { markKnowledgeChecked } from "@/components/knowledge/knowledge-actions";
import { refsMissingLabel, staleById } from "@/components/knowledge/knowledge-text";
import { ProjectIcon } from "@/components/projects/ProjectIcon";
import { checkoutBranch, LOG_LIMIT } from "@/components/git/GitCenter";
import type { PaletteEntry } from "./palette-actions";
import { t } from "@/i18n";

/** All files of a project, shared by the palette and file links in the chat. */
export const projectFilesQuery = (projectId: string) => ({
  queryKey: ["paletteFiles", projectId],
  queryFn: async () => (await call("projects.allFiles", { projectId })).files,
  staleTime: 60_000,
});

/**
 * Entries loaded from the sidecar: projects, sessions, and once something is typed, branches, commits,
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
  // Same key and limit as the Git tab, so a commit found here is in its history.
  const commits = useQuery({
    queryKey: keys.log(project?.id ?? ""),
    queryFn: () => call("git.log", { projectId: project!.id, limit: LOG_LIMIT }),
    enabled: typed && !!project?.git?.isRepo,
    retry: false,
  });
  const knowledge = useQuery({
    queryKey: keys.knowledge(owner ?? ""),
    queryFn: () => call("knowledge.list", { projectId: owner! }),
    enabled: typed && !!owner,
    staleTime: 60_000,
  });
  const stale = useKnowledgeStale(owner ?? "", typed && !!knowledge.data?.length);
  const files = useQuery({ ...projectFilesQuery(project?.id ?? ""), enabled: typed && !!project?.exists });
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
        keywords: `${p.path} ${p.group ?? ""} ${p.technologies.join(" ")} ${p.tags.join(" ")}`,
        hint: [p.group, p.git?.branch].filter(Boolean).join(" · ") || undefined,
        icon: <ProjectIcon id={p.parentId ?? p.id} name={p.name} size={18} />,
        run: () => ui.openProject(p.id),
      });
    }
    const groups = useProjectGroupDialogs.getState();
    const gm = t.projects.groups;
    for (const g of groupProjects((projects.data ?? []).filter((p) => !p.parentId))) {
      const name = g.name;
      if (!name) continue;
      const keywords = `gruppe kunde projektgruppe group client customer ${g.projects.map((p) => p.name).join(" ")}`;
      list.push({ id: `group-${g.key}`, group: "Projekte", label: gm.showNamed(name), keywords, hint: gm.count(g.projects.length), icon: <Folders className="h-4 w-4" />, run: () => ui.showProjectGroup(groupKey(name)) });
      list.push({ id: `group-rename-${g.key}`, group: "Aktionen", label: gm.renameNamed(name), keywords: `${keywords} umbenennen rename`, icon: <Pencil className="h-4 w-4" />, run: () => groups.openRename(name) });
      list.push({ id: `group-dissolve-${g.key}`, group: "Aktionen", label: gm.dissolveNamed(name), keywords: `${keywords} auflösen löschen entfernen dissolve delete remove`, icon: <FolderMinus className="h-4 w-4" />, run: () => groups.openDissolve(name) });
    }
    for (const s of sessions.data ?? []) {
      list.push({
        id: `session-${s.id}`,
        group: "Sessions",
        label: s.title ?? t.layout.sources.untitled,
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
          label: t.layout.sources.switchBranch(b.name),
          keywords: "branch wechseln git checkout switch",
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
      for (const c of commits.data ?? []) {
        list.push({
          id: `commit-${c.hash}`,
          group: "Commits",
          label: c.subject,
          keywords: `${c.shortHash} ${c.hash} ${c.author} ${c.refs.join(" ")} git commit`,
          hint: `${c.shortHash} · ${relativeTime(c.date)}`,
          icon: <GitCommitHorizontal className="h-4 w-4" />,
          run: () => ui.openCommit(id, c.hash),
        });
      }
      const missing = staleById(stale.data);
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
        const refs = missing.get(k.id);
        if (!refs || !owner) continue;
        list.push({
          id: `knowledge-fix-${k.id}`,
          group: "Wissen",
          label: t.layout.sources.checkWithClaude(k.title),
          keywords: `veraltet verweise korrigieren outdated references fix ${refs.map((r) => r.ref).join(" ")}`,
          hint: refsMissingLabel(refs.length),
          icon: <Sparkles className="h-4 w-4" />,
          run: () => ui.openKnowledge(knowledgeFixRequest(k.id)),
        });
        list.push({
          id: `knowledge-checked-${k.id}`,
          group: "Wissen",
          label: t.layout.sources.markChecked(k.title),
          keywords: "veraltet verweise fehlalarm geprüft outdated references false alarm checked",
          hint: refsMissingLabel(refs.length),
          icon: <CheckCheck className="h-4 w-4" />,
          run: () => void markKnowledgeChecked(qc, owner, k.id),
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
        hint: t.layout.sources.mcpServer(m.statusText),
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
        hint: s.scope === "project" ? t.layout.sources.ownSkillProject : t.layout.sources.ownSkill,
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
        hint: p.installed ? t.layout.sources.installed : t.layout.sources.marketplace(p.marketplace),
        icon: p.installed ? <Blocks className="h-4 w-4" /> : <PackageSearch className="h-4 w-4" />,
        run: () => ui.openExtensions("skills", "marketplace"),
      });
    }
    return list;
  }, [projects.data, sessions.data, project, branches.data, commits.data, knowledge.data, stale.data, owner, files.data, mcp.data, skills.data, plugins.data, qc]);

  const pending = [branches, commits, knowledge, files, mcp, skills, plugins].some((q) => q.isLoading);
  return { entries, loading: typed && pending };
}

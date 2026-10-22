import path from "node:path";
import type { KnowledgeMissingRef, Project, ServerEvent, Session, SessionEventBody } from "@forge/protocol";
import { z } from "zod";
import { slugify, type WorktreeService } from "../automation/worktrees.js";
import type { AgentFinisher } from "../automation/agent-finish.js";
import { autoMergeOn } from "../automation/agent-auto-merge.js";
import type { SessionTool } from "../claude/runtime.js";
import type { Db, SessionRecord } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { lastAnswer } from "../phone/session-info.js";
import type { StartParams } from "./lifecycle.js";
import { KNOWLEDGE_DIR, type KnowledgeStore } from "../knowledge/knowledge.js";
import type { DevAction, DevEnvironment, DevTarget } from "../devtools/environment.js";
import { MAX_STEP_MS, type PreviewService, type PreviewStep } from "../preview/preview.js";
import { tr } from "../i18n/index.js";

/** dev_environment with wait: an install without a shared store can take minutes. */
const SETUP_WAIT_MS = 4 * 60_000;

/**
 * Which sessions were started as agents by which session. Stored with the session, so agents stay
 * agents after a restart; deleting the starting session turns them into plain sessions.
 */
export class AgentRegistry {
  /** worktree project -> session that asked for it; known before the agent's session exists */
  private readonly byProject = new Map<string, string>();

  constructor(private readonly db: Db) {}

  reserve(projectId: string, parentId: string) {
    this.byProject.set(projectId, parentId);
  }

  adopt(childId: string, projectId: string) {
    const parent = this.byProject.get(projectId);
    if (!parent) return;
    this.db.setSessionParent(childId, parent);
    this.byProject.delete(projectId);
  }

  /** The session that started this one (by session, or by its worktree while it is being started). */
  parent(rec: Pick<SessionRecord, "id" | "projectId">): string | null {
    return this.db.getSessionParent(rec.id) ?? this.byProject.get(rec.projectId) ?? null;
  }

  children(parentId: string): string[] {
    return this.db.listSessionChildren(parentId);
  }

  /** A failed start leaves no reservation behind. */
  release(projectId: string) {
    this.byProject.delete(projectId);
  }
}

/** Project services the FORGE tools reach; wired after the session service (see app.ts). */
export interface ProjectToolDeps {
  knowledge: KnowledgeStore;
  dev: DevEnvironment;
  preview?: PreviewService | null;
}

export interface ForgeToolDeps {
  db: Db;
  projects: ProjectManager;
  worktrees: WorktreeService;
  agents: AgentRegistry;
  start(params: StartParams): Promise<Session>;
  send(sessionId: string, text: string): Promise<unknown>;
  record(sessionId: string, body: SessionEventBody): void;
  emit(e: ServerEvent): void;
  project?: ProjectToolDeps | null;
  finisher?: AgentFinisher | null;
  /** Plan usage as text for usage_status. */
  usage?: (() => Promise<string>) | null;
  /** A notice when the limit forecast runs full before the reset; added to start_agent, never blocks it. */
  limitWarning?: (() => Promise<string | null>) | null;
  report?: DailyReportText | null;
}

/** The daily report as text: projectId null covers all projects; date JJJJ-MM-TT, today without it. */
export type DailyReportText = (projectId: string | null, date?: string) => Promise<string>;

/** Knowledge and dev tools of the session's project, with the lines of start context that explain them. */
export function projectTools(rec: SessionRecord, p: ProjectToolDeps): { tools: SessionTool[]; context: string[] } {
  const projectId = rec.projectId;
  const m = tr().core.forgeTools;
  const inWorktree = p.knowledge.owner(projectId) !== projectId;
  const knowledgeSearch: SessionTool = {
    name: "knowledge_search",
    description: m.knowledgeSearchDescription,
    shape: {
      query: z.string().min(1).max(200).describe(m.knowledgeSearchQuery),
      limit: z.number().int().min(1).max(20).optional(),
    },
    autoAllow: true,
    run: async (a) => {
      const hits = p.knowledge.search(projectId, String(a.query), typeof a.limit === "number" ? a.limit : 8);
      if (!hits.length) return m.knowledgeSearchNone;
      const gone = await missingRefs(hits.map((h) => h.id));
      return hits
        .map((h) => {
          const refs = gone.get(h.id);
          return `${h.id}: ${h.title}${h.tags.length ? ` [${h.tags.join(", ")}]` : ""}\n  ${h.summary}\n  ${h.snippet}${refs ? `\n  ${m.knowledgeSearchStale(refs)}` : ""}`;
        })
        .join("\n");
    },
  };
  /** Missing refs per entry as a short list; a failed check must not break reading the knowledge. */
  const missingRefs = async (ids: string[]): Promise<Map<string, string>> => {
    const report = await p.knowledge.staleness(projectId, { ids }).catch(() => null);
    const out = new Map<string, string>();
    for (const e of report?.entries ?? []) if (e.missing.length) out.set(e.id, e.missing.map((m) => `\`${m.ref}\``).join(", "));
    return out;
  };
  const knowledgeRead: SessionTool = {
    name: "knowledge_read",
    description: m.knowledgeReadDescription,
    shape: { id: z.string().min(1).max(80).describe(m.knowledgeReadId) },
    autoAllow: true,
    run: async (a) => {
      const e = await p.knowledge.read(projectId, String(a.id));
      const refs = (await missingRefs([e.id])).get(e.id);
      const stale = refs
        ? `\n${m.knowledgeReadStale(refs)}`
        : "";
      return `# ${e.title}\n${m.knowledgeReadSummary}: ${e.summary}\n${m.knowledgeReadTags}: ${e.tags.join(", ") || m.knowledgeReadNoTags}\n${m.knowledgeReadUpdated}: ${e.updatedAt.slice(0, 10)}${stale}\n\n${e.content}`;
    },
  };
  const knownTags = p.knowledge.tags(projectId).slice(0, 30);
  // A worktree has no knowledge folder of its own; a relative path would point into the wrong checkout.
  const fileOf = (id: string) => (inWorktree ? path.join(p.knowledge.dir(projectId), `${id}.md`) : `${KNOWLEDGE_DIR.replace(/\\/g, "/")}/${id}.md`);
  const entryFields = {
    title: z.string().min(3).max(120).describe(m.entryTitle),
    summary: z.string().min(5).max(300).describe(m.entrySummary),
    tags: z.array(z.string().max(40)).max(8).optional().describe(m.entryTags(knownTags)),
    content: z.string().min(1).max(50_000).describe(m.entryContent),
  };
  const overlapHint = (text: { title: string; summary: string; tags: string[]; content: string }, except: string[]) => {
    const near = p.knowledge.covering(projectId, text, except).slice(0, 3);
    return near.length ? m.overlapHint(near.map((n) => `${n.id} (${n.title})`).join(", ")) : "";
  };
  const knowledgeSave: SessionTool = {
    name: "knowledge_save",
    description: m.knowledgeSaveDescription,
    shape: {
      id: z.string().max(80).optional().describe(m.knowledgeSaveId),
      ...entryFields,
      force: z.boolean().optional().describe(m.knowledgeSaveForce),
    },
    autoAllow: true,
    run: async (a) => {
      const id = typeof a.id === "string" && a.id.trim() ? a.id.trim() : null;
      const title = String(a.title);
      if (!id && a.force !== true) {
        const near = p.knowledge.similar(projectId, title);
        if (near.length) return m.knowledgeSaveSimilar(near.map((n) => `${n.id} (${n.title})`).join(", "));
      }
      const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : id ? (await p.knowledge.read(projectId, id)).tags : [];
      const e = await p.knowledge.save(projectId, { id, title, summary: String(a.summary), tags, content: String(a.content) });
      return `${m.knowledgeSaved(Boolean(id), e.id, fileOf(e.id))}${overlapHint(e, [e.id])}`;
    },
  };
  const knowledgeMerge: SessionTool = {
    name: "knowledge_merge",
    description: m.knowledgeMergeDescription,
    shape: {
      ids: z.array(z.string().min(1).max(80)).min(2).max(6).describe(m.knowledgeMergeIds),
      ...entryFields,
    },
    autoAllow: true,
    run: async (a) => {
      const ids = (a.ids as unknown[]).map((x) => String(x).trim());
      const tags = Array.isArray(a.tags)
        ? a.tags.filter((t): t is string => typeof t === "string")
        : [...new Set((await Promise.all(ids.map((id) => p.knowledge.read(projectId, id)))).flatMap((e) => e.tags))].slice(0, 8);
      const { entry, removed } = await p.knowledge.merge(projectId, ids, { title: String(a.title), summary: String(a.summary), tags, content: String(a.content) });
      return m.knowledgeMerged(entry.id, fileOf(entry.id), removed.join(", "));
    },
  };
  const knowledgeDelete: SessionTool = {
    name: "knowledge_delete",
    description: m.knowledgeDeleteDescription,
    shape: { id: z.string().min(1).max(80) },
    autoAllow: false,
    run: async (a) => ((await p.knowledge.delete(projectId, String(a.id))) ? m.knowledgeDeleted(String(a.id)) : m.knowledgeNoEntry(String(a.id))),
  };
  const refList = (missing: KnowledgeMissingRef[]) => missing.map((r) => `\`${r.ref}\`${r.hint ? ` (${r.hint})` : ""}`).join("; ");
  const knowledgeCheck: SessionTool = {
    name: "knowledge_check",
    description: m.knowledgeCheckDescription,
    shape: {
      ids: z.array(z.string().min(1).max(80)).max(100).optional().describe(m.knowledgeCheckIds),
      refresh: z.boolean().optional().describe(m.knowledgeCheckRefresh),
    },
    autoAllow: true,
    run: async (a) => {
      const ids = Array.isArray(a.ids) && a.ids.length ? a.ids.map((x) => String(x).trim()) : undefined;
      const report = await p.knowledge.staleness(projectId, { ids, refresh: a.refresh === true });
      const stale = report.entries.filter((e) => e.missing.length);
      const noGit = report.git ? "" : `\n${m.knowledgeCheckNoGit}`;
      if (!stale.length) return `${m.knowledgeCheckNone(report.entries.length)}${noGit}`;
      return `${m.knowledgeCheckFound(stale.length, report.entries.length, stale.map((e) => `- ${e.id}: ${refList(e.missing)}`).join("\n"))}${noGit}`;
    },
  };
  const knowledgeMarkChecked: SessionTool = {
    name: "knowledge_mark_checked",
    description: m.knowledgeMarkDescription,
    shape: { id: z.string().min(1).max(80).describe(m.knowledgeMarkId) },
    autoAllow: true,
    run: async (a) => {
      const id = String(a.id).trim();
      const missing = (await p.knowledge.staleness(projectId, { ids: [id] })).entries[0]?.missing ?? [];
      if (!missing.length) return m.knowledgeMarkNothing(id);
      await p.knowledge.markChecked(projectId, id);
      return m.knowledgeMarked(id, missing.map((r) => `\`${r.ref}\``).join(", "));
    },
  };
  const devEnvironment: SessionTool = {
    name: "dev_environment",
    description: m.devEnvironmentDescription,
    shape: {
      wait: z.boolean().optional().describe(m.devEnvironmentWait),
    },
    autoAllow: true,
    run: (a) => p.dev.describe(projectId, a.wait === true ? SETUP_WAIT_MS : 0),
  };
  const devControl: SessionTool = {
    name: "dev_control",
    description: m.devControlDescription,
    shape: {
      target: z.enum(["dev-server", "database"]),
      action: z.enum(["start", "stop", "restart", "reset"]),
    },
    autoAllow: false,
    run: (a) => p.dev.control(projectId, a.target as DevTarget, a.action as DevAction),
  };

  const preview = p.preview ? previewTools(projectId, p.preview, rec.id) : [];

  const { lines, total, summaries } = p.knowledge.index(projectId);
  const cleanup = lines.length ? p.knowledge.cleanup(projectId) : { overlaps: [], long: [] };
  const context = [
    m.knowledgeIntro,
    inWorktree ? m.knowledgeInWorktree(p.knowledge.dir(projectId)) : "",
    lines.length ? m.knowledgeIndex(total, lines.length, summaries, lines.join("\n")) : m.knowledgeEmpty,
    m.knowledgeRead,
    m.knowledgeSave,
    m.knowledgeRules,
    cleanup.overlaps.length
      ? m.knowledgeOverlaps(
          cleanup.overlaps
            .slice(0, 3)
            .map((o) => `${o.a} + ${o.b}`)
            .join("; "),
        )
      : "",
    cleanup.long.length
      ? m.knowledgeLong(
          cleanup.long
            .slice(0, 3)
            .map((l) => `${l.id} (${Math.round(l.chars / 1000)} KB)`)
            .join(", "),
        )
      : "",
    m.knowledgeOnlyTools,
    m.devIntro,
    inWorktree ? p.dev.setupContext(projectId) : "",
    preview.length ? m.previewIntro : "",
  ].filter(Boolean);
  return { tools: [knowledgeSearch, knowledgeRead, knowledgeSave, knowledgeMerge, knowledgeDelete, knowledgeCheck, knowledgeMarkChecked, devEnvironment, devControl, ...preview], context };
}

type ForgeToolTexts = ReturnType<typeof tr>["core"]["forgeTools"];

const previewTarget = (m: ForgeToolTexts) => ({
  url: z.string().max(2000).optional().describe(m.previewUrl),
  path: z.string().max(2000).optional().describe(m.previewPath),
  width: z.number().int().min(320).max(2560).optional().describe(m.previewWidth),
  height: z.number().int().min(240).max(2000).optional().describe(m.previewHeight),
});

const str = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown) => (typeof v === "number" ? v : null);

/** Screenshot, console and simple input on the project's running web app (headless Edge or Chrome). */
function previewTools(projectId: string, preview: PreviewService, viewer: string): SessionTool[] {
  const target = (a: Record<string, unknown>) => ({ url: str(a.url), path: str(a.path), width: int(a.width), height: int(a.height), viewer });
  const m = tr().core.forgeTools;
  const at = previewTarget(m);
  return [
    {
      name: "preview_screenshot",
      description: m.previewScreenshotDescription,
      shape: { ...at, fullPage: z.boolean().optional().describe(m.previewFullPage) },
      autoAllow: true,
      run: (a) => preview.screenshot(projectId, { ...target(a), fullPage: a.fullPage === true }),
    },
    {
      name: "preview_console",
      description: m.previewConsoleDescription,
      shape: { ...at, reload: z.boolean().optional().describe(m.previewReload) },
      autoAllow: true,
      run: (a) => preview.console(projectId, { ...target(a), reload: a.reload === true }),
    },
    {
      name: "preview_interact",
      description: m.previewInteractDescription,
      shape: {
        ...at,
        steps: z
          .array(
            z.object({
              action: z.enum(["click", "type", "press", "wait"]),
              selector: z.string().max(500).optional().describe(m.previewSelector),
              text: z.string().max(5000).optional().describe(m.previewText),
              clear: z.boolean().optional().describe(m.previewClear),
              key: z.string().max(40).optional().describe(m.previewKey),
              ms: z.number().int().min(0).max(MAX_STEP_MS).optional().describe(m.previewMs),
            }),
          )
          .min(1)
          .max(30),
        stepTimeoutMs: z.number().int().min(100).max(MAX_STEP_MS).optional().describe(m.previewStepTimeout),
        screenshot: z.boolean().optional().describe(m.previewNoScreenshot),
        fullPage: z.boolean().optional(),
      },
      autoAllow: false,
      run: (a) =>
        preview.interact(projectId, {
          ...target(a),
          steps: (Array.isArray(a.steps) ? a.steps : []) as PreviewStep[],
          stepMs: int(a.stepTimeoutMs) ?? undefined,
          screenshot: a.screenshot !== false,
          fullPage: a.fullPage === true,
        }),
    },
  ];
}

const short = (id: string) => id.slice(0, 8);

function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

const statusText = (status: string) => tr().core.forgeTools.status[status] ?? status;

/**
 * FORGE tools inside a coding session and the context that explains them. Agents (sessions started
 * with start_agent) get no start_agent themselves: one level of agents, no chains.
 */
export function forgeSessionTools(rec: SessionRecord, d: ForgeToolDeps): { tools: SessionTool[]; context: string } {
  const sessionId = rec.id;
  const m = tr().core.forgeTools;
  const parent = d.agents.parent(rec);
  const project = d.projects.get(rec.projectId);
  let own: { tools: SessionTool[]; context: string[] } = { tools: [], context: [] };
  try {
    if (d.project && project.exists) own = projectTools(rec, d.project);
  } catch (e) {
    // Without knowledge and dev tools the session still gets the other FORGE tools; the timeline says why.
    d.record(sessionId, { type: "status", status: "starting", detail: m.projectToolsUnavailable(e instanceof Error ? e.message : String(e)) });
  }

  const notify: SessionTool = {
    name: "notify",
    description: m.notifyDescription,
    shape: {
      message: z.string().min(1).max(500).describe(m.notifyMessage),
      urgent: z.boolean().optional().describe(m.notifyUrgent),
    },
    autoAllow: true,
    run: async (a) => {
      d.record(sessionId, { type: "notify", message: String(a.message), urgent: a.urgent === true });
      return a.urgent === true ? m.notifiedUrgent : m.notified;
    },
  };

  const usage = d.usage;
  const usageStatus: SessionTool | null = usage
    ? {
        name: "usage_status",
        description: m.usageStatusDescription,
        shape: {},
        autoAllow: true,
        run: () => usage(),
      }
    : null;
  const report = d.report;
  const dailyReport: SessionTool | null = report
    ? {
        name: "daily_report",
        description: m.dailyReportDescription,
        shape: {
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(m.dailyReportDate),
          all_projects: z.boolean().optional().describe(m.dailyReportAllProjects),
        },
        autoAllow: true,
        run: (a) => report(a.all_projects === true ? null : (project.parentId ?? project.id), typeof a.date === "string" ? a.date : undefined),
      }
    : null;
  const common = [notify, ...(usageStatus ? [usageStatus] : []), ...(dailyReport ? [dailyReport] : [])];
  const usageLine = [
    usageStatus ? m.usageLine : "",
    dailyReport ? m.dailyReportLine : "",
  ]
    .filter(Boolean)
    .join("\n");

  // Agents need worktrees and branches, so a project without git gets neither them nor git hints.
  if (!project.gitEnabled && !parent) {
    return {
      tools: [...common, ...own.tools],
      context: [
        m.introNoGit,
        m.noGit(rec.cwd),
        m.noGitAgents,
        m.notifyLine,
        usageLine,
        ...own.context,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const autoMerge = autoMergeOn(d.projects, project);
  // A turn that ends with a question in the text would be merged before anyone answers it.
  const autoMergeLine = project.parentId && autoMerge ? m.autoMergeLine : "";
  // Tags can change during the session; the note with the next message says what FORGE actually did.
  const autoCommitLine = project.tags.includes("auto-commit") ? m.autoCommitLine(project.tags.includes("auto-push")) : "";
  // Sessions ran the whole suite after every small step, also with nothing changed since the last green run.
  const autoTest = project.tags.includes("auto-test") && project.testCommand;
  const testLine = m.testLine(autoTest ? project.testCommand : null);

  if (parent) {
    return {
      tools: [...common, ...own.tools],
      context: [
        m.introAgent,
        m.agentWorktree(rec.cwd),
        m.agentFinish,
        autoMergeLine,
        autoCommitLine,
        testLine,
        m.agentNotify,
        ...own.context,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const rootId = project.parentId ?? project.id;
  // Switched off by the user: Claude is not offered start_agent at all; switched off later, start_agent refuses.
  const agentsOn = () => d.projects.all().find((p) => p.id === rootId)?.agentsEnabled !== false;
  const offerAgents = agentsOn();

  const resolveChild = (ref: string) => {
    const q = ref.trim().toLowerCase();
    const children = d.agents.children(sessionId);
    const hit = children.find((c) => c.startsWith(q) || short(c) === q);
    if (!hit) throw new Error(children.length ? m.agentNotFound(ref, children.map(short).join(", ")) : m.noOwnAgents);
    return hit;
  };

  /** Agent worktrees of this project the session did not start: from the Agents tab, the phone or other sessions. */
  const otherAgents = () => {
    const mine = new Set(d.agents.children(sessionId).map((c) => d.db.getSession(c)?.projectId));
    return d.projects.all().filter((p) => p.parentId === rootId && p.id !== project.id && !mine.has(p.id));
  };
  /** The branch, or from the name FORGE gave the worktree ("Projekt · branch") when the folder is gone. */
  const branchLabel = async (p: Project) => (p.exists ? await d.worktrees.branchOf(p.path) : null) ?? (p.name.includes(" · ") ? p.name.slice(p.name.indexOf(" · ") + 3) : p.name);

  /** Worktree project of an agent: own agents by their short id, the others by branch (with or without "agent/"). */
  const resolveAgentProject = async (ref: string): Promise<string> => {
    const q = ref.trim().toLowerCase();
    const child = d.agents.children(sessionId).find((c) => c.startsWith(q) || short(c) === q);
    if (child) {
      const s = d.db.getSession(child);
      const wt = s && d.projects.all().find((p) => p.id === s.projectId);
      if (!wt?.parentId) throw new Error(m.agentNoWorktree(short(child)));
      return wt.id;
    }
    const others = otherAgents();
    for (const p of others) {
      const branch = (await branchLabel(p)).toLowerCase();
      if (branch === q || branch === `agent/${q}`) return p.id;
    }
    const known = [...d.agents.children(sessionId).map(short), ...(await Promise.all(others.map(branchLabel)))];
    throw new Error(known.length ? m.agentNotFound(ref, known.join(", ")) : m.noAgentsInProject);
  };

  const startAgent: SessionTool = {
    name: "start_agent",
    description: m.startAgentDescription,
    shape: {
      task: z.string().min(10).describe(m.startAgentTask),
      name: z.string().max(40).optional().describe(m.startAgentName),
      with_changes: z.boolean().optional().describe(m.startAgentWithChanges),
    },
    autoAllow: false,
    run: async (a) => {
      if (!agentsOn()) throw new Error(m.agentsOffRefused);
      const root = project.parentId ? d.projects.get(project.parentId) : project;
      const task = String(a.task);
      const branch = `agent/${slugify(typeof a.name === "string" && a.name.trim() ? a.name : task, 32)}-${Date.now().toString(36).slice(-4)}`;
      const fromDir = d.projects.requireExisting(project.id).path;
      const withChanges = a.with_changes === true;
      const open = withChanges ? 0 : await d.worktrees.uncommitted(fromDir).catch(() => 0);
      // From where this session stands (its branch, or its own worktree), not from the main checkout.
      const wt = await d.worktrees.create(d.projects.requireExisting(root.id), branch, { fromDir, withChanges });
      d.emit({ event: "project.updated", payload: { projectId: wt.id } });
      d.agents.reserve(wt.id, sessionId);
      let child: Session;
      try {
        child = await d.start({ projectId: wt.id, prompt: task });
      } catch (e) {
        d.agents.release(wt.id);
        // Nothing was done in it yet: an empty worktree and branch would only be left to clean up by hand.
        await d.worktrees.remove(wt, true, { deleteBranch: true }).catch(() => null);
        d.emit({ event: "project.updated", payload: { projectId: root.id } });
        throw e;
      }
      d.agents.adopt(child.id, wt.id);
      const note = withChanges ? m.startAgentWithChangesNote : open ? m.startAgentOpenNote(open) : "";
      const warning = d.limitWarning ? await d.limitWarning().catch(() => null) : null;
      return `${m.agentStarted(short(child.id), branch, wt.path)}${note}${warning ? m.startAgentWarning(warning) : ""}`;
    },
  };

  const agentStatus: SessionTool = {
    name: "agent_status",
    description: m.agentStatusDescription,
    shape: { agent: z.string().min(1).optional().describe(m.agentStatusAgent) },
    autoAllow: true,
    run: async (a) => {
      const one = typeof a.agent === "string" && a.agent.trim();
      const ids = one ? [resolveChild(one)] : d.agents.children(sessionId);
      const others = one ? [] : otherAgents();
      const otherLines = await Promise.all(
        others.map(async (p) => {
          const s = d.db.listSessions(p.id)[0];
          return m.otherAgentLine(await branchLabel(p), s ? statusText(s.status) : null, p.path, p.exists);
        }),
      );
      const otherBlock = otherLines.length ? m.otherAgentsBlock(otherLines.join("\n")) : "";
      if (!ids.length) return [m.noOwnAgents, otherBlock].filter(Boolean).join("\n");
      const lines = await Promise.all(
        ids.map(async (id) => {
          const s = d.db.getSession(id);
          if (!s) return m.agentDeleted(short(id));
          const branch = await d.worktrees.branchOf(s.cwd);
          const last = lastAnswer(d.db, id);
          return [
            m.agentLine(short(id), s.title, statusText(s.status), branch, s.cwd),
            last ? m.agentLastAnswer(excerpt(last, 800)) : "",
          ]
            .filter(Boolean)
            .join("\n");
        }),
      );
      return [...lines, otherBlock].filter(Boolean).join("\n");
    },
  };

  const messageAgent: SessionTool = {
    name: "message_agent",
    description: m.messageAgentDescription,
    shape: { agent: z.string().min(1).describe(m.messageAgentAgent), text: z.string().min(1).describe(m.messageAgentText) },
    autoAllow: false,
    run: async (a) => {
      const id = resolveChild(String(a.agent));
      await d.send(id, String(a.text));
      return m.messageSent(short(id));
    },
  };

  const finisher = d.finisher;
  const finishAgent: SessionTool | null = finisher
    ? {
        name: "finish_agent",
        description: m.finishAgentDescription,
        shape: {
          agent: z.string().min(1).describe(m.finishAgentAgent),
          action: z.enum(["merge", "discard"]),
        },
        autoAllow: false,
        run: async (a) => {
          const projectId = await resolveAgentProject(String(a.agent));
          return (await finisher.finish(projectId, a.action === "discard" ? "discard" : "merge")).message;
        },
      }
    : null;

  return {
    tools: [...(offerAgents ? [startAgent] : []), agentStatus, messageAgent, ...(finishAgent ? [finishAgent] : []), ...common, ...own.tools],
    context: [
      m.intro,
      offerAgents ? m.startAgentLine : m.agentsOffLine,
      m.agentStatusLine,
      finisher ? m.finishAgentLine(autoMerge) : "",
      autoMergeLine,
      autoCommitLine,
      m.notifyLine,
      testLine,
      usageLine,
      ...own.context,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

import type { ServerEvent, Session, SessionEventBody } from "@forge/protocol";
import { z } from "zod";
import { slugify, type WorktreeService } from "../automation/worktrees.js";
import type { SessionTool } from "../claude/runtime.js";
import type { Db, SessionRecord } from "../persistence/db.js";
import type { ProjectManager } from "../projects/project-manager.js";
import { lastAnswer } from "../phone/session-info.js";
import type { StartParams } from "./lifecycle.js";

/** Agents one session may have running at the same time. */
export const MAX_AGENTS = 4;
const RUNNING = new Set(["starting", "running", "waiting_approval", "stopping"]);

/**
 * Which sessions were started as agents by which session. Kept in memory: after a restart former
 * agents are plain sessions again (they keep their worktree and branch).
 */
export class AgentRegistry {
  /** worktree project -> session that asked for it; known before the agent's session exists */
  private readonly byProject = new Map<string, string>();
  private readonly parentOf = new Map<string, string>();

  reserve(projectId: string, parentId: string) {
    this.byProject.set(projectId, parentId);
  }

  adopt(childId: string, projectId: string) {
    const parent = this.byProject.get(projectId);
    if (parent) this.parentOf.set(childId, parent);
  }

  /** The session that started this one (by session, or by its worktree while it is being started). */
  parent(rec: Pick<SessionRecord, "id" | "projectId">): string | null {
    return this.parentOf.get(rec.id) ?? this.byProject.get(rec.projectId) ?? null;
  }

  children(parentId: string): string[] {
    return [...this.parentOf].filter(([, p]) => p === parentId).map(([c]) => c);
  }

  forget(sessionId: string) {
    this.parentOf.delete(sessionId);
  }
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
}

const short = (id: string) => id.slice(0, 8);

function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)} …` : t;
}

const STATUS: Record<string, string> = {
  starting: "startet",
  running: "arbeitet",
  waiting_approval: "wartet auf eine Freigabe des Nutzers",
  stopping: "stoppt",
  idle: "fertig, wartet auf Anweisungen",
  stopped: "beendet",
  interrupted: "unterbrochen",
  error: "mit Fehler beendet",
};

/**
 * FORGE tools inside a coding session and the context that explains them. Agents (sessions started
 * with start_agent) get no start_agent themselves: one level of agents, no chains.
 */
export function forgeSessionTools(rec: SessionRecord, d: ForgeToolDeps): { tools: SessionTool[]; context: string } {
  const sessionId = rec.id;
  const parent = d.agents.parent(rec);
  const project = d.projects.get(rec.projectId);

  const notify: SessionTool = {
    name: "notify",
    description:
      "Benachrichtigt den Nutzer in FORGE (Hinweis mit Ton). urgent=true nur, wenn er wirklich sofort gebraucht wird: dann ruft FORGE ihn an, sofern das Telefon eingerichtet ist.",
    shape: {
      message: z.string().min(1).max(500).describe("Kurze Nachricht an den Nutzer, ein bis zwei Sätze"),
      urgent: z.boolean().optional().describe("true: dringend, darf anrufen"),
    },
    autoAllow: true,
    run: async (a) => {
      d.record(sessionId, { type: "notify", message: String(a.message), urgent: a.urgent === true });
      return a.urgent === true ? "Der Nutzer wurde dringend benachrichtigt." : "Der Nutzer wurde benachrichtigt.";
    },
  };

  if (parent) {
    return {
      tools: [notify],
      context: [
        "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code, als paralleler Agent: Eine andere FORGE-Session hat dich gestartet.",
        `Du arbeitest im Git-Worktree ${rec.cwd} auf einem eigenen Branch. Ändere nur Dateien in diesem Ordner.`,
        "Wenn du fertig bist: committe deine Arbeit auf deinem Branch und fasse am Ende in wenigen Sätzen zusammen, was du gemacht hast und was offen ist. Die startende Session liest diese Zusammenfassung.",
        "Mit mcp__forge__notify kannst du den Nutzer benachrichtigen. Weitere Agenten kannst du nicht starten.",
      ].join("\n"),
    };
  }

  const resolveChild = (ref: string) => {
    const q = ref.trim().toLowerCase();
    const children = d.agents.children(sessionId);
    const hit = children.find((c) => c.startsWith(q) || short(c) === q);
    if (!hit) throw new Error(children.length ? `Keinen Agenten „${ref}“ gefunden. Vorhanden: ${children.map(short).join(", ")}.` : "Diese Session hat keine Agenten gestartet.");
    return hit;
  };

  const startAgent: SessionTool = {
    name: "start_agent",
    description:
      "Startet einen parallelen Agenten (eigene Claude-Code-Session) in einem neuen Git-Worktree auf eigenem Branch. Für unabhängige Teilaufgaben, die gleichzeitig laufen können. Der Agent sieht diesen Chat nicht: Der Auftrag muss für sich allein verständlich sein.",
    shape: {
      task: z.string().min(10).describe("Vollständiger Auftrag mit allem nötigen Kontext"),
      name: z.string().max(40).optional().describe("Kurzer Name für den Branch, z. B. csv-export"),
    },
    autoAllow: false,
    run: async (a) => {
      const running = d.agents.children(sessionId).filter((c) => RUNNING.has(d.db.getSession(c)?.status ?? ""));
      if (running.length >= MAX_AGENTS) return `Fehler: Es laufen schon ${running.length} Agenten dieser Session (höchstens ${MAX_AGENTS}). Warte, bis einer fertig ist.`;
      const root = project.parentId ? d.projects.get(project.parentId) : project;
      const task = String(a.task);
      const branch = `agent/${slugify(typeof a.name === "string" && a.name.trim() ? a.name : task, 32)}-${Date.now().toString(36).slice(-4)}`;
      const wt = await d.worktrees.create(d.projects.requireExisting(root.id), branch);
      d.emit({ event: "project.updated", payload: { projectId: wt.id } });
      d.agents.reserve(wt.id, sessionId);
      const child = await d.start({ projectId: wt.id, prompt: task });
      d.agents.adopt(child.id, wt.id);
      return `Agent ${short(child.id)} gestartet, Branch ${branch}, Ordner ${wt.path}. Er arbeitet unabhängig; den Stand gibt agent_status. Seine Änderungen liegen nur auf seinem Branch.`;
    },
  };

  const agentStatus: SessionTool = {
    name: "agent_status",
    description: "Stand der Agenten, die diese Session gestartet hat: Status, Branch und ihre letzte Antwort.",
    shape: { agent: z.string().optional().describe("Kürzel eines Agenten; leer für alle") },
    autoAllow: true,
    run: async (a) => {
      const ids = typeof a.agent === "string" && a.agent.trim() ? [resolveChild(a.agent)] : d.agents.children(sessionId);
      if (!ids.length) return "Diese Session hat keine Agenten gestartet.";
      return ids
        .map((id) => {
          const s = d.db.getSession(id);
          if (!s) return `${short(id)}: gelöscht`;
          const last = lastAnswer(d.db, id);
          return [`${short(id)} (${s.title ?? "ohne Titel"}): ${STATUS[s.status] ?? s.status}, Ordner ${s.cwd}`, last ? `  Letzte Antwort: ${excerpt(last, 800)}` : ""].filter(Boolean).join("\n");
        })
        .join("\n");
    },
  };

  const messageAgent: SessionTool = {
    name: "message_agent",
    description: "Schickt einem Agenten dieser Session eine weitere Anweisung; er arbeitet dann weiter.",
    shape: { agent: z.string().describe("Kürzel des Agenten"), text: z.string().min(1).describe("Anweisung, vollständig ausformuliert") },
    autoAllow: false,
    run: async (a) => {
      const id = resolveChild(String(a.agent));
      await d.send(id, String(a.text));
      return `An Agent ${short(id)} gesendet.`;
    },
  };

  return {
    tools: [startAgent, agentStatus, messageAgent, notify],
    context: [
      "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code. Neben deinen Werkzeugen gibt es FORGE-Werkzeuge (mcp__forge__…):",
      "- start_agent: startet einen parallelen Agenten in einem eigenen Git-Worktree auf eigenem Branch. Nur für Teilaufgaben, die wirklich unabhängig und gleichzeitig laufen können; der Auftrag muss für sich allein verständlich sein.",
      "- agent_status und message_agent: Agenten verfolgen und anleiten. Ihre Arbeit liegt auf ihren Branches; zusammenführen erst nach Rücksprache mit dem Nutzer.",
      "- notify: den Nutzer aktiv benachrichtigen. urgent=true nur, wenn er sofort gebraucht wird (kann sein Telefon klingeln lassen).",
    ].join("\n"),
  };
}

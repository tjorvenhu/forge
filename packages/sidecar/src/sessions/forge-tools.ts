import path from "node:path";
import type { Project, ServerEvent, Session, SessionEventBody } from "@forge/protocol";
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

/** Agents one session may have running at the same time. */
export const MAX_AGENTS = 4;
const RUNNING = new Set(["starting", "running", "waiting_approval", "stopping"]);

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
}

/** Knowledge and dev tools of the session's project, with the lines of start context that explain them. */
export function projectTools(rec: SessionRecord, p: ProjectToolDeps): { tools: SessionTool[]; context: string[] } {
  const projectId = rec.projectId;
  const inWorktree = p.knowledge.owner(projectId) !== projectId;
  const knowledgeSearch: SessionTool = {
    name: "knowledge_search",
    description: "Durchsucht das Projektwissen (Titel, Tags, Zusammenfassung, Text). Liefert Kennung, Titel, Zusammenfassung und eine Textstelle je Treffer.",
    shape: {
      query: z.string().min(1).max(200).describe("Suchwörter, z. B. 'migration prisma' oder 'deploy coolify'"),
      limit: z.number().int().min(1).max(20).optional(),
    },
    autoAllow: true,
    run: async (a) => {
      const hits = p.knowledge.search(projectId, String(a.query), typeof a.limit === "number" ? a.limit : 8);
      if (!hits.length) return "Keine Treffer im Projektwissen.";
      return hits.map((h) => `${h.id}: ${h.title}${h.tags.length ? ` [${h.tags.join(", ")}]` : ""}\n  ${h.summary}\n  ${h.snippet}`).join("\n");
    },
  };
  const knowledgeRead: SessionTool = {
    name: "knowledge_read",
    description: "Liest einen Eintrag des Projektwissens vollständig.",
    shape: { id: z.string().min(1).max(80).describe("Kennung aus dem Index oder knowledge_search") },
    autoAllow: true,
    run: async (a) => {
      const e = await p.knowledge.read(projectId, String(a.id));
      return `# ${e.title}\nZusammenfassung: ${e.summary}\nTags: ${e.tags.join(", ") || "keine"}\nStand: ${e.updatedAt.slice(0, 10)}\n\n${e.content}`;
    },
  };
  const knownTags = p.knowledge.tags(projectId).slice(0, 30);
  // A worktree has no knowledge folder of its own; a relative path would point into the wrong checkout.
  const fileOf = (id: string) => (inWorktree ? path.join(p.knowledge.dir(projectId), `${id}.md`) : `${KNOWLEDGE_DIR.replace(/\\/g, "/")}/${id}.md`);
  const entryFields = {
    title: z
      .string()
      .min(3)
      .max(120)
      .describe("Kurzer, eindeutiger Titel mit den Begriffen, unter denen man ihn sucht, z. B. 'Rechtsklick-Menü (ContextMenuHost, addContextItems)'. Steht so im Index jeder Session"),
    summary: z.string().min(5).max(300).describe("Ein kurzer Satz: worum es geht und wann man den Eintrag braucht"),
    tags: z
      .array(z.string().max(40))
      .max(8)
      .optional()
      .describe(`2 bis 5 Stichwörter in Kleinbuchstaben: Bereich und Art (z. B. stolperfalle, konvention). ${knownTags.length ? `Vorhandene wiederverwenden: ${knownTags.join(", ")}` : ""}`.trim()),
    content: z.string().min(1).max(50_000).describe("Inhalt in Markdown: konkret, mit Dateipfaden, Befehlen und Begründungen. Beim Aktualisieren der vollständige neue Text"),
  };
  const overlapHint = (text: { title: string; summary: string; tags: string[]; content: string }, except: string[]) => {
    const near = p.knowledge.covering(projectId, text, except).slice(0, 3);
    return near.length
      ? ` Überschneidet sich stark mit: ${near.map((n) => `${n.id} (${n.title})`).join(", ")}. Ist es dasselbe Thema, führe die Einträge mit knowledge_merge zusammen.`
      : "";
  };
  const knowledgeSave: SessionTool = {
    name: "knowledge_save",
    description:
      "Legt einen Eintrag im Projektwissen an oder aktualisiert ihn (mit id). Für dauerhaft nützliches Wissen, das nicht offensichtlich im Code steht. Ein Eintrag pro Thema; bestehende Einträge ergänzen statt Duplikate anlegen.",
    shape: {
      id: z.string().max(80).optional().describe("Kennung eines bestehenden Eintrags zum Aktualisieren; leer legt einen neuen an"),
      ...entryFields,
      force: z.boolean().optional().describe("true legt trotz eines ähnlichen Eintrags einen neuen an"),
    },
    autoAllow: true,
    run: async (a) => {
      const id = typeof a.id === "string" && a.id.trim() ? a.id.trim() : null;
      const title = String(a.title);
      if (!id && a.force !== true) {
        const near = p.knowledge.similar(projectId, title);
        if (near.length)
          return `Nicht gespeichert: Es gibt schon ähnliche Einträge: ${near.map((n) => `${n.id} (${n.title})`).join(", ")}. Lies sie mit knowledge_read und aktualisiere den passenden mit id, oder setze force=true, wenn es wirklich ein anderes Thema ist.`;
      }
      const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : id ? (await p.knowledge.read(projectId, id)).tags : [];
      const e = await p.knowledge.save(projectId, { id, title, summary: String(a.summary), tags, content: String(a.content) });
      return `${id ? "Aktualisiert" : "Gespeichert"}: ${e.id} (${fileOf(e.id)}).${overlapHint(e, [e.id])}`;
    },
  };
  const knowledgeMerge: SessionTool = {
    name: "knowledge_merge",
    description:
      "Führt Einträge des Projektwissens, die dasselbe Thema behandeln, zu einem zusammen: der erste behält seine Kennung und bekommt den neuen Text, die übrigen werden gelöscht. Lies vorher alle mit knowledge_read; content muss das Wissen aller Einträge enthalten, Doppeltes und Veraltetes fällt weg.",
    shape: {
      ids: z.array(z.string().min(1).max(80)).min(2).max(6).describe("Kennungen der Einträge; der erste bleibt bestehen"),
      ...entryFields,
    },
    autoAllow: true,
    run: async (a) => {
      const ids = (a.ids as unknown[]).map((x) => String(x).trim());
      const tags = Array.isArray(a.tags)
        ? a.tags.filter((t): t is string => typeof t === "string")
        : [...new Set((await Promise.all(ids.map((id) => p.knowledge.read(projectId, id)))).flatMap((e) => e.tags))].slice(0, 8);
      const { entry, removed } = await p.knowledge.merge(projectId, ids, { title: String(a.title), summary: String(a.summary), tags, content: String(a.content) });
      return `Zusammengeführt: ${entry.id} (${fileOf(entry.id)}). Gelöscht: ${removed.join(", ")}.`;
    },
  };
  const knowledgeDelete: SessionTool = {
    name: "knowledge_delete",
    description: "Löscht einen veralteten oder falschen Eintrag des Projektwissens.",
    shape: { id: z.string().min(1).max(80) },
    autoAllow: false,
    run: async (a) => ((await p.knowledge.delete(projectId, String(a.id))) ? `Gelöscht: ${String(a.id)}` : `Kein Eintrag ${String(a.id)}.`),
  };
  const devEnvironment: SessionTool = {
    name: "dev_environment",
    description:
      "Stand von Dev-Server und Test-Datenbank des Projekts: Status, Adresse, Verbindungs-URL der lokalen PostgreSQL-Testdatenbank, Namen der Test-Umgebungsvariablen und die letzten Zeilen der Dev-Server-Ausgabe.",
    shape: {},
    autoAllow: true,
    run: () => p.dev.describe(projectId),
  };
  const devControl: SessionTool = {
    name: "dev_control",
    description:
      "Startet, stoppt oder startet Dev-Server bzw. Test-Datenbank neu. reset (nur Datenbank) löscht alle Daten der Test-Datenbank. Der Dev-Server bekommt die Test-Umgebung und, solange sie läuft, die URL der Test-Datenbank.",
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
    "Projektwissen (FORGE): Gesammeltes Wissen zu diesem Projekt liegt in .forge/knowledge (Markdown, im Git).",
    inWorktree
      ? `Du arbeitest in einem Worktree. Das Projektwissen liegt im Ordner des Hauptprojekts: ${p.knowledge.dir(projectId)}. Eine Kopie in deinem Worktree ist nicht maßgeblich.`
      : "",
    lines.length
      ? `Index beim Start dieser Session (${total} Einträge${total > lines.length ? `, die ${lines.length} neuesten` : ""}, ${summaries ? "Kennung: Titel. Zusammenfassung [Tags]" : "Kennung: Titel [Tags]; Zusammenfassungen liefert knowledge_search"}; Neueres findet knowledge_search):\n${lines.join("\n")}`
      : "Beim Start dieser Session gab es noch keine Einträge. Lege die ersten an, sobald du etwas Passendes herausfindest.",
    "- Bevor du in einem Bereich arbeitest, zu dem es einen passenden Eintrag gibt, lies ihn mit mcp__forge__knowledge_read. Bei Fragen zu Abläufen, Entscheidungen oder Stolperfallen suche zuerst mit knowledge_search.",
    "- Speichere mit knowledge_save, was künftigen Sessions Zeit spart und nicht offensichtlich im Code oder in CLAUDE.md steht: Entscheidungen mit Begründung, Stolperfallen und ihre Lösung, Abläufe (Setup, Tests, Deploy), Eigenheiten externer Dienste. Speichere, sobald du so etwas herausgefunden hast, nicht erst am Ende.",
    "- Keine Geheimnisse (Passwörter, Tokens, Keys), kein Sitzungsprotokoll, nichts Kurzlebiges. Ein Thema pro Eintrag; bestehende Einträge aktualisieren statt neue anzulegen, Veraltetes korrigieren oder mit knowledge_delete löschen. Titel und Tags sind das, was andere Sessions im Index sehen: Titel mit Suchbegriffen, vorhandene Tags wiederverwenden.",
    cleanup.overlaps.length
      ? `- Aufräumen: Diese Einträge überschneiden sich wahrscheinlich: ${cleanup.overlaps
          .slice(0, 3)
          .map((o) => `${o.a} + ${o.b}`)
          .join("; ")}. Arbeitest du ohnehin in dem Bereich, lies sie und führe sie mit knowledge_merge zusammen, wenn es dasselbe Thema ist.`
      : "",
    cleanup.long.length
      ? `- Sehr lange Einträge: ${cleanup.long
          .slice(0, 3)
          .map((l) => `${l.id} (${Math.round(l.chars / 1000)} KB)`)
          .join(", ")}. Aktualisierst du einen davon, kürze ihn auf das, was nicht im Code steht.`
      : "",
    "- Ändere das Projektwissen nur mit den knowledge_*-Werkzeugen, nicht mit Read, Edit oder Write auf die Dateien.",
    "Dev-Umgebung (FORGE): mcp__forge__dev_environment zeigt Dev-Server (Adresse, letzte Ausgabe) und die lokale PostgreSQL-Testdatenbank (Verbindungs-URL). Nutze für Tests, Migrationen und Experimente mit Daten diese Testdatenbank, nie eine Produktionsdatenbank. dev_control startet, stoppt oder leert sie und startet den Dev-Server neu.",
    preview.length
      ? "Vorschau (FORGE): preview_screenshot zeigt dir die laufende Web-App als Bild (Standard: Adresse des Dev-Servers, path für Unterseiten), preview_console liefert Konsolenmeldungen, Ausnahmen und fehlgeschlagene Anfragen, preview_interact klickt, tippt und wartet auf der Seite. Nur Adressen auf diesem Rechner. Prüfe UI-Änderungen damit selbst, bevor du sie als fertig meldest."
      : "",
  ].filter(Boolean);
  return { tools: [knowledgeSearch, knowledgeRead, knowledgeSave, knowledgeMerge, knowledgeDelete, devEnvironment, devControl, ...preview], context };
}

const previewTarget = {
  url: z.string().max(2000).optional().describe("Lokale Adresse, z. B. http://localhost:5173/login. Weglassen: Adresse des laufenden Dev-Servers"),
  path: z.string().max(2000).optional().describe("Pfad relativ zur Adresse, z. B. /settings"),
  width: z.number().int().min(320).max(2560).optional().describe("Breite des Fensters in Pixeln (Standard 1280)"),
  height: z.number().int().min(240).max(2000).optional().describe("Höhe des Fensters in Pixeln (Standard 800)"),
};

const str = (v: unknown) => (typeof v === "string" ? v : null);
const int = (v: unknown) => (typeof v === "number" ? v : null);

/** Screenshot, console and simple input on the project's running web app (headless Edge or Chrome). */
function previewTools(projectId: string, preview: PreviewService, viewer: string): SessionTool[] {
  const target = (a: Record<string, unknown>) => ({ url: str(a.url), path: str(a.path), width: int(a.width), height: int(a.height), viewer });
  return [
    {
      name: "preview_screenshot",
      description:
        "Lädt die laufende Web-App des Projekts in einem unsichtbaren Browser und liefert einen Screenshot als Bild, dazu Titel, Adresse, HTTP-Status und eine Zählung der Konsolenmeldungen. Nur Adressen auf diesem Rechner (localhost, 127.0.0.1, ::1).",
      shape: { ...previewTarget, fullPage: z.boolean().optional().describe("true: ganze Seite statt nur des sichtbaren Bereichs") },
      autoAllow: true,
      run: (a) => preview.screenshot(projectId, { ...target(a), fullPage: a.fullPage === true }),
    },
    {
      name: "preview_console",
      description:
        "Konsolenmeldungen (error, warn, log), unbehandelte Ausnahmen und fehlgeschlagene Netzwerk-Anfragen (Status ab 400 oder abgebrochen) der Web-App. Ohne url und path die zuletzt geöffnete Seite, sonst wird sie geladen.",
      shape: { ...previewTarget, reload: z.boolean().optional().describe("true: Seite neu laden statt die bisherigen Meldungen zu lesen") },
      autoAllow: true,
      run: (a) => preview.console(projectId, { ...target(a), reload: a.reload === true }),
    },
    {
      name: "preview_interact",
      description:
        "Führt Schritte auf der Seite aus (ohne url und path auf der zuletzt geöffneten): click (CSS-Selektor), type (Selektor und Text; clear ersetzt den Inhalt), press (Taste wie Enter, Tab, Escape, ArrowDown, Control+a), wait (ms oder Selektor). Bricht beim ersten Fehler ab und liefert danach einen Screenshot.",
      shape: {
        ...previewTarget,
        steps: z
          .array(
            z.object({
              action: z.enum(["click", "type", "press", "wait"]),
              selector: z.string().max(500).optional().describe("CSS-Selektor (click, type, wait)"),
              text: z.string().max(5000).optional().describe("Text für type"),
              clear: z.boolean().optional().describe("type: vorhandenen Inhalt ersetzen"),
              key: z.string().max(40).optional().describe("Taste für press"),
              ms: z.number().int().min(0).max(MAX_STEP_MS).optional().describe("wait: Wartezeit, mit selector das Zeitlimit"),
            }),
          )
          .min(1)
          .max(30),
        stepTimeoutMs: z.number().int().min(100).max(MAX_STEP_MS).optional().describe("Zeitlimit je Schritt für das Finden eines Elements (Standard 5000)"),
        screenshot: z.boolean().optional().describe("false: ohne Screenshot am Ende"),
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
  let own: { tools: SessionTool[]; context: string[] } = { tools: [], context: [] };
  try {
    if (d.project && project.exists) own = projectTools(rec, d.project);
  } catch (e) {
    // Without knowledge and dev tools the session still gets the other FORGE tools; the timeline says why.
    d.record(sessionId, { type: "status", status: "starting", detail: `Projektwissen und Dev-Werkzeuge nicht verfügbar: ${e instanceof Error ? e.message : String(e)}` });
  }

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

  const usage = d.usage;
  const usageStatus: SessionTool | null = usage
    ? {
        name: "usage_status",
        description:
          "Nutzung des Claude-Abos des Nutzers: 5-Stunden- und Wochenfenster in Prozent mit Reset-Zeit, und ob ein Limit erreicht ist. Vor großem Aufwand prüfen (mehrere Agenten, lange Läufe), damit die Arbeit nicht am Limit abbricht.",
        shape: {},
        autoAllow: true,
        run: () => usage(),
      }
    : null;
  const common = [notify, ...(usageStatus ? [usageStatus] : [])];
  const usageLine = usageStatus ? "- usage_status: Abo-Nutzung und Limits; vor großem Aufwand (mehrere Agenten, lange Läufe) prüfen." : "";

  // Agents need worktrees and branches, so a project without git gets neither them nor git hints.
  if (!project.gitEnabled && !parent) {
    return {
      tools: [...common, ...own.tools],
      context: [
        "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code. Neben deinen Werkzeugen gibt es FORGE-Werkzeuge (mcp__forge__…).",
        `Dieses Projekt arbeitet bewusst ohne Git: Der Nutzer hat Git für ${rec.cwd} in FORGE ausgeschaltet. Führe keine git-Befehle aus (kein git init, status, add, commit, branch, checkout, push), lege kein Repository an und schlage keine Commits, Branches oder Pull Requests vor. Auch ein vorhandener .git-Ordner bleibt unberührt. Änderungen landen nur als Dateien im Ordner; wenn etwas rückgängig gemacht werden muss, geht das nur über die Dateien selbst.`,
        "Parallele Agenten (start_agent) gibt es deshalb hier nicht.",
        "- notify: den Nutzer aktiv benachrichtigen. urgent=true nur, wenn er sofort gebraucht wird (kann sein Telefon klingeln lassen).",
        usageLine,
        ...own.context,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const autoMerge = autoMergeOn(d.projects, project);
  // A turn that ends with a question in the text would be merged before anyone answers it.
  const autoMergeLine =
    project.parentId && autoMerge
      ? "In diesem Projekt führt FORGE deinen Branch automatisch zusammen, sobald ein Durchlauf ohne Fehler endet. Rückfragen deshalb nur mit AskUserQuestion stellen, nie als Frage am Ende deiner Antwort. Beende einen Durchlauf erst, wenn die Arbeit fertig ist."
      : "";
  // Tags can change during the session; the note with the next message says what FORGE actually did.
  const autoCommitLine = project.tags.includes("auto-commit")
    ? `In diesem Projekt committet FORGE nach jedem erfolgreichen Durchlauf selbst die darin geänderten Dateien (Tag auto-commit${project.tags.includes("auto-push") ? ", danach Push außer auf main/master (auto-push)" : ""}). Mit deiner nächsten Nachricht nennt dir FORGE diese Commits. Soll committet oder gepusht werden, ist das meist schon passiert: prüfe mit git status und git log, committe nur, was noch offen ist, und push dann.`
    : "";

  if (parent) {
    return {
      tools: [...common, ...own.tools],
      context: [
        "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code, als paralleler Agent: Eine andere FORGE-Session hat dich gestartet.",
        `Du arbeitest im Git-Worktree ${rec.cwd} auf einem eigenen Branch. Ändere nur Dateien in diesem Ordner.`,
        "Wenn du fertig bist: committe deine Arbeit auf deinem Branch und fasse am Ende in wenigen Sätzen zusammen, was du gemacht hast und was offen ist. Die startende Session liest diese Zusammenfassung.",
        autoMergeLine,
        autoCommitLine,
        "Mit mcp__forge__notify kannst du den Nutzer benachrichtigen. Weitere Agenten kannst du nicht starten.",
        ...own.context,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const resolveChild = (ref: string) => {
    const q = ref.trim().toLowerCase();
    const children = d.agents.children(sessionId);
    const hit = children.find((c) => c.startsWith(q) || short(c) === q);
    if (!hit) throw new Error(children.length ? `Keinen Agenten „${ref}“ gefunden. Vorhanden: ${children.map(short).join(", ")}.` : "Diese Session hat keine Agenten gestartet.");
    return hit;
  };

  /** Agent worktrees of this project the session did not start: from the Agents tab, the phone or other sessions. */
  const otherAgents = () => {
    const rootId = project.parentId ?? project.id;
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
      if (!wt?.parentId) throw new Error(`Agent ${short(child)} hat keinen Worktree mehr, er ist schon abgeschlossen.`);
      return wt.id;
    }
    const others = otherAgents();
    for (const p of others) {
      const branch = (await branchLabel(p)).toLowerCase();
      if (branch === q || branch === `agent/${q}`) return p.id;
    }
    const known = [...d.agents.children(sessionId).map(short), ...(await Promise.all(others.map(branchLabel)))];
    throw new Error(known.length ? `Keinen Agenten „${ref}“ gefunden. Vorhanden: ${known.join(", ")}.` : "In diesem Projekt gibt es keine Agenten.");
  };

  const startAgent: SessionTool = {
    name: "start_agent",
    description:
      "Startet einen parallelen Agenten (eigene Claude-Code-Session) in einem neuen Git-Worktree auf eigenem Branch. Für unabhängige Teilaufgaben, die gleichzeitig laufen können. Der Agent sieht diesen Chat nicht: Der Auftrag muss für sich allein verständlich sein. Sein Branch beginnt beim letzten Commit deines aktuellen Branches. Nicht committete Änderungen sieht er nur mit with_changes=true: Dann beginnt sein Branch mit einem Commit dieses Stands (ohne .env, Schlüssel und Build-Ausgaben); dein Ordner bleibt unverändert.",
    shape: {
      task: z.string().min(10).describe("Vollständiger Auftrag mit allem nötigen Kontext"),
      name: z.string().max(40).optional().describe("Kurzer Name für den Branch, z. B. csv-export"),
      with_changes: z.boolean().optional().describe("true: der Agent bekommt auch den nicht committeten Stand deines Ordners"),
    },
    autoAllow: false,
    run: async (a) => {
      const running = d.agents.children(sessionId).filter((c) => RUNNING.has(d.db.getSession(c)?.status ?? ""));
      if (running.length >= MAX_AGENTS) return `Fehler: Es laufen schon ${running.length} Agenten dieser Session (höchstens ${MAX_AGENTS}). Warte, bis einer fertig ist.`;
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
      const note = withChanges
        ? " Er hat deinen nicht committeten Stand als ersten Commit seines Branches."
        : open
          ? ` Hinweis: ${open} ${open === 1 ? "Datei ist" : "Dateien sind"} bei dir nicht committet, die sieht er nicht (with_changes=true hätte sie mitgegeben).`
          : "";
      return `Agent ${short(child.id)} gestartet, Branch ${branch}, Ordner ${wt.path}. Er arbeitet unabhängig; den Stand gibt agent_status. Seine Änderungen liegen nur auf seinem Branch.${note}`;
    },
  };

  const agentStatus: SessionTool = {
    name: "agent_status",
    description:
      "Stand der Agenten, die diese Session gestartet hat: Status, Branch und ihre letzte Antwort. Ohne agent auch die übrigen Agenten des Projekts (aus dem Agenten-Reiter, vom Telefon oder aus anderen Sessions).",
    shape: { agent: z.string().min(1).optional().describe("Kürzel eines Agenten; weglassen für alle") },
    autoAllow: true,
    run: async (a) => {
      const one = typeof a.agent === "string" && a.agent.trim();
      const ids = one ? [resolveChild(one)] : d.agents.children(sessionId);
      const others = one ? [] : otherAgents();
      const otherLines = await Promise.all(
        others.map(async (p) => {
          const s = d.db.listSessions(p.id)[0];
          return `- ${await branchLabel(p)}: ${s ? (STATUS[s.status] ?? s.status) : "ohne Session"}, Ordner ${p.path}${p.exists ? "" : " (fehlt)"}`;
        }),
      );
      const otherBlock = otherLines.length ? `Weitere Agenten dieses Projekts (finish_agent mit dem Branch):\n${otherLines.join("\n")}` : "";
      if (!ids.length) return ["Diese Session hat keine Agenten gestartet.", otherBlock].filter(Boolean).join("\n");
      const lines = await Promise.all(
        ids.map(async (id) => {
          const s = d.db.getSession(id);
          if (!s) return `${short(id)}: gelöscht`;
          const branch = await d.worktrees.branchOf(s.cwd);
          const last = lastAnswer(d.db, id);
          return [
            `${short(id)} (${s.title ?? "ohne Titel"}): ${STATUS[s.status] ?? s.status}, Branch ${branch ?? "unbekannt"}, Ordner ${s.cwd}`,
            last ? `  Letzte Antwort: ${excerpt(last, 800)}` : "",
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
    description: "Schickt einem Agenten dieser Session eine weitere Anweisung; er arbeitet dann weiter.",
    shape: { agent: z.string().min(1).describe("Kürzel des Agenten"), text: z.string().min(1).describe("Anweisung, vollständig ausformuliert") },
    autoAllow: false,
    run: async (a) => {
      const id = resolveChild(String(a.agent));
      await d.send(id, String(a.text));
      return `An Agent ${short(id)} gesendet.`;
    },
  };

  const finisher = d.finisher;
  const finishAgent: SessionTool | null = finisher
    ? {
        name: "finish_agent",
        description:
          "Schließt einen Agenten dieses Projekts ab, auch einen, den diese Session nicht gestartet hat. merge: übernimmt seinen Branch in den Branch, von dem er abgezweigt ist (Rebase, dann Fast-Forward). discard: verwirft seine Arbeit. Danach sind seine Session beendet und Worktree-Ordner, FORGE-Eintrag und Branch gelöscht. Nur nach Rücksprache mit dem Nutzer. Bei Konflikten im Rebase löst der Agent sie selbst; danach erneut merge.",
        shape: {
          agent: z.string().min(1).describe("Kürzel eines eigenen Agenten oder Branch eines anderen Agenten des Projekts (wie agent_status sie nennt)"),
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
    tools: [startAgent, agentStatus, messageAgent, ...(finishAgent ? [finishAgent] : []), ...common, ...own.tools],
    context: [
      "Du läufst in FORGE, einer Desktop-Oberfläche für Claude Code. Neben deinen Werkzeugen gibt es FORGE-Werkzeuge (mcp__forge__…):",
      "- start_agent: startet einen parallelen Agenten in einem eigenen Git-Worktree auf eigenem Branch. Nur für Teilaufgaben, die wirklich unabhängig und gleichzeitig laufen können; der Auftrag muss für sich allein verständlich sein. Der Agent startet beim letzten Commit deines Branches; deinen nicht committeten Stand bekommt er nur mit with_changes=true.",
      "- agent_status und message_agent: Agenten verfolgen und anleiten. Ihre Arbeit liegt auf ihren Branches.",
      finisher
        ? `- finish_agent: einen Agenten des Projekts zusammenführen (merge) oder verwerfen (discard), auch einen fremden; danach sind Session, Worktree, FORGE-Eintrag und Branch weg. Nur nach Rücksprache mit dem Nutzer. ${
            autoMerge
              ? "In diesem Projekt führt FORGE fertige Agenten automatisch zusammen (auto-merge), sobald ihr Durchlauf ohne Fehler endet. Was dabei nicht klappt, legt FORGE dem Nutzer vor."
              : "FORGE zeigt dem Nutzer fertige Agenten auch selbst zur Entscheidung an."
          }`
        : "",
      autoMergeLine,
      autoCommitLine,
      "- notify: den Nutzer aktiv benachrichtigen. urgent=true nur, wenn er sofort gebraucht wird (kann sein Telefon klingeln lassen).",
      usageLine,
      ...own.context,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

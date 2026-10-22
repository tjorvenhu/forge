import { z } from "zod";
import { CREW_MESSAGE_MAX, CREW_TASK_DETAIL_MAX, CREW_TASK_TITLE_MAX, type Crew, type CrewMember, type CrewTask } from "@forge/protocol";
import type { SessionTool } from "../claude/runtime.js";
import { tr } from "../i18n/index.js";
import type { CrewService } from "./crew-service.js";

const short = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const fileList = (files: string[], max = 12) => (files.length > max ? `${files.slice(0, max).join(", ")} +${files.length - max}` : files.join(", "));

/** The crew as text for crew_status: members with their agents and files, tasks, latest events. */
export function describeCrew(crew: Crew): string {
  const m = tr().core.crew;
  const name = (id: string | null) => crew.members.find((x) => x.id === id)?.name ?? "?";
  const member = (x: CrewMember) => {
    const head = m.statusMember(x.name, x.self, x.online, x.branch, x.ahead);
    const lines = [head];
    if (x.files.length) lines.push(`  ${m.statusFiles(fileList(x.files))}`);
    for (const a of x.agents) {
      lines.push(`  ${m.statusAgent(a.title, a.status, a.branch, a.task ? short(a.task, 200) : null)}`);
      if (a.files.length) lines.push(`    ${m.statusAgentFiles(fileList(a.files, 10))}`);
      if (a.status === "idle" && a.lastResult) lines.push(`    → ${short(a.lastResult, 240)}`);
    }
    return lines.join("\n");
  };
  const task = (t: CrewTask) => {
    const owner = t.owner ? `${name(t.owner.member)}${t.owner.agent ? ` (${t.owner.agent})` : ""}` : null;
    return `- ${m.statusTask(t.status, t.id, short(t.title, 160), t.assignee ? name(t.assignee) : null, owner, t.note ? short(t.note, 200) : null)}`;
  };
  const open = crew.tasks.filter((t) => t.status !== "done");
  const done = crew.tasks.filter((t) => t.status === "done").slice(-8);
  const feed = crew.feed.slice(-12).map((f) => `- ${m.statusFeed(f.kind, name(f.from), f.agent, f.to ? name(f.to) : null, short(f.text, 240), f.files.length ? fileList(f.files, 8) : null)}`);
  return [
    m.statusHead(crew.name, crew.members.length),
    ...crew.members.map(member),
    "",
    open.length ? m.statusOpenTasks(open.map(task).join("\n")) : m.statusNoOpenTasks,
    done.length ? m.statusDoneTasks(done.map(task).join("\n")) : "",
    feed.length ? m.statusFeedHead(feed.join("\n")) : "",
    crew.behind > 0 ? m.statusBehind(crew.behind) : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * FORGE tools of a session whose project works in a crew, and the lines of start context that say
 * how to work together. null when the project has no crew (or we are not a member yet).
 */
export function crewSessionTools(crews: CrewService, sessionId: string, projectId: string, title: () => string | null): { tools: SessionTool[]; context: string } | null {
  const crew = crews.forProject(projectId);
  if (!crew) return null;
  const m = tr().core.crew;
  const crewId = crew.id;
  const agent = () => title() ?? m.unnamedSession;
  crews.sessionStarted(sessionId, projectId);

  const status: SessionTool = {
    name: "crew_status",
    description: m.statusDescription,
    shape: {},
    autoAllow: true,
    run: async () => {
      const c = crews.forProject(projectId);
      if (!c) return m.noCrewAnymore;
      // Everything this answer shows does not need to come again as a note.
      crews.takeNews(sessionId, true);
      return describeCrew(c);
    },
  };

  const task: SessionTool = {
    name: "crew_task",
    description: m.taskDescription,
    shape: {
      action: z.enum(["add", "take", "done", "release", "update", "remove"]).describe(m.taskAction),
      id: z.string().max(40).optional().describe(m.taskId),
      title: z.string().max(CREW_TASK_TITLE_MAX).optional().describe(m.taskTitleParam),
      detail: z.string().max(CREW_TASK_DETAIL_MAX).optional().describe(m.taskDetail),
      note: z.string().max(CREW_TASK_DETAIL_MAX).optional().describe(m.taskNote),
      assignee: z.string().max(60).optional().describe(m.taskAssignee),
    },
    autoAllow: true,
    run: async (a) => {
      const action = String(a.action);
      const id = typeof a.id === "string" ? a.id.trim() : "";
      const titleArg = typeof a.title === "string" ? a.title.trim() : "";
      const detail = typeof a.detail === "string" ? a.detail : undefined;
      const note = typeof a.note === "string" ? a.note : undefined;
      const assignee = typeof a.assignee === "string" && a.assignee.trim() ? crews.resolveMember(crewId, a.assignee) : undefined;
      if (action === "add") {
        if (!titleArg) throw new Error(m.taskNeedsTitle);
        const t = crews.addTask(crewId, { title: titleArg, detail, assignee: assignee ?? null }, "agent");
        return m.taskAdded(t.id, t.title, assignee ? crews.describeMember(crewId, assignee) : null);
      }
      if (!id) throw new Error(m.taskNeedsId);
      if (action === "remove") {
        crews.removeTask(crewId, id);
        return m.taskRemoved(id);
      }
      const status = action === "take" ? "in_progress" : action === "done" ? "done" : action === "release" ? "open" : undefined;
      const t = crews.updateTask(crewId, id, { status, title: titleArg || undefined, detail, note, assignee }, agent());
      return m.taskUpdated(t.id, t.status, t.title);
    },
  };

  const message: SessionTool = {
    name: "crew_message",
    description: m.messageDescription,
    shape: {
      text: z.string().min(1).max(CREW_MESSAGE_MAX).describe(m.messageText),
      to: z.string().max(60).optional().describe(m.messageTo),
    },
    autoAllow: true,
    run: async (a) => {
      const to = typeof a.to === "string" && a.to.trim() ? crews.resolveMember(crewId, a.to) : null;
      crews.message(crewId, String(a.text), to, agent());
      return to ? m.messageSentTo(crews.describeMember(crewId, to)) : m.messageSent;
    },
  };

  const others = crew.members.filter((x) => !x.self).map((x) => `${x.name}${x.online ? "" : ` (${m.offline})`}`);
  const context = [
    m.contextIntro(crew.name, others.length ? others.join(", ") : m.nobodyYet),
    m.contextHow,
    m.contextStatus,
    m.contextTasks,
    m.contextFiles,
    m.contextGit,
    m.contextMessages,
    m.contextNotes,
  ].join("\n");
  return { tools: [status, task, message], context };
}

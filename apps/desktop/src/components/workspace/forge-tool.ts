/** What a call of a FORGE tool (mcp__forge__…) means, for its own card in the chat. */
import type { DevToolsSection } from "@/stores/ui";
import { t } from "@/i18n";

export type ForgeToolIcon =
  | "knowledge"
  | "dev"
  | "notify"
  | "agentStart"
  | "agentStatus"
  | "agentMessage"
  | "agentMerge"
  | "agentDiscard"
  | "usage"
  | "screenshot"
  | "console"
  | "interact"
  | "forge";

/** Where the card's button leads: an entry of the knowledge (or the list), the agents, the dev tools. */
export type ForgeTarget = { kind: "knowledge"; id: string | null } | { kind: "agents" } | { kind: "devtools"; section: DevToolsSection };

export interface ForgeToolView {
  title: string;
  /** what the call was about: title of the entry, branch of the agent, search words */
  ref: string | null;
  icon: ForgeToolIcon;
  tone: "accent" | "warning" | "danger";
  target: ForgeTarget | null;
  /** shown elsewhere already: a notification has its own card */
  hidden: boolean;
}

const FORGE_PREFIX = /^mcp__forge__(.+)$/;

export function forgeToolName(name: string): string | null {
  return FORGE_PREFIX.exec(name)?.[1] ?? null;
}

const DEV_TARGET: Record<string, string> = t.chat.forgeTools.devTargets;
const DEV_ACTION: Record<string, { done: string; running: string; failed: string }> = t.chat.forgeTools.devActions;

function str(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const line = (text: string, label: string) => new RegExp(`^${label}: (.+)$`, "m").exec(text)?.[1]?.trim() ?? null;
/** what the preview reported as problems: console errors, exceptions, failed requests */
const PROBLEMS = /Fehler|Ausnahme|fehlgeschlagene Anfrage/;

/** Size of the screenshot a preview tool returned ("Screenshot: 1280x800 JPEG"), null without one. */
export function previewShot(tool: string, text: string): { width: number; height: number } | null {
  if (tool !== "preview_screenshot" && tool !== "preview_interact") return null;
  const m = /^Screenshot: (\d+)x(\d+)/m.exec(text);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/**
 * `result` is null while the call runs. Some tools answer a refusal as normal text ("Fehler: …",
 * "Nicht gespeichert: …"); those count as failed or as a warning, not as done.
 */
export function forgeToolView(tool: string, input: Record<string, unknown>, result: { text: string; isError: boolean } | null): ForgeToolView {
  const text = result?.text.trim() ?? "";
  const failed = !!result && (result.isError || /^Fehler:/.test(text));
  const done = !!result && !failed;
  const view = (v: Omit<ForgeToolView, "tone" | "hidden"> & { failedTitle: string; tone?: ForgeToolView["tone"]; hidden?: boolean }): ForgeToolView => ({
    title: failed ? v.failedTitle : v.title,
    ref: v.ref,
    icon: v.icon,
    tone: failed ? "danger" : (v.tone ?? "accent"),
    target: failed ? null : v.target,
    hidden: v.hidden ?? false,
  });

  switch (tool) {
    case "knowledge_save": {
      const refused = done && /^Nicht gespeichert/.test(text);
      const overlapping = done && text.includes("Überschneidet sich stark mit");
      const savedId = /^(?:Gespeichert|Aktualisiert): (\S+)/.exec(text)?.[1] ?? null;
      const saved = text.startsWith("Aktualisiert") ? t.chat.forgeTools.knowledgeUpdated : t.chat.forgeTools.knowledgeSaved;
      return view({
        title: !result ? t.chat.forgeTools.knowledgeSaving : refused ? t.chat.forgeTools.knowledgeRefused : overlapping ? t.chat.forgeTools.knowledgeOverlapping(saved) : saved,
        failedTitle: t.chat.forgeTools.knowledgeSaveFailed,
        ref: str(input, "title"),
        icon: "knowledge",
        tone: refused || overlapping ? "warning" : "accent",
        target: refused ? { kind: "knowledge", id: null } : { kind: "knowledge", id: savedId ?? str(input, "id") },
      });
    }
    case "knowledge_merge":
      return view({
        title: result ? t.chat.forgeTools.knowledgeMerged : t.chat.forgeTools.knowledgeMerging,
        failedTitle: t.chat.forgeTools.knowledgeMergeFailed,
        ref: str(input, "title"),
        icon: "knowledge",
        target: { kind: "knowledge", id: /^Zusammengeführt: (\S+)/.exec(text)?.[1] ?? null },
      });
    case "knowledge_read":
      return view({
        title: result ? t.chat.forgeTools.knowledgeRead : t.chat.forgeTools.knowledgeReading,
        failedTitle: t.chat.forgeTools.knowledgeReadFailed,
        ref: str(input, "id"),
        icon: "knowledge",
        target: { kind: "knowledge", id: str(input, "id") },
      });
    case "knowledge_search":
      return view({
        title: !result ? t.chat.forgeTools.knowledgeSearching : text.startsWith("Keine Treffer") ? t.chat.forgeTools.knowledgeSearchedNone : t.chat.forgeTools.knowledgeSearched,
        failedTitle: t.chat.forgeTools.knowledgeSearchFailed,
        ref: str(input, "query"),
        icon: "knowledge",
        target: { kind: "knowledge", id: null },
      });
    case "knowledge_delete": {
      const missing = done && text.startsWith("Kein Eintrag");
      return view({
        title: !result ? t.chat.forgeTools.knowledgeDeleting : missing ? t.chat.forgeTools.knowledgeNotFound : t.chat.forgeTools.knowledgeDeleted,
        failedTitle: t.chat.forgeTools.knowledgeDeleteFailed,
        ref: str(input, "id"),
        icon: "knowledge",
        tone: missing ? "warning" : "accent",
        target: { kind: "knowledge", id: null },
      });
    }
    case "dev_environment":
      return view({
        title: result ? t.chat.forgeTools.devQueried : t.chat.forgeTools.devQuerying,
        failedTitle: t.chat.forgeTools.devQueryFailed,
        ref: null,
        icon: "dev",
        target: { kind: "devtools", section: "server" },
      });
    case "dev_control": {
      const target = DEV_TARGET[str(input, "target") ?? ""] ?? t.chat.forgeTools.devEnvironment;
      const action = DEV_ACTION[str(input, "action") ?? ""] ?? t.chat.forgeTools.devActionFallback;
      return view({
        title: `${target} ${result ? action.done : action.running}`,
        failedTitle: `${target} ${action.failed}`,
        ref: null,
        icon: "dev",
        target: { kind: "devtools", section: input.target === "database" ? "database" : "server" },
      });
    }
    case "notify": {
      const urgent = input.urgent === true;
      return view({
        title: urgent ? t.chat.forgeTools.notifyUrgent : t.chat.forgeTools.notify,
        failedTitle: t.chat.forgeTools.notifyFailed,
        ref: str(input, "message"),
        icon: "notify",
        tone: urgent ? "warning" : "accent",
        target: null,
        hidden: done,
      });
    }
    case "start_agent":
      return view({
        title: result ? t.chat.forgeTools.agentStarted : t.chat.forgeTools.agentStarting,
        failedTitle: t.chat.forgeTools.agentStartFailed,
        ref: /Branch (\S+?),/.exec(text)?.[1] ?? str(input, "name"),
        icon: "agentStart",
        target: { kind: "agents" },
      });
    case "agent_status":
      return view({
        title: result ? t.chat.forgeTools.agentStatus : t.chat.forgeTools.agentStatusRunning,
        failedTitle: t.chat.forgeTools.agentStatusFailed,
        ref: str(input, "agent"),
        icon: "agentStatus",
        target: { kind: "agents" },
      });
    case "message_agent":
      return view({
        title: result ? t.chat.forgeTools.agentMessaged : t.chat.forgeTools.agentMessaging,
        failedTitle: t.chat.forgeTools.agentMessageFailed,
        ref: str(input, "agent"),
        icon: "agentMessage",
        target: { kind: "agents" },
      });
    case "finish_agent": {
      const discard = input.action === "discard";
      return view({
        title: discard ? (result ? t.chat.forgeTools.agentDiscarded : t.chat.forgeTools.agentDiscarding) : result ? t.chat.forgeTools.agentMerged : t.chat.forgeTools.agentMerging,
        failedTitle: discard ? t.chat.forgeTools.agentDiscardFailed : t.chat.forgeTools.agentMergeFailed,
        ref: str(input, "agent"),
        icon: discard ? "agentDiscard" : "agentMerge",
        target: { kind: "agents" },
      });
    }
    case "usage_status": {
      const reached = done && text.startsWith("Limit erreicht");
      return view({
        title: !result ? t.chat.forgeTools.usageQuerying : reached ? t.chat.forgeTools.usageLimitReached : t.chat.forgeTools.usageQueried,
        failedTitle: t.chat.forgeTools.usageFailed,
        ref: /^5 Stunden: (\d+ %)/m.exec(text)?.[1] ?? null,
        icon: "usage",
        tone: reached ? "warning" : "accent",
        target: null,
      });
    }
    case "preview_screenshot": {
      const problems = done && PROBLEMS.test(line(text, "Konsole") ?? "");
      return view({
        title: !result ? t.chat.forgeTools.screenshotTaking : problems ? t.chat.forgeTools.screenshotProblems : t.chat.forgeTools.screenshot,
        failedTitle: t.chat.forgeTools.screenshotFailed,
        ref: line(text, "Adresse") ?? str(input, "url") ?? str(input, "path"),
        icon: "screenshot",
        tone: problems ? "warning" : "accent",
        target: { kind: "devtools", section: "server" },
      });
    }
    case "preview_console": {
      const summary = line(text, "Zusammenfassung");
      const problems = done && PROBLEMS.test(summary ?? "");
      return view({
        title: !result ? t.chat.forgeTools.consoleReading : problems ? t.chat.forgeTools.consoleProblems : t.chat.forgeTools.consoleRead,
        failedTitle: t.chat.forgeTools.consoleFailed,
        ref: summary ?? str(input, "url") ?? str(input, "path"),
        icon: "console",
        tone: problems ? "warning" : "accent",
        target: { kind: "devtools", section: "server" },
      });
    }
    case "preview_interact": {
      const total = Array.isArray(input.steps) ? input.steps.length : 0;
      const stopped = done ? /^Abgebrochen nach Schritt (\d+) von (\d+)/m.exec(text) : null;
      return view({
        title: !result
          ? t.chat.forgeTools.stepsRunning(total)
          : stopped
            ? t.chat.forgeTools.stepFailed(stopped[1]!, stopped[2]!)
            : t.chat.forgeTools.stepsDone(total),
        failedTitle: t.chat.forgeTools.stepsFailed,
        ref: line(text, "Adresse") ?? str(input, "url") ?? str(input, "path"),
        icon: "interact",
        tone: stopped ? "warning" : "accent",
        target: { kind: "devtools", section: "server" },
      });
    }
    default:
      return view({ title: `FORGE: ${tool}`, failedTitle: t.chat.forgeTools.genericFailed(tool), ref: null, icon: "forge", target: null });
  }
}

export function forgeTargetLabel(target: ForgeTarget): string {
  if (target.kind === "knowledge") return target.id ? t.chat.forgeTools.openEntry : t.chat.forgeTools.openKnowledge;
  return target.kind === "agents" ? t.chat.forgeTools.viewAgents : t.chat.forgeTools.openDevTools;
}

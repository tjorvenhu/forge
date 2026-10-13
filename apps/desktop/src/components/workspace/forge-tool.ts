/** What a call of a FORGE tool (mcp__forge__…) means, for its own card in the chat. */
import type { DevToolsSection } from "@/stores/ui";

export type ForgeToolIcon = "knowledge" | "dev" | "notify" | "agentStart" | "agentStatus" | "agentMessage" | "agentMerge" | "agentDiscard" | "forge";

/** Where the card's button leads: an entry of the knowledge (or the list), the agents, the dev tools. */
export type ForgeTarget = { kind: "knowledge"; id: string | null } | { kind: "agents" } | { kind: "devtools"; section: DevToolsSection };

export interface ForgeToolView {
  title: string;
  /** what the call was about: title of the entry, branch of the agent, search words */
  ref: string | null;
  icon: ForgeToolIcon;
  tone: "accent" | "warning" | "danger";
  /** changed something (saved, started, deleted) and gets the highlighted card; lookups stay a quiet line */
  prominent: boolean;
  target: ForgeTarget | null;
  /** shown elsewhere already: a notification has its own card */
  hidden: boolean;
}

const FORGE_PREFIX = /^mcp__forge__(.+)$/;

export function forgeToolName(name: string): string | null {
  return FORGE_PREFIX.exec(name)?.[1] ?? null;
}

const DEV_TARGET: Record<string, string> = { "dev-server": "Dev-Server", database: "Test-Datenbank" };
const DEV_ACTION: Record<string, string> = { start: "gestartet", stop: "gestoppt", restart: "neu gestartet", reset: "geleert" };

function str(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
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
    prominent: v.prominent || failed,
    target: failed ? null : v.target,
    hidden: v.hidden ?? false,
  });

  switch (tool) {
    case "knowledge_save": {
      const refused = done && /^Nicht gespeichert/.test(text);
      const savedId = /^(?:Gespeichert|Aktualisiert): (\S+)/.exec(text)?.[1] ?? null;
      return view({
        title: !result ? "Speichert im Projektwissen" : refused ? "Nicht gespeichert: ähnlicher Eintrag vorhanden" : text.startsWith("Aktualisiert") ? "Projektwissen aktualisiert" : "Im Projektwissen gespeichert",
        failedTitle: "Speichern im Projektwissen fehlgeschlagen",
        ref: str(input, "title"),
        icon: "knowledge",
        tone: refused ? "warning" : "accent",
        prominent: true,
        target: refused ? { kind: "knowledge", id: null } : { kind: "knowledge", id: savedId ?? str(input, "id") },
      });
    }
    case "knowledge_read":
      return view({
        title: result ? "Im Projektwissen gelesen" : "Liest im Projektwissen",
        failedTitle: "Eintrag im Projektwissen nicht lesbar",
        ref: str(input, "id"),
        icon: "knowledge",
        prominent: false,
        target: { kind: "knowledge", id: str(input, "id") },
      });
    case "knowledge_search":
      return view({
        title: !result ? "Durchsucht das Projektwissen" : text.startsWith("Keine Treffer") ? "Projektwissen durchsucht, keine Treffer" : "Projektwissen durchsucht",
        failedTitle: "Suche im Projektwissen fehlgeschlagen",
        ref: str(input, "query"),
        icon: "knowledge",
        prominent: false,
        target: { kind: "knowledge", id: null },
      });
    case "knowledge_delete": {
      const missing = done && text.startsWith("Kein Eintrag");
      return view({
        title: !result ? "Löscht Eintrag im Projektwissen" : missing ? "Eintrag im Projektwissen nicht gefunden" : "Eintrag im Projektwissen gelöscht",
        failedTitle: "Löschen im Projektwissen fehlgeschlagen",
        ref: str(input, "id"),
        icon: "knowledge",
        tone: missing ? "warning" : "accent",
        prominent: true,
        target: { kind: "knowledge", id: null },
      });
    }
    case "dev_environment":
      return view({
        title: result ? "Dev-Umgebung abgefragt" : "Fragt die Dev-Umgebung ab",
        failedTitle: "Dev-Umgebung nicht abrufbar",
        ref: null,
        icon: "dev",
        prominent: false,
        target: { kind: "devtools", section: "server" },
      });
    case "dev_control": {
      const target = DEV_TARGET[str(input, "target") ?? ""] ?? "Dev-Umgebung";
      const action = DEV_ACTION[str(input, "action") ?? ""] ?? "gesteuert";
      return view({
        title: result ? `${target} ${action}` : `${target} wird ${action}`,
        failedTitle: `${target} nicht ${action}`,
        ref: null,
        icon: "dev",
        prominent: true,
        target: { kind: "devtools", section: input.target === "database" ? "database" : "server" },
      });
    }
    case "notify": {
      const urgent = input.urgent === true;
      return view({
        title: urgent ? "Dringende Benachrichtigung" : "Benachrichtigung",
        failedTitle: "Benachrichtigung fehlgeschlagen",
        ref: str(input, "message"),
        icon: "notify",
        tone: urgent ? "warning" : "accent",
        prominent: true,
        target: null,
        hidden: done,
      });
    }
    case "start_agent":
      return view({
        title: result ? "Paralleler Agent gestartet" : "Startet parallelen Agenten",
        failedTitle: "Agent nicht gestartet",
        ref: /Branch (\S+?),/.exec(text)?.[1] ?? str(input, "name"),
        icon: "agentStart",
        prominent: true,
        target: { kind: "agents" },
      });
    case "agent_status":
      return view({
        title: result ? "Stand der Agenten abgefragt" : "Fragt den Stand der Agenten ab",
        failedTitle: "Stand der Agenten nicht abrufbar",
        ref: str(input, "agent"),
        icon: "agentStatus",
        prominent: false,
        target: { kind: "agents" },
      });
    case "message_agent":
      return view({
        title: result ? "Anweisung an Agent gesendet" : "Sendet Anweisung an Agent",
        failedTitle: "Anweisung an Agent nicht gesendet",
        ref: str(input, "agent"),
        icon: "agentMessage",
        prominent: true,
        target: { kind: "agents" },
      });
    case "finish_agent": {
      const discard = input.action === "discard";
      return view({
        title: discard ? (result ? "Agent verworfen" : "Verwirft Agent") : result ? "Agent zusammengeführt" : "Führt Agent zusammen",
        failedTitle: discard ? "Agent nicht verworfen" : "Agent nicht zusammengeführt",
        ref: str(input, "agent"),
        icon: discard ? "agentDiscard" : "agentMerge",
        prominent: true,
        target: { kind: "agents" },
      });
    }
    default:
      return view({ title: `FORGE: ${tool}`, failedTitle: `FORGE: ${tool} fehlgeschlagen`, ref: null, icon: "forge", prominent: false, target: null });
  }
}

export function forgeTargetLabel(t: ForgeTarget): string {
  if (t.kind === "knowledge") return t.id ? "Eintrag öffnen" : "Projektwissen öffnen";
  return t.kind === "agents" ? "Agenten ansehen" : "Dev-Tools öffnen";
}

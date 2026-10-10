import type { FileDiff } from "@forge/protocol";
import { redactText } from "../policy/redact.js";

const MAX_DIFF_CHARS = 30_000;

export function diffToText(d: FileDiff): string {
  if (d.binary) return `--- ${d.path} (binär)\n`;
  const body = d.lines
    .filter((l) => l.kind !== "meta")
    .map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : l.kind === "hunk" ? "" : " ") + l.text)
    .join("\n");
  return `--- ${d.path}\n${body}\n`;
}

/** Builds the one-shot prompt. Diffs are redacted and capped; sensitive files never get here. */
export function buildCommitPrompt(diffs: FileDiff[], recentSubjects: string[], skipped: string[]): string {
  let diffText = "";
  for (const d of diffs) {
    const t = diffToText(d);
    if (diffText.length + t.length > MAX_DIFF_CHARS) {
      diffText += `\n[weitere Änderungen gekürzt: ${d.path} …]\n`;
      break;
    }
    diffText += t;
  }
  const history = recentSubjects.length
    ? `Letzte Commit-Betreffzeilen dieses Repositorys (Stil und Sprache übernehmen):\n${recentSubjects.map((s) => `- ${s}`).join("\n")}`
    : "Das Repository hat noch keine Commits. Format zwingend „typ: Beschreibung“ nach Conventional Commits (feat, fix, chore, docs, refactor, test), Beschreibung auf Deutsch.";
  return [
    "Schreibe eine Git-Commit-Nachricht für die folgenden Änderungen.",
    "Regeln:",
    "- Antworte nur mit der Commit-Nachricht, ohne Einleitung, ohne Anführungszeichen, ohne Codeblock.",
    "- Erste Zeile: Betreff, höchstens 72 Zeichen, Imperativ bzw. im Stil der bisherigen Commits.",
    "- Bei mehreren unabhängigen Änderungen: Leerzeile, dann kurze Stichpunkte mit \"- \".",
    "- Beschreibe nur, was im Diff wirklich steht. Nichts erfinden.",
    history,
    skipped.length ? `Nicht mitgeschickt (sensible Dateien): ${skipped.join(", ")}` : "",
    "",
    "Diff:",
    redactText(diffText),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Strips fences, quotes and chatter the model might add despite instructions. */
export function cleanCommitMessage(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  t = t.replace(/^(commit[- ]nachricht|commit message)\s*:\s*/i, "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim();
  const [subject = "", ...rest] = t.split(/\r?\n/);
  const body = rest.join("\n").trim();
  return body ? `${subject.trim()}\n\n${body}` : subject.trim();
}

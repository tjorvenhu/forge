import type { FileDiff } from "@forge/protocol";
import { redactText } from "../policy/redact.js";
import { tr } from "../i18n/index.js";

const MAX_DIFF_CHARS = 30_000;

export function diffToText(d: FileDiff): string {
  if (d.binary) return `--- ${d.path} (${tr().system.commitPrompt.binary})\n`;
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
      diffText += `\n[${tr().system.commitPrompt.truncated(d.path)}]\n`;
      break;
    }
    diffText += t;
  }
  const m = tr().system.commitPrompt;
  const history = recentSubjects.length ? m.history(recentSubjects.map((s) => `- ${s}`).join("\n")) : m.noHistory;
  return [
    m.intro,
    m.rules,
    m.ruleOnly,
    m.ruleSubject,
    m.ruleBullets,
    m.ruleTruth,
    history,
    skipped.length ? m.skipped(skipped.join(", ")) : "",
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

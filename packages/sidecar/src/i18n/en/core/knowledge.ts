import type { knowledge as De } from "../../de/core/knowledge.js";

export const knowledge: typeof De = {
  invalidId: (id) => `Invalid ID "${id}".`,
  notFound: (id) => `No entry "${id}".`,
  mergeNeedsTwo: "Merging needs at least two different entries.",
  nothingToFix: "Every reference of this entry exists in the project. There is nothing to fix.",

  schemaTitle: "short title with the search terms, at most 100 characters",
  schemaSummary: "one sentence, at most 250 characters",
  schemaTags: "2 to 6 lowercase keywords",
  schemaContent: "the merged entry in Markdown",
  schemaPlanIds: "IDs of the entries; the first one stays, the others are merged into it",
  schemaPlanReason: "one short sentence on why these entries cover the same topic",

  entryHeader: (id, date) => `=== Entry ${id} (as of ${date}) ===`,
  fieldTitle: "Title",
  fieldSummary: "Summary",
  fieldTags: "Tags",
  fieldOutline: "Outline",

  mergePrompt: [
    "Merge these entries from the project knowledge of a software project into a single entry.",
    "- Keep all knowledge: file paths, commands, reasons, pitfalls, dates. Only drop duplicates.",
    "- If entries contradict each other, the more recent one wins.",
    "- Do not invent anything or add anything that is not in the entries.",
    "- Title: short, with the terms people search for (code names in parentheses are welcome).",
    "- Summary: one sentence on what it covers and when the entry is needed.",
    "- Tags: 2 to 6, taken from those of the entries.",
    "- Content: Markdown, starts with '# <Title>', followed by sections with '##'. Same language as the entries.",
  ],

  mergePlanPrompt: (maxGroup, maxChars) => [
    "Review the project knowledge of a software project: which entries cover the same topic and should be merged into one entry?",
    "- Only entries that really cover the same topic or duplicate each other. The same area (e.g. both UI) or the same tags are not enough.",
    `- At most ${maxGroup} entries per group, each entry in at most one group.`,
    `- At most about ${maxChars} characters together (sum of the lengths), otherwise the new entry gets too long.`,
    "- The first entry of a group stays: pick the most comprehensive one.",
    "- If nothing belongs together, return an empty list. Better one group too few than a forced one.",
  ],
  mergePlanPairs: "A local word comparison considers these pairs similar (just a hint, check yourself):",
  mergePlanEntryHeader: (id, chars) => `=== ${id} (${chars} characters) ===`,

  fixPrompt: [
    "This entry from the project knowledge of a software project refers to files, folders or identifiers that no longer exist in the project. Fix it.",
    "- Replace outdated references with the current ones when the hints below clearly show where something moved or how it was renamed.",
    "- If it is not clear what replaced it, remove the statement or briefly mark it as outdated. Do not guess.",
    "- Everything else stays unchanged: structure, reasons, pitfalls, language and tone.",
    "- Do not invent anything or add anything that is neither in the entry nor in the hints.",
    "- Only change title, summary and tags if they contain outdated names themselves.",
    "- Content: Markdown as before, starts with '# <Title>'.",
  ],
  fixMissing: (refs) => `Missing references: ${refs}`,
  fixHints: "Hints from the project:",
  none: "(none)",

  lastChangedIn: (hash, subject) => `last changed in ${hash}: ${subject}`,
  seenEarlier: "was still in the project at an earlier check",
  sameName: (names) => `same name: ${names}`,
  refPath: "Path",
  refName: "Identifier",
  changesIn: (hash) => `Changes in ${hash} that affect it:`,
  filesIn: (hash) => `Files in ${hash}:`,
  gitGrepFailed: (code) => `git grep failed (code ${code})`,
};

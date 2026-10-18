import type { templates as De } from "../../de/core/templates.js";

export const templates: typeof De = {
  notFound: "This template no longer exists.",
  mixedOrder: "Global templates and project templates cannot be sorted together.",

  schemaName: "2 to 4 words to find it again",
  schemaText: "the instruction to Claude, cleanly worded, placeholders like {file}",
  schemaProject: "project name if all occurrences come from one project, otherwise null",
  schemaCount: "roughly how often the request came up",

  learnPrompt: (minRepeats) => [
    "Below are messages a user sent to Claude Code, newest first, each with the project in square brackets.",
    `Find requests the user sends again and again (at least ${minRepeats} times, the same or with the same meaning, typos included) and turn them into at most 5 reusable prompt templates.`,
    "Rules:",
    "- Only real repetitions. No one-offs and no bare replies like \"yes\", \"thanks\", \"continue\".",
    "- A command of one or two words (such as \"push\") is only worth it if the template says clearly more: then spell out the full request the way the user means it.",
    "- text: instruction to Claude in the user's language, without typos, concise. Whatever changes from time to time becomes a placeholder in curly braces without spaces, such as {file}, {project}, {branch}, {topic}.",
    "- name: 2 to 4 words in English.",
    "- project: the project name from the brackets if all occurrences come from one project, otherwise null.",
    "- Nothing an existing template already covers and nothing similar to a dismissed one.",
    "- No passwords, keys, phone numbers or other personal data.",
    "- If there are no repetitions, return an empty list.",
  ],
  existing: "Existing templates:",
  dismissed: "Dismissed templates:",
  messages: "Messages:",
  none: "(none)",

  tooFewMessages: (count, min) => `Not enough messages to learn from yet (${count} of ${min}).`,
  learnedFull: (max) => `There are already ${max} learned templates. Delete unused ones and FORGE will learn more.`,
  unreadableAnswer: "Claude did not return a readable answer.",
  learnedDescription: (count) => `Learned from about ${count} similar messages`,
  learned: (names) => `${names.length === 1 ? "New template" : `${names.length} new templates`} learned: ${names.join(", ")}.`,
  nothingNew: "No new recurring requests found.",
};

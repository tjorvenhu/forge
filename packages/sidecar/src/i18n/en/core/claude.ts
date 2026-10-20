import type { claude as De } from "../../de/core/claude.js";

export const claude: typeof De = {
  // attachments.ts
  attachDenied: (p) => `This file may not be attached: ${p}`,
  fileNotFound: (p) => `File not found: ${p}`,
  notAFile: (p) => `Not a file: ${p}`,
  imageFormatUnsupported: (name) => `Image format not supported: ${name}`,
  binaryNotAllowed: (name) => `${name}: binary files can only be attached as an image or PDF.`,
  readImageHint: "View it with the Read tool if needed; it scales images down.",
  readPdfHint: "Read it with the Read tool if needed, in parts with the pages parameter when it has many pages.",
  readFileHint: "Read it with the Read tool if needed, in parts with offset and limit when it is large.",
  attachedTooLarge: (name, size, file) => `Attached file: ${name} (${size}), too large for the message itself. It is stored at ${file}`,
  attachedFile: (name) => `Attached file: ${name}`,
  decimalSeparator: ".",
  spillFileName: "message.txt",
  messageSpilled: (omitted, total, file) =>
    `[… ${omitted} characters omitted. The message has ${total} characters and is too long for one input. The full text is in ${file}. Read it with the Read tool if needed, in parts with offset and limit.]`,

  // uploads.ts
  uploadRunning: "This upload is already running.",
  uploadIncomplete: "Upload incomplete. Please paste the file again.",
  uploadTooLarge: (name, mb) => `${name} is larger than ${mb} MB.`,

  // normalize.ts
  truncationMark: "\n[… truncated]",

  // diagnostics.ts
  notFound: "not found",
  authUnreadable: "Auth status not readable",

  // update.ts
  versionQueryFailed: (status) => `Version check failed (HTTP ${status})`,
  versionQueryEmpty: "Version check returned no version number",

  // setup.ts
  setupBusy: "A setup step is already running.",
  installed: (where) => `Installed: ${where}`,
  installerNotFound: "The installer finished, but Claude Code was not found.",
  installerExit: (code) => `Installer exited with code ${code}`,
  notInstalled: "Claude Code is not installed.",
  updateExit: (code) => `Update exited with code ${code}`,
  updateDone: (version) => (version ? `Claude Code ${version} is installed.` : "Update complete."),
  updateExternallyManaged: "This Claude Code is managed by a package manager and could not be updated this way. Leave the Claude path empty in settings so FORGE uses its own, updatable installation.",
  loggedIn: "Signed in",
  loginExit: (code) => `Sign-in exited with code ${code}`,
  logoutFailed: (why) => `Sign-out failed${why ? `: ${why}` : "."}`,
  noLogin: "No sign-in in progress.",

  // runtime.ts
  remoteUnavailable: "Remote Control is not available with this version of Claude Code.",
  usageUnavailable: "Plan usage is not available with this version of Claude Code.",
  oneShotTimeout: (what, seconds) => `${what}: Claude Code did not respond within ${seconds} seconds.`,
  oneShotCommands: "Loading slash commands",
  oneShotAnswer: "Answer from Claude",
  oneShotUsage: "Plan usage",
  noAnswer: (subtype) => `Claude could not produce an answer (${subtype})`,
  noStructuredAnswer: "Claude did not return a structured answer.",
  approvalFailed: "The approval request could not be processed.",
  policyCheckFailed: "The policy check failed, so the call was denied to be safe.",
  policyDenied: (rule, message) => `FORGE policy (${rule}): ${message}`,
  noTaskOutput: "This version of Claude Code does not provide output of background tasks.",
  toolError: (message) => `Error: ${message}`,
  capabilities: {
    sessionStart: { label: "Start session", note: "Agent SDK query() with streaming input" },
    sessionSend: { label: "Send prompt", note: "More messages in the same session" },
    streamTokens: { label: "Token streaming", note: "includePartialMessages" },
    streamTools: { label: "Tool events", note: "tool_use / tool_result" },
    approvals: { label: "Approval requests", note: "canUseTool callback" },
    interrupt: "Stop/Cancel",
    interruptReceipt: "interrupt() with receipt",
    resume: { label: "Resume", note: "options.resume, terminal sessions too" },
    sessionsList: { label: "List sessions", note: "listSessions({ dir })" },
    modelSwitch: { label: "Switch model", note: "setModel()" },
    permissionModes: { label: "Permission modes", note: "default, acceptEdits, plan, bypassPermissions" },
    policyHook: { label: "Hard blocklist", note: "PreToolUse hook, applies in bypass mode too" },
    slashCommands: "Slash commands",
    slashReported: (n) => `${n} commands/skills reported; interactive built-ins not available`,
    slashUnknown: "List known only after a session starts",
    attachments: { label: "Images/files in the prompt", note: "Images, PDFs and text files as content blocks" },
    rewind: { label: "Revert files", note: "enableFileCheckpointing + rewindFiles()" },
    fork: { label: "Fork", note: "forkSession() up to a message" },
    questions: { label: "Questions and plan approval", note: "AskUserQuestion answers and ExitPlanMode via canUseTool" },
    context: { label: "Context usage", note: "getContextUsage() after every turn, /compact" },
    remote: { label: "Remote Control (Claude app)", note: "Bridge of the running session; not documented in the SDK" },
    usage: { label: "Token usage", note: "from result.usage" },
    cost: { label: "Cost", note: "With a subscription only the API equivalent, not shown" },
    terminal: { label: "Embedded terminal", note: "xterm.js + PTY in the Tauri shell" },
  },

  // usage.ts
  windowFiveHours: "5 hours",
  windowWeek: "Week",
  windowWeekModel: (model) => `Week ${model}`,
  limitReached: (until) => `Limit reached${until ? `, free again ${until}` : ""}. New turns fail until then.`,
  limitWarning: (percent, reset) => `Limit almost reached${percent !== null ? ` (${percent}%)` : ""}${reset ? `, resets ${reset}` : ""}.`,
  usageUnavailableLine: (error) => `Usage not available${error ? `: ${error}` : ""}.`,
  windowLine: (label, percent, reset, outlook) => `${label}: ${percent}% used${reset ? `, resets ${reset}` : ""}${outlook ? `. Forecast: ${outlook}` : ""}`,
  noForecast: "Forecast: not enough readings yet, or no increase.",
  subscription: (type) => `Subscription: ${type}`,
  today: (time) => `today ${time}`,
  forecastLimit: (at) => `at this pace the limit is reached around ${at}, before the reset`,
  forecastEnough: "lasts until the reset",
  limitWarningPart: (label, at, reset) => `${label} around ${at}${reset ? ` (resets ${reset})` : ""}`,
  limitWarningText: (parts) => `At this pace the usage limit is reached before the reset: ${parts}. More agents use it up faster.`,
};

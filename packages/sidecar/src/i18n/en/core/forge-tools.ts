import type { forgeTools as De } from "../../de/core/forge-tools.js";

export const forgeTools: typeof De = {
  knowledgeSearchDescription:
    "Searches the project knowledge (title, tags, summary, text). Returns ID, title, summary and a text excerpt per hit.",
  knowledgeSearchQuery: "Search terms, e.g. 'migration prisma' or 'deploy coolify'",
  knowledgeSearchNone: "No hits in the project knowledge.",
  knowledgeSearchStale: (refs) => `Outdated, no longer exists: ${refs}`,
  knowledgeReadDescription: "Reads a project knowledge entry in full.",
  knowledgeReadId: "ID from the index or knowledge_search",
  knowledgeReadStale: (refs) =>
    `Outdated: These references no longer exist in the project: ${refs}. Don't rely on the entry for these points, check the code and correct the entry with knowledge_save.`,
  knowledgeReadSummary: "Summary",
  knowledgeReadTags: "Tags",
  knowledgeReadNoTags: "none",
  knowledgeReadUpdated: "Updated",
  entryTitle:
    "Short, unique title with the terms people search for, e.g. 'Context menu (ContextMenuHost, addContextItems)'. Appears like this in every session's index",
  entrySummary: "One short sentence: what it is about and when the entry is needed",
  entryTags: (known) =>
    `2 to 5 lowercase keywords: area and kind (e.g. pitfall, convention). ${known.length ? `Reuse existing ones: ${known.join(", ")}` : ""}`.trim(),
  entryContent: "Content in Markdown: concrete, with file paths, commands and reasons. When updating, the complete new text",
  overlapHint: (near) => ` Overlaps heavily with: ${near}. If it is the same topic, merge the entries with knowledge_merge.`,
  knowledgeSaveDescription:
    "Creates a project knowledge entry or updates it (with id). For lasting, useful knowledge that isn't obvious from the code. One entry per topic; extend existing entries instead of creating duplicates.",
  knowledgeSaveId: "ID of an existing entry to update; empty creates a new one",
  knowledgeSaveForce: "true creates a new entry despite a similar one",
  knowledgeSaveSimilar: (near) =>
    `Not saved: There are already similar entries: ${near}. Read them with knowledge_read and update the matching one with id, or set force=true if it really is a different topic.`,
  knowledgeSaved: (updated, id, file) => `${updated ? "Updated" : "Saved"}: ${id} (${file}).`,
  knowledgeMergeDescription:
    "Merges project knowledge entries covering the same topic into one: the first keeps its ID and gets the new text, the others are deleted. Read them all with knowledge_read first; content must contain the knowledge of all entries, duplicates and outdated parts are dropped.",
  knowledgeMergeIds: "IDs of the entries; the first one is kept",
  knowledgeMerged: (id, file, removed) => `Merged: ${id} (${file}). Deleted: ${removed}.`,
  knowledgeDeleteDescription: "Deletes an outdated or wrong project knowledge entry.",
  knowledgeDeleted: (id) => `Deleted: ${id}`,
  knowledgeNoEntry: (id) => `No entry ${id}.`,
  devEnvironmentDescription:
    "State of the project's dev server and test database: status, address, connection URL of the local PostgreSQL test database, names of the test environment variables and the last lines of dev server output. In an agent worktree also what FORGE prepared there (dependencies, local config, build output, own database) and what of it is still running or failed.",
  devEnvironmentWait: "true: in an agent worktree, wait until the preparation is done first (at most 4 minutes)",
  devControlDescription:
    "Starts, stops or restarts the dev server or test database. reset (database only) deletes all data in the test database. The dev server gets the test environment and, while it runs, the test database URL.",
  knowledgeIntro: "Project knowledge (FORGE): Collected knowledge about this project lives in .forge/knowledge (Markdown, in Git).",
  knowledgeInWorktree: (dir) =>
    `You are working in a worktree. The project knowledge lives in the main project's folder: ${dir}. A copy in your worktree is not authoritative.`,
  knowledgeIndex: (total, shown, summaries, lines) =>
    `Index at the start of this session (${total} entries${total > shown ? `, the ${shown} newest` : ""}, ${summaries ? "ID: title. summary [tags]" : "ID: title [tags]; knowledge_search returns summaries"}; knowledge_search finds newer ones):\n${lines}`,
  knowledgeEmpty: "There were no entries yet when this session started. Create the first ones as soon as you find out something worth keeping.",
  knowledgeRead:
    "- Before working in an area that has a matching entry, read it with mcp__forge__knowledge_read. For questions about workflows, decisions or pitfalls, search with knowledge_search first.",
  knowledgeSave:
    "- Use knowledge_save for what saves future sessions time and isn't obvious from the code or CLAUDE.md: decisions with reasons, pitfalls and their fix, workflows (setup, tests, deploy), quirks of external services. Save as soon as you find out something like this, not at the end. Small tasks (commit, push, short question, small fix without new insight) need no entry: saving costs the user 15 to 35 seconds of waiting.",
  knowledgeRules:
    "- No secrets (passwords, tokens, keys), no session log, nothing short-lived. One topic per entry; update existing entries instead of creating new ones, correct outdated ones or delete them with knowledge_delete. Title and tags are what other sessions see in the index: titles with search terms, reuse existing tags.",
  knowledgeOverlaps: (pairs) =>
    `- Cleanup: These entries probably overlap: ${pairs}. If you are working in that area anyway, read them and merge them with knowledge_merge if they cover the same topic.`,
  knowledgeLong: (list) => `- Very long entries: ${list}. If you update one of them, cut it down to what isn't in the code.`,
  knowledgeOnlyTools: "- Change the project knowledge only with the knowledge_* tools, not with Read, Edit or Write on the files.",
  devIntro:
    "Dev environment (FORGE): mcp__forge__dev_environment shows the dev server (address, latest output) and the local PostgreSQL test database (connection URL). Use this test database for tests, migrations and experiments with data, never a production database. dev_control starts, stops or empties it and restarts the dev server.",
  previewIntro:
    "Preview (FORGE): preview_screenshot shows you the running web app as an image (default: the dev server's address, path for subpages), preview_console returns console messages, exceptions and failed requests, preview_interact clicks, types and waits on the page. Only addresses on this machine. Check UI changes with it yourself before reporting them as done.",
  previewUrl: "Local address, e.g. http://localhost:5173/login. Omit for the running dev server's address",
  previewPath: "Path relative to the address, e.g. /settings",
  previewWidth: "Window width in pixels (default 1280)",
  previewHeight: "Window height in pixels (default 800)",
  previewScreenshotDescription:
    "Loads the project's running web app in a hidden browser and returns a screenshot as an image, plus title, address, HTTP status and a count of console messages. Only addresses on this machine (localhost, 127.0.0.1, ::1).",
  previewFullPage: "true: whole page instead of only the visible area",
  previewConsoleDescription:
    "Console messages (error, warn, log), unhandled exceptions and failed network requests (status 400 and up or aborted) of the web app. Without url and path the page opened last, otherwise it is loaded.",
  previewReload: "true: reload the page instead of reading the messages so far",
  previewInteractDescription:
    "Runs steps on the page (without url and path on the one opened last): click (CSS selector), type (selector and text; clear replaces the content), press (key such as Enter, Tab, Escape, ArrowDown, Control+a), wait (ms or selector). Stops at the first error and then returns a screenshot.",
  previewSelector:
    'CSS selector (click, type, wait); also text=Sign in, button:has-text("Save"), xpath=//button and an appended >> nth=1',
  previewText: "Text for type",
  previewClear: "type: replace existing content",
  previewKey: "Key for press",
  previewMs: "wait: wait time, with selector the time limit",
  previewStepTimeout: "Time limit per step for finding an element (default 5000)",
  previewNoScreenshot: "false: no screenshot at the end",
  status: {
    starting: "starting",
    running: "working",
    waiting_approval: "waiting for the user's approval",
    stopping: "stopping",
    idle: "done, waiting for instructions",
    stopped: "ended",
    interrupted: "interrupted",
    error: "ended with an error",
  },
  projectToolsUnavailable: (error) => `Project knowledge and dev tools unavailable: ${error}`,
  notifyDescription:
    "Notifies the user in FORGE (notice with sound). urgent=true only when they are really needed right away: then FORGE calls them, if the phone is set up.",
  notifyMessage: "Short message to the user, one or two sentences",
  notifyUrgent: "true: urgent, may call",
  notifiedUrgent: "The user was notified urgently.",
  notified: "The user was notified.",
  usageStatusDescription:
    "Usage of the user's Claude subscription: 5-hour and weekly window in percent with reset time, the forecast at the current pace (limit reached before the reset or lasts until the reset) and whether a limit is reached. Check before big efforts (several agents, long runs) so the work doesn't stop at the limit.",
  dailyReportDescription:
    "FORGE daily report: sessions with runs, parallel agents (started, merged, discarded, waiting), commits (auto-commits marked), what is open right now (questions, approvals, errors, planned continuation after the usage limit), for all projects also phone calls. For questions like \"What happened today?\" or \"What did the agents get done yesterday?\".",
  dailyReportDate: "Day in the format YYYY-MM-DD; omit for today",
  dailyReportAllProjects: "true: all projects; otherwise only this project with its agents",
  usageLine: "- usage_status: subscription usage and limits; check before big efforts (several agents, long runs).",
  dailyReportLine: "- daily_report: what happened on a day (sessions, agents, commits, open items); for reviews and \"What happened today?\".",
  introNoGit: "You are running in FORGE, a desktop interface for Claude Code. Besides your own tools there are FORGE tools (mcp__forge__…).",
  noGit: (cwd) =>
    `This project deliberately works without Git: the user turned off Git for ${cwd} in FORGE. Don't run any git commands (no git init, status, add, commit, branch, checkout, push), don't create a repository and don't suggest commits, branches or pull requests. An existing .git folder stays untouched too. Changes only end up as files in the folder; if something has to be undone, that only works through the files themselves.`,
  noGitAgents: "That's why parallel agents (start_agent) are not available here.",
  notifyLine: "- notify: actively notify the user. urgent=true only when they are needed right away (can make their phone ring).",
  autoMergeLine:
    "In this project FORGE merges your branch automatically as soon as a run ends without errors. So ask questions only with AskUserQuestion, never as a question at the end of your answer. Only end a run once the work is done.",
  autoCommitLine: (autoPush) =>
    `In this project FORGE itself commits the files changed in each successful run (tag auto-commit${autoPush ? ", then push except to main/master (auto-push)" : ""}). FORGE names these commits with your next message. If something should be committed or pushed, that has usually happened already: check with git status and git log, commit only what is still open, and then push.`,
  testLine: (testCommand) =>
    `Run tests selectively: only those matching your changes (single test files, affected packages), not the whole suite after every small step, not again without changes since the last green run.${
      testCommand
        ? ` After each run FORGE itself runs "${testCommand}" when relevant files have changed (tag auto-test), and reports failures with your next message. So you don't need to start the whole suite yourself.`
        : ""
    }`,
  introAgent: "You are running in FORGE, a desktop interface for Claude Code, as a parallel agent: another FORGE session started you.",
  agentWorktree: (cwd) => `You are working in the Git worktree ${cwd} on your own branch. Only change files in this folder.`,
  agentFinish:
    "When you are done: commit your work on your branch and at the end summarize in a few sentences what you did and what is still open. The starting session reads this summary.",
  agentNotify: "You can notify the user with mcp__forge__notify. You cannot start further agents.",
  agentNotFound: (ref, known) => `No agent "${ref}" found. Available: ${known}.`,
  noOwnAgents: "This session has not started any agents.",
  agentNoWorktree: (id) => `Agent ${id} has no worktree anymore, it is already finished.`,
  noAgentsInProject: "There are no agents in this project.",
  startAgentDescription:
    "Starts a parallel agent (its own Claude Code session) in a new Git worktree on its own branch. For independent subtasks that can run at the same time. The agent doesn't see this chat: the task must be understandable on its own. Its branch starts at the last commit of your current branch. It only sees uncommitted changes with with_changes=true: then its branch starts with a commit of that state (without .env, keys and build output); your folder stays unchanged.",
  startAgentTask: "Complete task with all the context needed",
  startAgentName: "Short name for the branch, e.g. csv-export",
  startAgentWithChanges: "true: the agent also gets the uncommitted state of your folder",
  startAgentWithChangesNote: " It has your uncommitted state as the first commit of its branch.",
  startAgentOpenNote: (open) =>
    ` Note: ${open} ${open === 1 ? "file is" : "files are"} uncommitted on your side, it doesn't see ${open === 1 ? "it" : "them"} (with_changes=true would have passed ${open === 1 ? "it" : "them"} along).`,
  startAgentWarning: (warning) => ` Note: ${warning}`,
  agentStarted: (id, branch, dir) =>
    `Agent ${id} started, branch ${branch}, folder ${dir}. It works independently; agent_status gives its state. Its changes are only on its branch.`,
  agentStatusDescription:
    "State of the agents this session started: status, branch and their last answer. Without agent also the project's other agents (from the Agents tab, the phone or other sessions).",
  agentStatusAgent: "Short ID of an agent; omit for all",
  otherAgentLine: (branch, status, dir, exists) => `- ${branch}: ${status ?? "no session"}, folder ${dir}${exists ? "" : " (missing)"}`,
  otherAgentsBlock: (lines) => `Other agents of this project (finish_agent with the branch):\n${lines}`,
  agentDeleted: (id) => `${id}: deleted`,
  agentLine: (id, title, status, branch, dir) => `${id} (${title ?? "untitled"}): ${status}, branch ${branch ?? "unknown"}, folder ${dir}`,
  agentLastAnswer: (text) => `  Last answer: ${text}`,
  messageAgentDescription: "Sends an agent of this session a further instruction; it then continues working.",
  messageAgentAgent: "Short ID of the agent",
  messageAgentText: "Instruction, fully written out",
  messageSent: (id) => `Sent to agent ${id}.`,
  finishAgentDescription:
    "Finishes an agent of this project, also one this session didn't start. merge: takes its branch into the branch it branched off from (rebase, then fast-forward). discard: discards its work. Afterwards its session is ended and the worktree folder, FORGE entry and branch are deleted. Only after checking with the user. On conflicts in the rebase the agent resolves them itself; then merge again.",
  finishAgentAgent: "Short ID of one of your agents or branch of another agent of the project (as agent_status names them)",
  intro: "You are running in FORGE, a desktop interface for Claude Code. Besides your own tools there are FORGE tools (mcp__forge__…):",
  startAgentLine:
    "- start_agent: starts a parallel agent in its own Git worktree on its own branch. Only for subtasks that are truly independent and can run at the same time; the task must be understandable on its own. The agent starts at the last commit of your branch; it only gets your uncommitted state with with_changes=true.",
  agentStatusLine: "- agent_status and message_agent: track and guide agents. Their work is on their branches.",
  finishAgentLine: (autoMerge) =>
    `- finish_agent: merge (merge) or discard (discard) an agent of the project, also someone else's; afterwards session, worktree, FORGE entry and branch are gone. Only after checking with the user. ${
      autoMerge
        ? "In this project FORGE merges finished agents automatically (auto-merge) as soon as their run ends without errors. Whatever doesn't work out, FORGE presents to the user."
        : "FORGE also shows finished agents to the user for a decision on its own."
    }`,
};

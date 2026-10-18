<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0009-rueckfragen-kontext-suche-devserver.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0009: Questions and plan approval, context display, command palette, full-text search, dev server

Date: 2026-10-11 · Status: accepted

## Questions (AskUserQuestion) and plan approval (ExitPlanMode)

Findings (spike with Claude Code 2.1.296, Agent SDK 0.3.296):

- Both tools go through `canUseTool`, **even in `bypassPermissions`**. The SDK warning
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` does not apply to these interactive tools.
- `AskUserQuestion` expects the answers in `updatedInput.answers` (question text → answer, multiple choice
  separated by comma). Until now FORGE returned `toolInput` unchanged: Claude got no answer.
- `ExitPlanMode` provides `plan` and `planFilePath` in the input. An `allow` with
  `updatedPermissions: [{ type: "setMode", mode, destination: "session" }]` leaves plan mode; the CLI
  reports the new mode as `system/status` with `permissionMode`.
- In plan mode, Claude writes the plan to `~/.claude/plans/*.md`. The rule `write-outside-project`
  (Autonomous) blocked that.

Decision:

- `ApprovalDecision` optionally carries `updatedInput` and `mode`; `canUseTool` passes both through.
- `sessions.respondApproval` takes `answers`. For `AskUserQuestion` at least one answer is required,
  "Skip" is a `deny` with a clear message. For `ExitPlanMode`, "Accept plan" sets the mode of the
  project profile, "Revise" is a `deny` with the feedback as message (Claude stays in plan mode).
- There is no "for this Session" approval for either tool.
- `approval.resolved` stores the answers so the card shows them after a restart.
- FORGE takes `permissionMode` from `system/status` so that display and database follow the CLI.
- The blocklist allows writes in `claudePlansDir()` (`$CLAUDE_CONFIG_DIR/plans` or
  `~/.claude/plans`), and nothing else outside the project.

UI: dedicated cards in the chat (`InteractiveCards.tsx`) instead of the generic approval card; notification
"Rückfrage von Claude" or "Plan zur Freigabe".

## Context display and compacting

- After every `turn.result` and after a compaction, FORGE queries `getContextUsage({ detail: "summary" })`.
  This uses the values of the last response and local estimates, without additional token counts.
- The value is attached to the `Session` object (`context`) only while the process is running, and is not saved.
- The "Compact" button sends `/compact` as a normal message (confirmed in the E2E test).
  `system/compact_boundary` becomes `context.compacted` and appears as a notice in the history.
- Warning levels: yellow from 70 %, red from 90 %. FORGE never compacts on its own; Claude Code does that when needed.

## Full-text search

- SQLite FTS5 (`events_fts`, tokenizer `unicode61 remove_diacritics 2`), `rowid` = `events.rowid`. Triggers
  keep the index current, also when a Session is deleted (cascade). Migration 6 fills the index from the
  existing data.
- Only `user.message` and `assistant.text` are indexed, i.e. what appears as text in the history. Tool inputs
  and outputs are not; they are large and usually not what is meant.
- The search query is reduced to words (`"wort"*`, all must occur). FTS syntax in the input
  therefore has no effect.
- A hit opens the Session and scrolls to the message (`focusEvent` in the UI store).

## Command palette

Ctrl+K everywhere except in the terminal (there the key belongs to the shell). Actions depending on the open project,
projects, Sessions and, from three characters on, the full-text hits. No new package: Radix dialog and a custom list.

## Dev server

- Command per project (`projects.dev_command`), otherwise detected from `package.json` (`dev`, otherwise `start`).
  With npm this becomes `npm run dev`, because npm does not run scripts other than `start`/`test` directly.
- Runs in a shell like the test command (the command comes from the user or from their own project).
  `BROWSER=none`, so that no dev server opens a browser by itself.
- Stopping ends the whole process tree with `taskkill /T /F`. When FORGE exits
  and when a project is removed, running dev servers are stopped.
- The first local address in the output (ANSI stripped, `0.0.0.0` becomes `localhost`) is shown as a link.
  For this, the opener may additionally open `http://localhost:*` and `http://127.0.0.1:*`.
- "An Claude" puts the last 80 lines as a code block into the draft of the active Session. It is only sent
  when the user does so.

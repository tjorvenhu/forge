<img src="../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="ARCHITECTURE.de.md"><img src="../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# FORGE Architecture

```
┌──────────────────────────────── Tauri window (WebView2) ────────────────────────────────────┐
│  React UI (apps/desktop/src)                                                                  │
│   Zustand (UI state, event buffer) · TanStack Query (RPC cache) · Radix/Tailwind primitives   │
│        │ invoke("sidecar_send", line)                     ▲ event "sidecar://message"        │
└────────┼──────────────────────────────────────────────────┼──────────────────────────────────┘
         ▼                                                  │
┌──────── Rust shell (apps/desktop/src-tauri) ──────────────┼──────────────────────────────────┐
│  sidecar.rs: starts node, writes stdin, reads stdout      │   Plugins: dialog (folder),        │
│  no shell/FS/HTTP permissions for the webview             │   opener (https, localhost)        │
└────────┼──────────────────────────────────────────────────┼──────────────────────────────────┘
         ▼ stdin (JSON Lines)                               │ stdout (JSON Lines)
┌──────── Node sidecar (packages/sidecar) ────────────────────────────────────────────────────┐
│  rpc/server.ts      Zod validation of all parameters (packages/protocol)                      │
│  sessions/          SessionService: state machine, approvals, persistence, redaction          │
│  claude/            ClaudeRuntime interface, AgentSdkRuntime, normalizer, diagnostics         │
│  policy/            profiles, hard blocklist (PreToolUse), secret redactor                    │
│  git/               GitEngine (git CLI, argument arrays), parsers                              │
│  projects/          ProjectManager, technology detection, templates                           │
│  persistence/       SQLite (node:sqlite), migrations                                          │
└────────┬───────────────────────────────┬────────────────────────────────────────────────────┘
         ▼                               ▼
   Claude Code CLI (installed,        git / gh
   own login in ~/.claude)
```

## Modules and responsibilities

| Module | Path | Responsibility |
|---|---|---|
| desktop-shell | `apps/desktop/src-tauri` | Window, folder dialog, sidecar lifecycle |
| UI | `apps/desktop/src` | Screens, components, stores |
| protocol | `packages/protocol` | RPC methods, events, models, error codes (Zod) |
| claude-runtime | `packages/sidecar/src/claude` | Adapter to the Agent SDK, normalization of stream events |
| session-service | `packages/sidecar/src/sessions` | Start/resume/stop sessions, approvals, persistence. `session-service` is only the facade (public API, wiring). Split into `session-core` (live sessions, events, status), `lifecycle` (start, resume, stop, close, delete, shutdown), `turns` (send messages, hold them back until the automation is done), `stream` (CLI output to timeline, status, context, background tasks), `approvals` (policy hook, approval requests, audit), `permission-mode` (limit the mode to the profile, profile switch), `runtime-catalog` (capabilities, models, commands, plan usage), `live-session`, `remote-bridge` (Remote Control), `turn-automation` (tests, auto-commit, auto-push after a turn), `titles` (session titles from the latest prompts) and `claude-assist` (commit message, PR text, summary, title) |
| project-manager | `packages/sidecar/src/projects` | Import, creation, cloning, metadata |
| git-engine | `packages/sidecar/src/git` | Status, diff, stage, commit, branches |
| security/policy | `packages/sidecar/src/policy` | Profiles, blocklist, redaction |
| persistence | `packages/sidecar/src/persistence` | SQLite schema, repositories |

## ClaudeRuntime interface

The required operations were `startSession, sendMessage, streamEvents, approveOrDenyTool, stopSession, resumeSession,
listSessions, capabilities`. Implementation in `claude/runtime.ts`:

| Required | Implementation |
|---|---|
| startSession | `ClaudeRuntime.startSession(opts, sink)` |
| sendMessage | `RuntimeSession.sendMessage(text)` |
| streamEvents | Push via `SessionSink.onMessage` → `Normalizer` → `session.event` to the UI |
| approveOrDenyTool | `SessionSink.onApproval` returns a promise; `SessionService.respondApproval` resolves it |
| stopSession | `RuntimeSession.interrupt()` (stop the turn) and `close()` (end the process) |
| resumeSession | `ClaudeRuntime.startSession({ resume: claudeSessionId, … }, sink)` |
| listSessions | `ClaudeRuntime.listSessions(dir)` (including sessions started in the terminal) |
| capabilities | `ClaudeRuntime.capabilities(init, cliCapabilities)` |

## Session state machine

```
starting ─► running ◄──► waiting_approval
              │  ▲
   turn.result│  │send
              ▼  │
             idle
              │
           close / process exit ─► stopped
           crash / auth error ─► error
   running / waiting_approval ──stop──► stopping ─► idle (turn aborted, session stays alive)
   app exit or restart: open sessions ─► interrupted ─(resume)─► starting
```

Stop on an idle session does nothing. Starting and resuming a session run one after the other; a
second resume or send waits for the process started by the first. When the app exits, the sidecar
waits up to 5 seconds for follow-up work (tests, auto-commit) and the phone, then sets open sessions
to `interrupted`.

Each session stores its `cwd` at start. Resume always uses this `cwd`, even if the project was
moved. Events are stored in SQLite with `seq`, timestamp, type and session ID; token deltas are only
sent live, never stored. `sessions.events` returns the latest 2,000 events in ascending order, older
ones via the `beforeSeq` parameter. One-off CLI calls (check, command list, commit message, usage)
time out after 45 seconds.

### Usage limit and automatic continue

`sessions/auto-continue.ts`. A turn counts as stopped by the limit if its `turn.result` is an error
(not a stop by the user) and either a `rate_limit_event` with `status: "rejected"` arrived in the same
turn (without `isUsingOverage`/`overageInUse`) or the result text is a limit message ("You've hit your …",
older CLI "Claude AI usage limit reached|<unix>"). The reset time comes, in this order, from
`rate_limit_info.resetsAt`, the plan usage (`system.usage`, the window of the reported limit or the
latest full one) and the text of the message. If it is unknown, FORGE queries the plan usage every
15 minutes, at most 20 times, then makes one attempt.

The schedule lives in the `auto_continue` table (due at, reset, last event number at the limit,
number of attempts). Every 30 seconds (the first time 10 seconds after start) the sidecar compares the
clock with the due schedules. There is no long timer that would stall during standby: after waking
up, a schedule is overdue and runs at the next check. Due means: check the session (if there has been a
user message or another result since the limit, or a turn is currently running, the schedule is
dropped), then send `AUTO_CONTINUE_PROMPT` through the normal resume path, as a `user.message` with
`source: "auto"`. Any user message (FORGE, phone, Claude app), `sessions.stop`,
`sessions.cancelAutoContinue`, deleting the session and the `autoContinueAfterLimit` setting cancel
the schedule. Without user input, FORGE continues automatically at most three times in a row.
The timeline shows this through `auto_continue` events (`scheduled`, `resumed`, `cancelled`, `exhausted`,
`failed`); `Session.autoContinueAt` holds the scheduled time.

Separately, `sessions/rate-limit.ts` remembers the account's most recently reported limit state
(`system.rateLimit`, event `ratelimit.updated`): `warning` on `allowed_warning`, `reached` on
`rejected`. A later `allowed` message or the passing of `resetsAt` resets it. The composer shows it
permanently; warnings no longer appear in the chat.

### Session titles

At start, the title is the first line of the first prompt. After that, `sessions/titles.ts` keeps it
in line with the latest prompts. Every user message from FORGE, the phone or the Claude app triggers
an update. These do not count: automatic messages (`source: "auto"`), slash commands, messages under
12 characters and pure filler replies ("ok", "yes, go on", "thanks, looks good"; German fillers are
recognized too). Per session, FORGE waits 2 seconds for further messages, renews at most once per
minute (the newest waiting message wins) and never twice at the same time.

The input is the last three counting prompts from the timeline, newest first, each cut to 300
characters. The title comes, in this order, from `RuntimeSession.generateTitle` (control request
`generate_session_title` of the running process, with `persist: false`), from `ClaudeAssist.sessionTitle`
(one-off call with Haiku) and finally from `titleFrom` of the newest prompt. Each source gets 45 seconds.
The answer is cleaned up (one line, without quotation marks and trailing punctuation, at most 80
characters); an unchanged title is not written.

A new title goes into the database and via `session.updated` to the tabs and the session list. If a
process is running, `RuntimeSession.rename` sets it in Claude Code via `rename_session` (with
`source: "host"` and the Claude session ID). If the session is connected to Remote Control, the entry
is named `FORGE · <project>: <title>`; the entry in the remote dialog and the `rename_session` get the
same name. Without a process, `ClaudeRuntime.renameTranscript` (SDK `renameSession`) writes the
title into the transcript. `generateSessionTitle` and `renameSession` on the query are not in the
SDK types and are checked before use. Errors have no effect; the old title stays.

## Processes and cleanup

- **Job Object:** Every sidecar start runs in its own Job Object with `KILL_ON_JOB_CLOSE`. Exiting,
  restarting or crashing FORGE therefore also ends all child processes (Claude, dev servers, tests).
  Every terminal tab has its own Job Object (`src-tauri/src/job.rs`): closing the tab, exiting the
  shell or exiting FORGE also ends everything started in it, such as `pnpm dev`.
- **Timeouts:** A timeout ends the whole process tree (`taskkill /T /F`).
  On exit, Rust waits 7 seconds for the sidecar; this must stay above the sidecar's own limit of
  5 seconds (`SHUTDOWN_GRACE` in `sidecar.rs`, `SHUTDOWN_LIMIT_MS` in `app.ts`).

## Data storage

- `%APPDATA%\forge\forge.db`, can be overridden with `FORGE_DATA_DIR`.
- Tables: `projects`, `sessions`, `events`, `approvals` (audit), `settings`, `auto_continue`
  (scheduled continue after a usage limit, deleted together with the session).
- FORGE writes Claude's own data (`~/.claude`, `.claude/settings.json`, `CLAUDE.md`) only on click:
  CLAUDE.md files, skills, subagents and the `hooks` key in `settings.json`. Writes are atomic,
  create a `.bak` and detect concurrent changes. Deleted skills move to
  `<data folder>/trash/skills/`.

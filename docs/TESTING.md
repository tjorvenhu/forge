<img src="../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="TESTING.de.md"><img src="../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# Tests and results

Last full run: 2026-10-12, Windows 11 Pro 26200, Node 24.11, Claude Code with Max login (E2E with Haiku).

| Suite | Command | Result |
|---|---|---|
| Lint | `pnpm lint` | no findings |
| Typecheck (protocol, sidecar, desktop) | `pnpm typecheck` | no errors |
| Sidecar unit/integration | `pnpm --filter @forge/sidecar test` | 386 / 388 passed; the 2 failures also occur without the changes from 2026-10-12 (a deleted file briefly stays visible on Windows) |
| Desktop unit/components | `pnpm --filter @forge/desktop test` | 139 / 139 passed |
| E2E with a real Claude session | `pnpm test:e2e` (under PowerShell 5.1: build and `npx vitest run test/e2e` separately) | 17 / 17 passed |
| Release app without Node/Git/gh in PATH | manual | Sidecar runs from `runtime/node`, diagnostics show "mitgeliefert" (bundled) |
| Rust shell | `cargo build` | no warnings |
| Gemini Live and Gemini voice against the real service | `scripts/gemini-live-smoke.ts`, `scripts/gemini-voice-smoke.ts` | passed (2026-10-12) |
| Structured answer with the real CLI | `scripts/structured-smoke.ts` | passed (Haiku, 4 s) |
| Rust shell with bundled lines | `cargo build` | no errors |

## What the suites cover

**Unit/integration (sidecar)**
- `git-parsers.test.ts`: porcelain v2 status (renames, conflicts, spaces, umlauts, detached HEAD), unified diff parser, log, branches, secret/artifact detection, clone URL validation (`ext::`, `--upload-pack`, `file://` rejected).
- `policy.test.ts`: blocklist (force push, push to main, reset --hard, delete branch, rm -rf /, sensitive paths), profiles, sandbox-only blocks Autonomous, redaction.
- `project-git.test.ts`: import/canonicalization/duplicates (including case differences on Windows), persistence across a DB restart, creating a project with templates, missing folder, real Git repos: diff, commit of only the selected files, secret stop, conflict stop, first commit.
- `normalize.test.ts`: normalizer against a recorded real `stream-json` output (fixture), robustness against broken/unknown events.
- `session-service.test.ts`: session lifecycle with a simulated runtime: profile modes, approvals + audit, blocklist, stop, crash and resume, error display, redaction; sessions across an update restart (reopened, working ones with an automatic message, aborted installation, old markers, second update step).
- `usage-commit.test.ts`: conversion of usage data, prompt and cleanup of the AI commit message.
- `setup-tools.test.ts`: reading the login URL from real CLI output, precedence of the bundled tools, PATH for sessions.

- `claude-config.test.ts`: CLAUDE.md global/project/local with conflict detection, .bak, git exclude; create, list and delete skills/subagents; check hooks and replace only that key; parse MCP output and build arguments.
- `worktrees.test.ts`: create/remove worktrees (real Git), branch slugs.
- `git-sync.test.ts`: push and pull against a bare remote: rebase of own commits with autostash, fast-forward, aborted rebase on conflict (repo unchanged, files named), protection of main against any change, new branch; handlers start a Claude session on conflict.
- `plugins.test.ts`: merging the output of `claude plugin list --available --json` (installed first, missing ones added).
- `removal.test.ts`: reading the GitHub repo from the remote, blocked folders (drive, home, standard folders, FORGE data, nested projects), deleting the folder (including read-only Git objects) and the repo with a simulated gh. Removing an agent's worktree while a process runs in the folder (the session is ended first; a locked folder gives a clear message, the rest is removed on the next attempt).
- `session-service.test.ts` (Remote): bridge for open sessions, echo of own messages without duplicates, a message from the phone starts a turn and appears marked in the history. Remote is global: turning it on without a running session starts nothing, N running sessions from several projects get N entries with unique names, started and resumed sessions are connected automatically, ended and deleted ones drop out, turning it off disconnects all, turning it on again reconnects failed ones.
- `session-service.test.ts` (extended): auto-test + auto-commit only with the files of the turn, no commit on failing tests.
- `project-git.test.ts` (extended): push/pull against a local bare remote (main protection, fast-forward, divergence).

- `session-service.test.ts` (phase 4): answers to questions as `updatedInput.answers`, skipping, accepting a plan sets the profile mode, feedback keeps plan mode, mode sync from `system/status`, context state after the turn, compaction in the history.
- `policy.test.ts` (phase 4): plan file in `~/.claude/plans` allowed, everything else outside still blocked (also via `..`).
- `search-devserver.test.ts`: full-text search (prefix, case, umlauts, FTS syntax has no effect, hits disappear with the session); dev server detection (including `npm run dev`), address detection from typical output, start/stop with a real process, crash with exit code.

- `phone-units.test.ts`: SIP parser (compact forms, continuation lines, header lists), responses, digest against the RFC 2617 example, SDP, G.711 against reference values, downsampling without aliasing, WAV, speech pause detection (including a higher threshold while FORGE speaks), RTP with clock, silence and DTMF, number matching, speakable text, DPAPI storage with special characters.
- `phone-live.test.ts` (ADR 0011): tool schemas for Gemini and argument checks, Gemini Live client with a fake WebSocket (setup, 8↔16/24 kHz, function calls, goAway with resumption, rejected key), call flow with Gemini (greeting, audio before pickup, tools, withdrawn calls, interruption, hangup, PIN, outage), Gemini voice via SSE, desk phone (provisioning, LEDs, digest on the phone, token and IP check, key starts a call, approval menu, key during a call).
- Against real services (requires `GEMINI_API_KEY`): `pnpm --filter @forge/sidecar exec tsx scripts/gemini-live-smoke.ts` (connection, function call, German answer with voice) and `scripts/gemini-voice-smoke.ts` (speech output and recognition).
- `phone-call.test.ts`: test PBX over real UDP: registration with digest and NAT detection, wrong password, dialing with digits only and CANCEL while ringing; PhoneService end to end: unknown number rejected, allowed call with greeting, audio in both directions, recognition through to Claude, blocked control, wrong and correct PIN via DTMF, hangup by the remote party, log with transcript; callback after a finished session with proxy auth, speech only after pickup, PCMU, hangup by FORGE.

**Desktop**
- `chat-items.test.ts`: building chat items from events, streaming buffer, store merge.
- `title-tooltips.test.tsx`: custom tooltip instead of the native `title`, restoring the attribute, closing on click.
- `chat-items.test.ts` (phase 4): jump to the message of a search hit, notice on compaction, short texts for questions and plans.
- `InteractiveCards.test.ts`: robust reading of questions, composing answers (single/multiple choice, custom answer), warning levels of the context indicator.
- `AgentsTab.test.tsx`: worktrees of the open project only, removing one ends the worktree's terminals and leaves it if it was open, confirmation when there are changes.
- `SessionTabs.test.tsx`: session tabs at the top of the window: hidden without sessions, groups per project in a stable order, active session marked only in the workspace, open session without a process as the last tab of its group, click opens project and session, ending only without running work, arrow keys across groups.
- `shortcuts.test.tsx` (extended): `Ctrl+Tab` in the order of the tab bar.
- `GitPanel.test.tsx`: commit flow in the component (selection, review dialog, exact RPC call) and AI suggestion.

**E2E (`real-claude.e2e.test.ts`)**, real sidecar process + installed CLI + real Git:
1. Diagnostics: CLI found, logged in (claude.ai, max), no API key; real subscription usage available
2. Project import with spaces/umlauts in the path
3. Start a session, real token deltas, tool events, file written (Balanced)
4. Git status and diff, AI commit suggestion, commit
5. Safe: approval request, denial, command not executed
6. Autonomous (bypassPermissions): blocklist blocks `git branch -D` via PreToolUse hook
7. Stop in the middle of streaming, session stays usable
8. Image attachment: Claude recognizes the color of a generated PNG
9. File checkpoint: file created by Claude removed via rewind
10. Session summary from the history
11. Slash commands (68 in the test)
12. Sidecar crash (SIGKILL), restart, session detected as interrupted, resume with context
13. Question in the Autonomous profile answered, Claude names the chosen answer; context state reported; `/compact` produces `context.compacted`
14. Plan mode in the Autonomous profile: plan file not blocked, plan accepted, mode switches to `bypassPermissions`, file created

15. Phone: Claude (Haiku) uses the status tool, answers in at most three short German sentences without Markdown, turns on Remote Control on request without asking back and hangs up by itself on "Tschüss" (bye)

(Further E2E cases since phase 2: profile switch during a turn, background tasks; restart for an update in the middle of a
tool call, the session then continues by itself and creates the file from step 2.)

Not tested: a real PBX and real OpenAI voice services (no credentials in the test run).

## Manual UI smoke test: phone (2026-10-11)

Isolated dev build against a mini PBX on 127.0.0.1: phone button at the top right (registered, menu),
settings with status and stored secrets, test call with the "klingelt" (ringing) indicator and hangup. Found
and fixed: hanging up while ringing waited up to 32 s for the response to the CANCEL; numbers with spaces were
dialed URL-encoded; status indicator "Gespräch läuft" (call in progress) already while ringing. Observed: Windows Firewall asks
for access for Node.js on the first call (note added to the settings).

## Manual UI smoke test: phase 4 (2026-10-11)

Dev build with its own `FORGE_DATA_DIR` and `WEBVIEW2_USER_DATA_FOLDER` (the installed FORGE ran in parallel
untouched), test data via script: search field in the sidebar, Ctrl+K with sessions and full-text hits,
jump to the message with highlighting, question card opened and answered, plan card, compaction notice,
dev server started from the header and the panel (HTTP response checked), "An Claude" (to Claude) fills the draft, stopping
ends the process tree (port free). Found and fixed: without a lockfile, `npm dev` was detected instead of `npm run dev`.
Not checked in the window: the context indicator (needs a running session; covered in the E2E test).

## Manual UI smoke test (Windows, via UI Automation)

Performed in the running desktop app (`pnpm tauri dev`):
open a project, view a file diff, select two files, commit message, review dialog, commit
(confirmed with `git log`); start a new session and send a prompt; profile set to Safe, approval card appears,
Allow, file created; app restart opens the last project; force-closing the window leaves
no Node processes behind.

Bugs found and fixed: the header did not update after a commit; absolute paths in
tool cards; Radix Select changed the session model without user action while loading the model list;
missing error boundary; the warning about parallel sessions also counted idle sessions.

## Second UI pass (Windows)

Usage bar in the status card, GitHub login up to the code display (aborted; only the user can complete it), AI commit message via the spark button, compact message bubble, plain profile button, built app with a cleaned PATH.

## Third UI pass (Windows)

Extensions with a real MCP server, terminal tab (PowerShell in the project), remote control (detection of "Ordner nicht freigegeben" (folder not shared), Claude trust prompt in the embedded terminal), real feature workflow through the UI (worktree, implementation with two approvals in the Safe profile, commit on the feature branch). Bugs found and fixed: blank page caused by freezePrototype; the workflow did not show that Claude was waiting for an approval; MCP status in English; test flake caused by background work during cleanup.

## Fourth UI pass (Windows, dev build with its own data folder)

Remote Control for real: turning it on without an open session opens an empty session, bridge connected, QR code and link; message from FORGE without a duplicate in the history; turning it off. Deleting a project: dialog with folder and GitHub repo, request for the delete_repo permission visible (not executed), real deletion of the folder including an open session. All views checked for line breaks and placement. Bugs found and fixed: empty model selection for a new remote session, "1 Schritte" (wrong plural), title stayed "Remote-Session", tag descriptions not aligned, path broke in the middle of a word, badge "Remote" (Git remote) easy to confuse, double spinner in loading buttons, sound description squeezed, "max Abo", outdated texts ("folgen in Phase 2", "coming in phase 2"), Git tab without a repository showed branches/history and hung in a loading loop after the first fix.

## Not tested

- Sounds: I cannot hear playback; the code path is type-checked, test buttons under Settings
- Installer on a fresh system without Claude Code
- Claude Code installation from the app (would change the existing installation)
- Remote Control with the real Claude app: bridge connection and session link checked with the real SDK and in the app, messages from the phone only simulated
- Custom tooltips in the window: mouse movement via automation did not reach the window; logic checked by component test
- Push/PR against GitHub with a real account (gh not logged in); logic tested against a local bare remote
- Claude login to the end (URL output checked in an isolated config folder) and GitHub login to the end

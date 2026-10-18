<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0012-fluessige-oberflaeche-und-agent-sdk.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0012: Smooth UI, Agent SDK further extended

Date: 2026-10-12 · Status: accepted

## UI: performance

Starting point: every streamed token triggered its own React commit, re-rendered the whole chat including the composer
and forced a layout via auto-scrolling. Every window switch reloaded all visible lists (Git status of all
projects, transcript scan); meanwhile the sidecar stalled and text arrived in bursts.

- **Rust shell:** one read thread and one send thread. Whatever has piled up goes to the webview as one event `sidecar://messages`
  (list of lines, at most 256). A single line goes out immediately; nothing waits for a batch.
- **Session store:** text deltas are collected and written once per frame (`requestAnimationFrame`). Every
  other event first writes the pending deltas, so the final text is not overwritten by later deltas.
  `markAllStale` and `drop` discard pending deltas.
- **Chat:** composer and indicators are memoized. Auto-scroll via ResizeObserver instead of `scrollHeight` on every
  render. Scroll position and measured row heights are kept per Session (`initialMeasurementsCache`,
  `initialOffset`). Chat items are built incrementally (`IncrementalItems`): new events only cost their
  own work; if the beginning changes (older pages), everything is rebuilt.
- **Markdown while streaming:** split into blocks at blank lines (code fences stay whole), only the last block is
  re-parsed; interval 50 ms instead of 100 ms. Finished messages as a whole.
- **Tool cards:** diff and JSON of the input cached per input object (WeakMap).
- **Queries:** default without refetch on focus, 30 s fresh. Git status (5 s), project list and Session lists
  (60 s each) refetch on focus, because they change outside FORGE. `session.updated` patches the project's list
  and the list of running Sessions instead of reloading them. The sidecar keeps the transcript scan per folder
  for 20 s (cleared when a Session is deleted).
- **History:** `sessions.events` returns 2,000 instead of 20,000 events per page (`HISTORY_PAGE_LIMIT`); internal calls
  (summary) still read up to 20,000.
- **Startup:** Sessions, settings, GitHub and extensions load on demand and are preloaded while idle after
  startup. CodeMirror, xterm and qrcode are separate chunks. Startup bundle from 2,012 kB down to about 990 kB.

## UI: motion and feedback

Before, there was hardly any motion: dialogs, menus, toasts, views and collapsible sections appeared in a single frame,
clicks waited for the sidecar before anything happened.

- **Foundations** (`styles.css`, `lib/motion.ts`): duration and easing tokens, keyframes; only `opacity`
  and `transform` are animated (expanding via `grid-template-rows`). `prefers-reduced-motion` turns everything off globally.
  No additional library.
- **Fade in and out:** dialogs, command palette, menus, select, tooltips (Radix `data-state`), toasts (paused
  on hover). Views, tabs, Sessions and the right column fade in on switch, never out: a switch
  does not wait. Tab bar with sliding indicator, bold active tabs without neighbors jumping.
- **Immediate feedback:** your own message appears immediately (`stores/pending-messages.ts`, replaced by the real
  event, returned to the input field on error). Approvals, model, effort, plan mode, stop, favorite and profile show
  the new state on click and revert on errors. Pressed state on buttons and tabs.
- **Loading:** skeletons in the shape of the content instead of spinners; folders in the file tree preload on hover.
- **Chat:** new rows slide in once (not when loading the history, not when scrolling back,
  `lib/arrivals.ts`); "Zum Ende" above the input field as soon as you have scrolled up. Collapsible content is only
  rendered when opened.
- **Appearance:** window color of the shell matches the app (no color flash on startup), consistent focus,
  subtle scrollbars.

## Agent SDK

- **Fork** (`sessions.fork`): new Session with the history up to before one of your own messages
  (`forkSession(…, { upToMessageId })`, the fork point is the transcript entry before the message). FORGE copies the
  events before it, the input field of the branch is prefilled with the message, the original remains. On request, the
  files are reset first (forks have no file checkpoints). Before the first message: new Session.
  Rejected: `resumeSessionAt` on the same Session; that changes the history the user is currently looking at.
- **FORGE tools in every Session** (in-process MCP server `forge`, `sessions/forge-tools.ts`): `start_agent`
  (parallel agent in a new worktree, as in the "Agenten" tab), `agent_status`, `message_agent`, `notify`
  (notice in FORGE, with `urgent` also a call). `agent_status` and `notify` are allowed without asking, the others
  go through the normal approvals and the blocklist. Agents only get `notify`: one level, no chains;
  at most 4 running agents per Session. The agent → Session mapping lives in memory. What FORGE offers
  is stated in the startup context (SessionStart hook, `additionalContext`).
- **Tasks:** `agentProgressSummaries` (subagents write a progress line about every 30 s),
  `perTaskStopAffordance` (stop only ends the run; background tasks keep running and are stopped
  individually: `sessions.stopTask`), `backgroundTasks` (`sessions.toBackground`, like Ctrl+B). `Session.subagents`
  shows running subagents with progress; background tasks carry `summary`.
- **Structured responses:** PR title and body via `outputFormat: json_schema` (`completeJson`, `maxTurns: 3`),
  fallback to the text format. Verified with the real CLI (Haiku, 4 s).
- **Fallback model:** Opus falls back to Sonnet on overload (`fallbackModel`); other models without one.
- Not implemented: `maxTurns`/`maxBudgetUsd` as a limit for agents. Both count over the entire lifetime of a
  streaming process and would abort long Sessions; with a subscription, costs are only an API equivalent.

## Tests

Desktop: token batching and ordering, Markdown blocks, caches. Sidecar: fork (including files and first
message), FORGE tools with a real Git worktree, subagent progress, stop and background.

<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0008-remote-bridge-loeschen.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0008: Remote Control via the SDK Session, deleting projects, automations removed

Date: 2026-10-10 · Status: accepted

## Remote Control

Problem with ADR 0007: `claude remote-control` starts its own Sessions. What was written in FORGE was not
visible in the Claude app, and vice versa.

New: the running Agent SDK query offers `enableRemoteControl(enabled, name)` (control request
`remote_control`, which is also how the IDE hosts use it). The method is not in the SDK types (0.3.296);
it is encapsulated in `AgentSdkRuntime`. Response: `session_url` (claude.ai/code/session_…), status arrives as
`system/bridge_state` (ready, connected). Connected in the spike, even without a first message and without
folder trust.

- ~~Remote is on per project: all open Sessions are connected, new and resumed ones automatically.
  Without an open Session, FORGE opens an empty one ("Remote Session") that gets the title of the first message.~~
  Replaced on 2026-10-11, see addendum below.
- Messages from the app: Sessions run with `--replay-user-messages` (via `extraArgs`). FORGE's own messages
  come back with their own `uuid` and are ignored; unknown `uuid`s are messages from the app.
  `command_lifecycle: started` with an unknown `uuid` marks a run from there (status, Git base for
  auto-commit). Fallback: if the echo is missing, FORGE reads the transcript after the run.
- Security: messages from the app run through the same Session, so with profile, approvals (`canUseTool`)
  and blocklist (PreToolUse hook). This is stricter than before.
- Remote state is not saved; after a restart it is off.

### Addendum 2026-10-11: global, no separate Session

User request: turning it on should not open an additional Session, but make every Session open in FORGE
individually selectable in the Claude app.

- Remote is global instead of per project (`remote.state/start/stop` without `projectId`, `remote.updated` carries
  only the `RemoteState`). "Open" means: a Session with a running CLI process, i.e. exactly the Session tabs.
  Saved Sessions without a process cannot be connected; they are added as soon as they are resumed.
- Each Session gets its own bridge entry named `FORGE · <Projekt>: <Titel>`; identical names
  are distinguished with ` (2)`, ` (3)`. The name is assigned on connect and not changed afterwards.
- Without a running Session, Remote is merely switched on; the UI says so. If a Session is started or resumed
  afterwards, FORGE connects it automatically.
- A finished or deleted Session drops out of the list. Switching on again reconnects failed
  Sessions. Switching off disconnects all of them (`enableRemoteControl(false)`).

## Deleting a project

`projects.remove` optionally takes `deleteFolder` and `deleteGitHubRepo`. Order: close open Sessions,
delete the GitHub repo (most likely to fail, and then nothing is lost), delete the folder, remove the entry.
Blocked: drives, home and its ancestors, standard folders in home, FORGE data and installation folder, folders
containing other projects. Worktrees are deleted via `git worktree remove`. `gh repo delete` needs the scope
`delete_repo`; FORGE requests it via `gh auth refresh -s delete_repo` (device flow as with login) only when
the user wants to delete the repo. For every deleting option, the UI requires typing the project name.

## Removed

Feature workflow and scheduled tasks (view "Automatisierungen") at the user's request. Migration 3 drops
the tables `workflows` and `schedules`. Project tags and worktrees remain.

## Tooltips

Native `title` tooltips are replaced app-wide by a custom layer (`TitleTooltips`): on hover the attribute moves
to `data-forge-title` and back afterwards. This way the custom look also applies in CodeMirror and xterm.

## Effort

Effort (low, medium, high, xhigh, max, the names from Claude Code) as a selection on three levels: global (settings), per project and per Session in the
composer. Start via the SDK option `effort`, change in a running Session via `applyFlagSettings({ effortLevel })`.
Which levels a model supports is reported by Claude Code in the model list (`supportsEffort`, `supportedEffortLevels`);
without support, FORGE hides the selection. Migration 4: `projects.default_effort`, `sessions.effort`.
Model names come from the same list ("opus" → "Opus 5.5").

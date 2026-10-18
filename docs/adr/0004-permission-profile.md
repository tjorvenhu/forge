<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0004-permission-profile.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0004: Permission profiles and policy engine

Date: 2026-10-10 · Status: accepted

## Profiles

| Profile | Claude mode | Approvals | Additional |
|---|---|---|---|
| Safe | `default` | each request individually in FORGE, no "allow for Session" | `WebFetch`/`WebSearch` disabled |
| Balanced | `acceptEdits` | file edits in the project automatic, everything else individually or for the Session | - |
| Autonomous | `bypassPermissions` | no prompts | default for new projects, see below |

Additionally per Session: **Plan only** (`plan`), independent of the profile.

## Hard blocklist (all profiles, including bypass)

Implemented as a `PreToolUse` hook in the sidecar, not as a Claude setting, so that repo files cannot
weaken it:

- `git push --force`/`-f`/`--force-with-lease`, push to `main`/`master` (also via `refs/heads/` or in
  quotes), `git push --mirror`/`--prune`, deleting remote branches, `git reset --hard`,
  `git branch -D`, `git clean -fdx`, recursive deletion of a drive or home root (also with `--`,
  long options, `${HOME}`, `/*` and Git Bash drive paths such as `/c/`).
- File tools on sensitive paths: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.npmrc`, `~/.netrc`,
  `~/.pgpass`, `~/.docker/config.json`, `~/.claude/.credentials.json`, browser profiles (Chrome, Edge, Firefox),
  Windows Credential Store. Grep and Glob, if the pattern or search folder can reach one of these paths.
- If the hook itself fails, the call is denied (`guard-error`).
- In the Autonomous profile additionally: write access outside the project folder.

## Autonomous as default (revision 2026-10-10)

Originally Autonomous was locked twice: unlock globally (typing `BYPASS`) and confirm per
project with the project name. That was too cumbersome in daily use and was removed.

- `defaultProfile` is now `autonomous`; new projects and worktrees adopt it directly.
- Switching to Autonomous is a normal click in the profile menu, without a confirmation dialog.
- The tag `sandbox-only` remains the per-project exception: Autonomous cannot be selected then, and
  if the tag is set in an Autonomous project, it falls back to Balanced. `resolveProfile`
  checks this again at Session start.
- The hard blocklist and the write lock outside the project remain unchanged.

A profile change also applies immediately to running Sessions (`SessionService.applyProjectProfile`):
permission mode via `setPermissionMode`, approval scope and write lock via the profile of the
live Session. An active plan mode stays in place. So that switching to bypass is possible, every
Session starts with `allowDangerouslySkipPermissions: true`. Without the flag the CLI rejects the switch.
The active mode is still always set explicitly. Because the flag allows bypass at any time, FORGE checks
every mode that Claude Code reports against the profile and resets anything higher (event `policy.blocked`,
rule `permission-mode`); if that fails, the Session is terminated. `disallowedTools` is fixed at process start.
If a running Session switches to Safe, the PreToolUse hook blocks the web tools (`profile-tool`).

Bypass is still not a sandbox. Commands run with the user's privileges. The write lock outside
the project only applies to the file tools, not to shell commands. Repo files such as
`.claude/settings.json` do not change the mode, because FORGE always sets it explicitly.

## Audit

Every approval decision (user or policy) is stored in `approvals` with time, Session, tool, decision and source.
Tool inputs are passed through the secret redactor before storage and
truncated to 20,000 characters per text field. If writing the audit entry fails, the
denial still stands.

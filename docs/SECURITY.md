<img src="../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="SECURITY.de.md"><img src="../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# FORGE: Security and permission concept

Please report vulnerabilities confidentially, as described in [SECURITY.md](../SECURITY.md).

## Principles

1. **No local interface for the UI.** UI and sidecar talk over stdin/stdout. There is no localhost port. The only network exception is the phone (phase 5): SIP and RTP over UDP on the interface to the PBX, only packets from the PBX, and with a connected desk phone an HTTP port that answers only that phone (see section Phone).
2. **Webview with minimal rights.** Tauri capabilities: `core:default`, `dialog:allow-open`, `opener:allow-open-url` for `https://` as well as `http://localhost:*` and `http://127.0.0.1:*` (dev servers). No shell, FS or HTTP plugin. CSP without external sources (only GitHub avatars as images). `freezePrototype` is off because the editor and terminal libraries set prototype methods while loading; no third-party content is loaded.
3. **No shell interpolation.** All processes (`git`, `gh`, `claude`) start with `spawn(cmd, args[], {shell:false})` and an explicit `cwd`.
4. **Validation at the boundary.** The sidecar checks every RPC request with Zod. Paths are canonicalized, including across symlinks and junctions (`projects.readFile`, `projects.listFiles`); file and Git operations outside the project folder are rejected. Git receives paths as literal pathspecs (`GIT_LITERAL_PATHSPECS=1`), so characters such as `[` or `*` in a file name do not select further files. `FORGE_NODE` and `FORGE_SIDECAR` only take effect in debug builds; `term_open` only accepts an existing directory and a file named `claude`, `claude.exe` or `claude.cmd`.
5. **No credentials in FORGE.** The CLI handles the Claude login, `gh auth` the GitHub login. FORGE does not read `~/.claude/.credentials.json` and stores no tokens. Single exception: if GitHub rejects the anonymous update check (rate limit), FORGE fetches the token of the gh login via `gh auth token` for that one request (see ADR 0013). `ANTHROPIC_API_KEY` is detected, never shown, and removed from session environments by default.
6. **What FORGE itself sends over the network.** Project data stays local. Requests FORGE makes on its own:
   - **Usage statistics (off by default, Settings > About FORGE > Privacy):** After the setup assistant and the sync question, FORGE asks once whether to turn them on. Without an answer they stay off; closing the dialog asks again at the next start. When on, FORGE sends anonymous totals to `https://forge.vanturis.de` every 5 minutes (random installation ID, version, operating system, interface language, type of Claude subscription, counter values). No content, names or paths. Switching them off deletes the record at the service. Details in `packages/sidecar/src/stats/usage-stats.ts`.
   - **Updates:** release list and files from the GitHub API, every file verified with an Ed25519 signature (ADR 0013).
   - **Claude Code version:** at startup and every six hours after that, the version number from `https://downloads.claude.ai/claude-code-releases/<latest|stable>` (the same endpoint the official installer uses, channel from `autoUpdatesChannel`), without sending any data. The update itself runs `claude update`.

## Permission profiles

See [ADR 0004](adr/0004-permission-profile.md). In short:

| Profile | Claude mode | Prompts |
|---|---|---|
| Safe | `default` | every request, no "allow for session", no web tools |
| Balanced | `acceptEdits` | edits in the project automatic, commands need approval |
| Autonomous | `bypassPermissions` | none; default for new projects, can be turned off per project with the tag `sandbox-only` |

Effectiveness is tested: `session-service.test.ts` checks the modes passed on, `real-claude.e2e.test.ts`
checks with the real CLI that Safe requests an approval and that a denial prevents execution.

## Hard blocklist (all profiles)

Implemented as a `PreToolUse` hook (`policy/guard.ts`). It also applies with `bypassPermissions`, because hooks run before
the permission check. Blocked are, among others:

- `git push --force` / `-f` / `--force-with-lease` / `+refspec`, push to `main`/`master` (also as `refs/heads/main`, `HEAD:main` or in quotes) and push from the protected branch (both off by default, see below), `git push --mirror`/`--prune`, deleting remote branches (`--delete`, `-d`, `:branch`)
- `git reset --hard`, `git branch -d/-D/--delete`, `git clean -f…`
- recursive deletion of `/`, `~`, `$HOME`/`${HOME}`, drive roots (also `/c/`, `/mnt/c`), with `--`, long options or an appended `/*` or `\*`; `Remove-Item`/`rd /s` on drive roots and `$env:USERPROFILE`; formatting drives
- file tools and commands on `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.config/gh`, `~/.git-credentials`, `~/.npmrc`, `~/.netrc`, `~/.pgpass`, `~/.docker/config.json`, `~/.claude/.credentials.json`, browser profiles, the Windows credential store. `~` is always resolved against the real user directory.
- Grep and Glob, if their pattern or search folder can reach one of these folders
- in the Autonomous profile: writes by the file tools (Write, Edit, MultiEdit, NotebookEdit) outside the project
- a permission mode above the profile: if Claude Code reports a higher mode (for example after a switch via Remote Control), FORGE resets it (rule `permission-mode`); if that fails, the session is ended

Under Settings → Blocklist each rule can be switched off individually (setting `disabledPolicyRules`, applies globally
to all projects and profiles from the next tool call). Default: all rules on except `git-push-protected`
(push to `main`/`master` is allowed; force push, `--mirror`/`--prune` and deleting remote branches stay
blocked) and `git-branch-delete` (deleting local branches of finished agents). Existing installations get
these rules switched off once during the update (DB migration); anyone who switches them back on afterwards keeps that. The
profile rules (`profile-tool`, `permission-mode`) and `guard-error` cannot be switched off.

Every block is shown as a `policy.blocked` event and audited in `approvals`. If the check itself
or the logging fails, the call is denied (rule `guard-error`).

**Limits:** The blocklist works with patterns on command text. It is a guardrail, not a sandbox.
An obfuscated command (for example via a script file) can get around it. Writes by Bash and PowerShell
outside the project are not restricted; the write block in the Autonomous profile only applies to the file tools. Autonomous is still the default
(decision in ADR 0004). For projects with higher risk there is the tag `sandbox-only`.

## Commits

`git.commit` commits only the files selected in the UI (`git commit --only -- <paths>`).
Before that it checks: no conflicts, the files actually have changes, no sensitive files
(`.env`, keys, certificates, credentials) and no build artifacts. Only file names and
paths are checked, not the content: the content check needed one git call per file and made commits too slow.
On a match FORGE asks whether to commit anyway and shows the affected files with the reason.
It only commits after explicit confirmation.
FORGE pushes on its own only in projects with the tag `auto-push`. Pushes by Claude to protected branches
(`main`, `master`) can be blocked by the blocklist (rule `git-push-protected`, off by default).

**Deleting branches** (`git.deleteBranch`) is an action in the Git area, not for Claude: the blocklist still blocks
`git branch -d/-D` for Claude's shell. Branches are only deleted locally. The current branch, `main`, `master` and the
default branch of `origin` are locked, as are branches checked out in a worktree. Branches with commits
that are not in any other branch are deleted only after a second confirmation. When removing an agent,
its branch can be deleted along with it without a merge, on explicit request.

**Restore** (`git.restoreTo`) brings the files of the project folder back to the state of a commit
(`git restore --source=<commit> --staged --worktree -- .`). Branch and history stay unchanged, the result
is new, uncommitted changes. FORGE first saves open changes, including new files, as a Git stash.
The commit ID must be hexadecimal; while a session is working in the project, restore is locked.

## Redaction

Tool inputs and outputs pass through `policy/redact.ts` before they are stored (API keys incl.
`sk-proj-`/`sk-svcacct-`, GitHub/GitLab/Slack tokens, AWS keys, Bearer headers, `password=` patterns also as
JSON keys, assignments to `*_TOKEN`/`*_SECRET`/`*_KEY`/`*_PASSWORD`, passwords in URLs, private keys).
Text fields in tool inputs are truncated to 20,000 characters before storage; the approval still applies
to the full input. The diagnostics show no
email address or org data of the Claude login.

## Known residual risks

- A repository's own `.claude/settings.json` can extend Claude permissions (`permissions.allow`); that is
  native Claude Code behavior. FORGE always sets the permission mode explicitly, so a `defaultMode` from the
  repo cannot trigger a bypass. FORGE does not check allow rules from the repo in phase 1.
- The sidecar runs with the user's rights, as does the Claude CLI.

## Additions (setup, GitHub, AI commit, usage)

- **Bundled tools** (Node, Git, gh, Python) come from the official releases and are verified at build time
  with SHA-256, Python with SHA-512 from the nuget.org catalog (`scripts/prepare-runtime.mjs`). See [ADR 0006](adr/0006-mitgelieferte-laufzeit.md).
- **Claude Code installation** from the app runs the official installer from claude.ai. This happens
  only on an explicit click and only if no CLI is found.
- **Claude login:** FORGE starts `claude auth login`, opens the login page and passes the code the
  user pastes on to the CLI. FORGE does not store the code.
- **GitHub login:** device flow via `gh auth login --web`. gh stores the token in the
  Windows Credential Manager; FORGE never reads it (`gh auth status` without `--show-token`).
  gh also copies the one-time code to the clipboard.
- **AI commit message:** The diff of the selected files goes to Claude (same login as
  sessions, no tools, no session storage). Sensitive files (`.env`, keys, credentials)
  are left out, the rest of the diff passes through the secret redactor.
- **Usage display** uses an SDK method marked as experimental. FORGE checks before the call whether it
  exists. If it goes away, the display shows "not available"; sessions are not affected. The same applies
  to Remote Control. One-off CLI calls (check, command list, commit message, usage) are aborted after
  45 seconds.

## Additions phase 2/3

- **Writes to Claude configuration** (CLAUDE.md, skills, subagents, hooks) only after clicking
  Save, atomic (temporary file, then rename), with `.bak` and conflict check; the sidecar computes the paths,
  the UI passes no paths. Deleted skills move as folders to `<data folder>/trash/skills/`,
  deleted subagents become `<name>.md.bak`.
- **Marketplace plugins** are installed and removed by FORGE only via `claude plugin install|uninstall --scope user`
  with a validated ID (`name@marketplace`), without `-y`: plugins that Claude Code wants confirmed before installing
  fail with its message. The browser points out that hooks and MCP servers of a
  plugin run commands.
- **Max tier (5x/20x)** is read by FORGE from `oauthAccount` in `.claude.json`, only the fields `userRateLimitTier`
  and `organizationRateLimitTier`. `.credentials.json` stays off limits.
- **Hooks** run commands. FORGE checks only the structure, not the content; a hook from a
  third-party repository in `.claude/settings.json` is run by Claude Code itself (native behavior).
- **Remote Control** applies globally: when on, every running FORGE session (all projects, like the
  session tabs) is its own entry in claude.ai and the Claude app (your account). Sessions that start
  or are resumed afterwards are added automatically; FORGE does not start a separate session for this. Messages from
  there run through the same session: profile, approvals and blocklist apply. An ended session drops
  out. Switching it off disconnects everything, the sessions keep running locally.
- **Automatic continuation after the usage limit** sends messages without you, but within tight limits:
  only after a usage limit has stopped a run of this session, only to this one session and
  always with the same fixed text. The session runs with its normal profile, its approvals and the
  blocklist; there is no exception and no higher permission mode. Open approvals stay open
  until you answer. At most three automatic continuations without your input, then it stops.
  A message of your own, Stop, Delete or "Do not continue automatically" cancel the plan;
  the feature can be switched off entirely in the settings (default: on).
- **Terminal**: only a shell or the Claude CLI can be started, no network access to the PTY.
- **Test commands** run with your rights in the project folder.
- **Deleting a project** together with its folder or GitHub repository requires typing the project name. Locked are
  drives, the user directory, dot folders and standard folders directly below it (also OneDrive), the
  Claude configuration, credential folders, AppData, Program Files, ProgramData, the Windows directory,
  FORGE data and folders containing other projects. Locked means: the folder,
  everything in it and its parent folders. Sessions, terminals and dev servers of the project and its worktrees are stopped first.
  FORGE requests the GitHub scope `delete_repo` only when it is needed.
- **Auto-commit/auto-push** commit only files from the current run, never sensitive files, never push
  to main/master and never with force. New messages from FORGE wait until tests and auto-commit of the last
  run are done. If a file has changed since the end of the run, or a
  new run has started in the meantime (for example from the Claude app), the auto-commit is skipped. The content of the files is
  not checked for keys or passwords.

## Phone (phase 5, ADR 0010)

- **Who may call:** only numbers from the "Allowed callers" list. An empty list means: nobody. Short numbers
  (extensions) must match exactly. Long numbers are normalized before comparison (+49…, 0049…, 0… with
  country code 49) and must then be identical. FORGE rejects other calls with 403 and logs them.
  FORGE accepts SIP only from the PBX address; packets from other senders are dropped and logged.
  Requests within a call must carry FORGE's tag.
- **PIN for control:** Everything except status, usage and hanging up requires the PIN by default. It is
  entered on the phone keypad (DTMF, RFC 4733 or SIP INFO) and confirmed with #. It never passes through the
  language model and is not read aloud. Only a scrypt hash is stored. After three wrong attempts
  FORGE hangs up; after that no more digits are checked. Five failed attempts from one number or ten in total within
  one hour lock PIN entry for one hour, also across restarts. Every failed attempt is answered
  with a delay (1 s, doubled, at most 16 s). A new PIN in FORGE lifts the lock. Without the PIN,
  `status` only gives counts, `details` is locked. Reason: caller numbers can be spoofed.
- **No confirmation by key (since 2026-10-11):** After the PIN, FORGE runs controlling actions immediately when
  the caller requests them. The earlier confirmation with key 1 was too cumbersome during a call and was removed at the
  user's request. Claude still receives text from sessions as marked data, not as instructions, and the
  system prompt forbids using tools because of it. Residual risk: if session text still gets Claude to
  call a tool, there is no second hurdle anymore. The tools therefore have their own limits: commits
  always leave out sensitive files and build artifacts, push never with force, pull only fast-forward.
- **What Claude can do on the phone:** only the FORGE tools: status, details, send, start, answering
  approvals, stop, close, model/thinking effort/mode of a session, cancelling automatic continuation,
  Remote Control, dev servers, Git (status, commit, push, pull), projects, usage, hang up. No file, shell
  or web tools (`tools: []`, own tools via in-process MCP). Started or resumed sessions
  run as always with the project's profile, approvals and blocklist. Push to `main`/`master` works on the phone only
  if the caller explicitly asks for it (parameter `allow_protected`); at the computer it requires typing the
  branch name.
- **Secrets:** SIP password, OpenAI and Gemini keys and the web password of the desk phone are stored under `<data folder>/secrets`, encrypted with DPAPI for the
  Windows user account (PowerShell, passed via stdin). The UI only sees whether they are set.
- **Data flow:** With Gemini Live (default) the call audio goes to Google; Gemini also receives the results
  of the FORGE tools (session titles, summaries, open approvals), marked as data. With Claude as the
  conversation partner, Claude (Haiku) conducts the call through the subscription; audio goes to OpenAI or Google for recognition and the reply texts for
  speech output, depending on the setting. Transcripts are stored locally in the call log.
- **Gemini as conversation partner (ADR 0011):** the same tools and limits as for Claude. Calls arrive as
  JSON and are validated before execution; unknown tools and invalid arguments are returned as error text.
  Here too the PIN only goes through the keypad. Gemini receives session text as marked data with the same prohibition
  in the system prompt; the residual risk "no second hurdle after the PIN" applies equally.
- **Desk phone (ADR 0011):** FORGE opens an HTTP port (default 8766) only on the interface to the phone.
  It answers only the registered IP of the phone, and every URL contains a random token (96 bits) that only appears in
  the provisioning file. Key presses (select session, call FORGE) and answers to
  approval menus go this way; approvals on the desk phone need no PIN, just like approvals at the computer. Anyone on the LAN who takes over the phone's
  IP and knows the token can grant approvals. The provisioning file contains no passwords.
  For LEDs and display FORGE logs in to the phone with its web login (Basic or Digest, unencrypted on the LAN).
- **Residual risks:** SIP over UDP and RTP are unencrypted (no TLS, no SRTP). Operate in your own network or over a
  VPN to the PBX. Windows Firewall asks for access for Node.js on the first call. Anyone on the network who can spoof the
  sender address of the PBX gets past the address check; only TLS helps against that. FORGE accepts audio
  only from the SDP address or the PBX.

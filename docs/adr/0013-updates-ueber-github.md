<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0013-updates-ueber-github.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0013: Updates via GitHub Releases

Date: 2026-10-12 · Status: accepted

## Goal

New versions without manual reinstallation: as soon as an update is available on GitHub, FORGE offers it.

## Decisions

**Build:** `.github/workflows/release.yml` runs on every push to `main` (not for documentation-only changes) on
`windows-latest`: version `0.1.<run_number>` in `tauri.conf.json`, lint and typecheck, sidecar and frontend
(once, `beforeBuildCommand` empty via `tauri.ci.json`), then `gh release create v0.1.<n>` with the
commit subjects since the last tag as notes. A newer push cancels a running build.

**Two kinds of releases** (addendum 2026-10-12, previously every build took 9.5 minutes): node, git and gh are
476 MB and almost never change; the LZMA packing in the NSIS installer alone took 2 minutes.

- `FORGE_<v>_update_<laufzeit>.zip` with every release: only `forge-desktop.exe`, `runtime/sidecar/sidecar.mjs`
  and `update.json`, about 4 MB. Built with `tauri build --no-bundle`, without runtime download and without NSIS.
- `FORGE_<v>_x64-setup.exe` only if there is no installer yet for the runtime key (new
  node, git, gh or Python version in `scripts/prepare-runtime.mjs`) or on request (Run workflow → full).
  Alongside it `FORGE_<v>_x64-setup.<laufzeit>.runtime`: the name of this small file tells the app the runtime of the
  installer (addendum 2026-10-17: previously it was part of the installer name as `FORGE_<v>_<laufzeit>_x64-setup.exe`;
  the app reads both forms). Short names up to 0.1.7 are the oldest installers with the old runtime;
  a self-selected setup.exe with a short name from 0.1.8 on is accepted by the app, and a wrong runtime is then
  caught by the check after installation.

The runtime key is `node-<v>_git-<v>_gh-<v>_python-<v>` (`prepare-runtime.mjs --key`, Python since 2026-10-17); the installed app reads
it from `runtime/VERSIONS.json`. Rust builds with thin LTO instead of full LTO (one minute faster, barely larger),
the toolchain is no longer updated. "Latest" on GitHub stays on the newest full installer
(`--latest=false` for the others): download for new installations, and older FORGE versions that only read
`releases/latest` always find an installer there.
Unit tests do not run there: two tests fail on Windows because of files that are deleted with a delay.

**Check and download** (`packages/sidecar/src/update/app-update.ts`, `github-releases.ts`; addendum 2026-10-17,
previously via `gh` with the user's login while the repository was private): directly via HTTPS to the
GitHub API (`/repos/vanturis/forge/releases`, `/compare`, files via the asset's API address with
`Accept: application/octet-stream`). Anonymous first, so that updates work without a GitHub account. Only if GitHub refuses
(401/403/404/429: private repository or rate limit of 60 requests per hour and IP), a second attempt with the
token of the gh login (`gh auth token`), if there is one.
First check shortly after startup, then every 30 minutes (setting `updateChecks`), only in the desktop app
(`FORGE_APP_VERSION` set). The installer is stored in `%TEMP%\forge-update` and checked against the SHA-256
that GitHub reports for the file (`digest`), and always against its signature (see below); discarded on mismatch. Selection (`pickRelease`): if the newest
release has a small update for the installed runtime key, that one is taken; otherwise the newest full
installer. After that, small updates follow again. The UI shows type and size.

**Install** (Rust command `install_update`, `src-tauri/src/update.rs`): only files from
`%TEMP%\forge-update`. `*-setup.exe` as below. `*_update_*.zip` is extracted with `tar.exe` into `staged`
and may contain exactly the three expected files; the version in `update.json` only digits and dots. A
PowerShell script (started outside the job object) waits until FORGE has exited, renames the old files
to `.forge-old`, copies the new ones, restores the old ones on error, sets `DisplayVersion` in the
uninstall entry and restarts FORGE. Log: `%TEMP%\forge-update\apply-update.log`. The installer:
the shell shuts down terminals and the sidecar cleanly (open Sessions are interrupted as on close and can be
resumed), starts the installer itself with `/P /UPDATE /R` (no prompts, settings are kept,
FORGE restarts afterwards) and exits. The sidecar does not start it: its job object would terminate the installer
together with FORGE on exit.

**Signature (addendum 2026-10-17, with the public release):** every release asset has `<asset>.sig` next to it:
Ed25519 over `FORGE-UPDATE-1\n<Dateiname>\n<sha256 hex>` (`scripts/sign-update.mjs`, base64). The name in the
message binds the signature to version and runtime. Private key: secret `FORGE_UPDATE_SIGNING_KEY` in the
repository (PEM, PKCS8); without it, the workflow aborts already in the Plan step. Public key hardcoded in
`packages/sidecar/src/update/signature.ts`. The app only offers assets with `.sig` (`signedOnly`), so older
unsigned releases are invisible. Therefore the workflow only counts a signed installer as existing:
the first release after the switch rebuilds the full installer. A new key means: new public
key in `signature.ts`, replace the secret; installed versions with the old key then only accept
the installer by hand. An installer the user selects themselves (Downloads folder) is not checked: they would
run it anyway. Code signing (SmartScreen) is still missing.

**One signature file (addendum 2026-10-18):** six files per release were too many for people looking for the
download. Since 0.1.102 a single `FORGE_<v>.sig` holds the signatures of all assets as JSON (`{ "<asset>":
"<base64>" }`, same message as above, `sign-update.mjs --manifest`). The `.runtime` marker is gone: the installer's
runtime is the one of the update zip of the same release, which the same build makes. The app still reads the old
form (`signedOnly`, `signatureFrom`). Installations up to 0.1.101 only know the old one; one bridge release with both
forms (workflow input `legacy_signatures`) lets them update into the new form. Since then Authenticode signing via
Azure Artifact Signing is in place as well (only `forge-desktop.exe`, installer and uninstaller).

## Addendum 2026-10-13: Sessions survive the update

Goal: an update should neither close nor pause running Claude Sessions.

**Why the Claude processes do not keep running:** each Session is a CLI process attached to the sidecar via stdio.
Approvals (`canUseTool`), the blocklist (PreToolUse hook) and the FORGE tools (in-process MCP server) run
in the sidecar. A new sidecar cannot take over these pipes and callbacks; a persistent Session process
outside the update would have to contain exactly this code and would itself need updating. Therefore:
pause, remember, resume after the restart. The history is in the CLI transcript; `resume` picks up there.

**Flow:** before `install_update`, the main window calls `app.prepareInstall`. On exit, after the drain
(auto-commits and tests of finished runs), the sidecar then writes every Session with a running CLI process to
`update_resume`, with `working` if a run, a background task or a subagent was running. Only valid for
two minutes after `prepareInstall`; if `install_update` fails, `prepareInstall { cancel: true }` reverts it.
The new sidecar reopens the Sessions 3 s after startup: idle ones without a prompt (tab and status are back),
working ones with an automatic message (`source: "auto"`) preceded by the event `app.updated` (card
"FORGE aktualisiert" with both versions). Markers older than 30 minutes expire: FORGE then did not come back directly
from the update. Interrupted commands do not continue; the message tells Claude to restart them.
The main window remembers open chat windows (`localStorage`) and reopens them after startup.

**Two steps:** if the chain file is present at startup, the second step may follow right away. The Sessions then wait
(`holdsResume`, at most 5 minutes) until it is clear whether it will be installed; otherwise they would start up and
be paused again immediately. If it starts, the markers remain for the next startup.

**Phone:** `forge_system update_install` (RPC `app.installUpdate`) asks the main window via the event
`update.install` to install; the call ends with the restart. Command palette: "FORGE … installieren".

Not covered: terminals in the bottom panel and dev servers do not restart by themselves after the update; a running
call ends.

## Tests

`app-update.test.ts`: version comparison, update found, download with checksum and signature, wrong checksum,
wrong signature without checksum, unsigned assets, up to date, no release yet, choice between small update and
full installer, download of the small update. `update-signing.test.ts`: signing script against verification, anonymous
fetch with token only on refusal, rate limit.
The replacement script has been checked by hand (success and rollback with a locked file).

<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0006-mitgelieferte-laufzeit.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0006: Everything in one installation (Node, Git, GitHub CLI), Claude setup in the app

Date: 2026-10-10 · Status: accepted

## Context

After running the installer, FORGE should be usable without further downloads or terminal commands.
Previously Node.js, git and gh had to be present, and logins went through `claude auth login` and `gh auth login`.

## Decision

- **Bundled:** Node.js 24.21.0, PortableGit 2.56.0.2 (includes Bash, ssh and the Git
  Credential Manager), GitHub CLI 2.102.0. `scripts/prepare-runtime.mjs` downloads the archives from the
  official sources, verifies the SHA-256 and places them under `apps/desktop/src-tauri/runtime/`.
  Tauri bundles the folder as a resource. Documentation, man pages, translations and Vim are removed.
  Installer: about 92 MB.
- **Precedence:** bundled tools before system tools, so that every installation behaves the same.
  The user's global git configuration and credential store still apply (same HOME, same
  Windows Credential Manager).
- **Claude Sessions** get `runtime/git/cmd` and `runtime/gh/bin` prepended to PATH. If the machine
  has no Git for Windows, `CLAUDE_CODE_GIT_BASH_PATH` points to the bundled Bash (Claude Code needs
  it on Windows for its Bash tool).
- **Claude Code is not bundled**; instead it is installed from the app when needed via the official installer
  (`irm https://claude.ai/install.ps1 | iex`). Reasons: the CLI updates itself,
  the bundled SDK binary would be 260 MB and outdated. Login runs via
  `claude auth login`: FORGE opens the login page and passes the pasted code to the CLI.
- **GitHub login** via the bundled gh using the device flow: FORGE shows the one-time code and opens
  github.com/login/device. gh stores the token in the credential manager, FORGE never sees it.
  Afterwards `gh auth setup-git`, so that git over https uses the same credentials.
  The alternative would have been a custom GitHub OAuth app; it would need a registered client ID and
  would manage tokens in FORGE.

## Consequences

- Larger installer, longer release build (about 4.5 minutes).
- Licenses of the bundled software: [THIRD_PARTY_LICENSES.md](../../THIRD_PARTY_LICENSES.md).
- Version updates: adjust the constants in `scripts/prepare-runtime.mjs` (version, URL, SHA-256).

## Addendum 2026-10-17: Python

Claude often failed in Sessions because Python was missing (on Windows only the Store placeholder responds then).

- **Variant:** the official NuGet package `python` from the PSF (3.14.8, about 15 MB packed, 43 MB unpacked). It is
  a complete CPython with pip, venv and ensurepip, without tests, tkinter and IDLE; `include`/`libs` remain for
  C extensions. The embeddable variant has no pip, ignores environment and user site because of `python._pth`, and
  cannot create venvs. 3.14 instead of the just released 3.15, so that packages with C extensions find wheels.
  Verified via SHA-512 from the nuget.org catalog entry (`packageHash`).
- **Location:** `runtime/python`, plus `python3.exe` (copy) and `pip`/`pip3` as `.cmd` and shell script; pip's own
  exe launchers contain an absolute path.
- **pip:** `pip.ini` in `sys.prefix` with `[install] user = true`. A plain `pip install` therefore ends up in
  `%APPDATA%\Python\Python314`, not in the installation folder that the next full installer replaces. The file applies
  only to this interpreter; venvs created from it have their own `sys.prefix` and install normally. `PIP_USER` as
  an environment variable would be wrong, because pip would then abort in every venv. `--target`/`--prefix` need `--no-user`.
- **Precedence:** the bundled copy before a system Python, as with git and gh. This way `python3` and `pip`
  always exist, and the placeholder in WindowsApps never wins. A custom Python is still reachable via `py` or the
  project's venv. Without the bundled runtime (development), a system Python applies, but not the placeholder.
- **PATH** in Sessions, dev servers and terminal: `runtime/python` and the user Scripts folder after git and gh, before
  the rest. Additionally `PYTHONUTF8=1`, otherwise redirected output breaks at the first character outside the
  ANSI code page.
- The runtime key gets `_python-<v>`; installations without Python keep the old key and are therefore
  offered the full installer.

## Addendum 2026-10-19: macOS and Linux

This ADR applies to Windows. On macOS and Linux FORGE only bundles Node.js and the GitHub CLI, Git and Python come
from the system: [ADR 0014](0014-macos-and-linux.md).

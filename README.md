<img src=".github/assets/flags/gb.svg" height="14" alt=""> English · <a href="README.de.md"><img src=".github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

<p align="center">
  <img src=".github/assets/banner-en.png" alt="FORGE: a desktop app for Claude Code" width="100%">
</p>

<p align="center">
  <a href="https://github.com/vanturis/forge/releases/latest"><img src="https://img.shields.io/github/v/release/vanturis/forge?sort=semver&style=for-the-badge&label=Version&color=f97316" alt="Latest version"></a>
  <a href="https://github.com/vanturis/forge/releases/latest"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fforge.vanturis.de%2Fapi%2Fv1%2Fdownloads&query=%24.downloads&label=Downloads&style=for-the-badge&color=21262e" alt="Installer downloads"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/License-AGPL--3.0-21262e?style=for-the-badge" alt="License AGPL-3.0"></a>
  <a href="https://forge.vanturis.de/stats"><img src="https://img.shields.io/badge/FORGE-in%20numbers-21262e?style=for-the-badge&logo=googleanalytics&logoColor=white" alt="FORGE in numbers"></a>
</p>

<p align="center">
  <a href="https://forge.vanturis.de/download"><img src="https://img.shields.io/badge/Download-Windows%20%7C%20macOS%20%7C%20Linux-f97316?style=for-the-badge" alt="Download for Windows, macOS and Linux" height="42"></a>
  &nbsp;
  <a href="https://buy.stripe.com/9B64gBc4e5j80vg1WxbV600"><img src="https://img.shields.io/badge/Support-FORGE-e11d48?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Support FORGE" height="42"></a>
</p>

<p align="center">
  <b>FORGE</b> runs real Claude Code sessions in your projects, streams the answers, asks for approvals<br>
  and puts Git, agents, preview and project knowledge into one window. With your own Claude subscription, no API key.
</p>

<table>
  <tr>
    <td width="50%"><img src=".github/assets/screenshots/en/start.png" alt="Home: what is running and recently edited sessions"></td>
    <td width="50%"><img src=".github/assets/screenshots/en/projects.png" alt="Projects with Git status, tags and parallel agents"></td>
  </tr>
  <tr>
    <td align="center"><sub>Home: what is running, recent sessions, subscription usage</sub></td>
    <td align="center"><sub>Projects with Git status, technologies and running agents</sub></td>
  </tr>
</table>

<p align="center">
  <a href="#installation">Installation</a> ·
  <a href="#what-forge-does">Features</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#support-forge">Support</a> ·
  <a href="#development">Development</a>
</p>

---

## What FORGE does

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Claude sessions</h3>
      Streaming, tool cards, approvals, plan mode and questions from Claude. Several sessions side by side in split view.
    </td>
    <td width="50%" valign="top">
      <h3>Parallel agents</h3>
      Each agent works in its own Git worktree on its own branch. If you want, FORGE merges finished work automatically.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Git built in</h3>
      Diffs, commits of only the selected files, branches, push and pull, pull requests. Claude writes the commit messages.
    </td>
    <td valign="top">
      <h3>Preview and dev tools</h3>
      Dev server, local PostgreSQL test database and screenshots of the web app that Claude can look at itself.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Safe by default</h3>
      Permission profiles (Safe, Balanced, Autonomous) and a blocklist that always blocks dangerous commands.
    </td>
    <td valign="top">
      <h3>Project knowledge</h3>
      Workflows, decisions and pitfalls that every session gets at start. FORGE detects outdated entries on its own.
    </td>
  </tr>
  <tr>
    <td valign="top">
      <h3>Subscription usage</h3>
      Usage in the 5-hour and weekly windows with a forecast, and a daily report with tokens, commits and agents.
    </td>
    <td valign="top">
      <h3>Phone and sync (optional)</h3>
      Call FORGE and control it by phone (SIP). Encrypted sync across several PCs through a private GitHub repository.
    </td>
  </tr>
</table>

## Installation

**[forge.vanturis.de/download](https://forge.vanturis.de/download)** picks the right installer for your system.
On Windows, FORGE Setup downloads right away; on macOS and Linux the page shows the install command. Both
installers stay the same for every version: they fetch the newest FORGE from GitHub and check it.

### Windows

1. Download **[FORGE-Setup.exe](https://forge.vanturis.de/download)** (about 5 MB).
2. Run it. FORGE Setup looks up the newest version on GitHub, downloads it (about 110 MB), checks its signature and
   installs it. While FORGE is new, Windows may show a SmartScreen warning: click **More info** and then
   **Run anyway**.
3. On first start you pick the language. Then an assistant walks you through signing in to Claude and, if you
   want, to GitHub.

**Requirements:** Windows 10 or 11 (x64) and a Claude subscription with access to Claude Code, for example Pro
or Max. The installer includes Node.js, Git, the GitHub CLI and Python. If Claude Code is missing, FORGE installs
it on first start with the official installer from Anthropic.

### macOS

1. Open Terminal and run:

   ```sh
   curl -fsSL https://forge.vanturis.de/install.sh | sh
   ```

   The script ([scripts/install.sh](scripts/install.sh)) picks the build for Apple silicon or Intel from the newest
   release, checks its SHA-256 checksum, puts FORGE into **Applications** (or `~/Applications`) and starts it.
   Installed this way, macOS does not block the first start.
2. macOS asks for permissions when a feature first needs them: **Screen Recording** for the screenshot tool and
   **Microphone** for dictation. If you declined, allow FORGE later in System Settings > Privacy & Security.

<details>
<summary>Without Terminal: the dmg</summary>

Download `FORGE_<Version>_darwin-arm64.dmg` (Apple silicon) or `FORGE_<Version>_darwin-x64.dmg` (Intel) from
[forge.vanturis.de/download](https://forge.vanturis.de/download), open it and drag FORGE into **Applications**.
Start it from there: FORGE can only update itself in that folder. FORGE is not notarized by Apple (there is no
Apple developer account behind it), so macOS blocks the first start of a downloaded dmg: start FORGE once, then
open **System Settings > Privacy & Security** and click **Open Anyway**, or run
`xattr -dr com.apple.quarantine /Applications/FORGE.app`. This is only needed once; updates do not ask again.
</details>

**Requirements:** macOS 13.5 or newer, a Claude subscription as above, and `git` and `python3`. Both come with
the Xcode Command Line Tools (`xcode-select --install`; macOS offers them on the first call of `git`) or from
Homebrew. FORGE includes Node.js and the GitHub CLI.

### Linux

Run in a terminal:

```sh
curl -fsSL https://forge.vanturis.de/install.sh | sh
```

The script downloads the AppImage of the newest release, checks its SHA-256 checksum and installs it as
`~/.local/bin/forge` with an entry in the application menu. FORGE updates the AppImage itself. AppImages need
FUSE 2 (`sudo apt install libfuse2t64`, on older Ubuntu `libfuse2`); without it FORGE still starts, more slowly.

By hand, from [forge.vanturis.de/download](https://forge.vanturis.de/download):

- **AppImage** (any distribution): download `FORGE_<Version>_linux-x64.AppImage`, then
  `chmod +x FORGE_<Version>_linux-x64.AppImage` and start it.
- **deb** (Debian, Ubuntu and derivatives): `sudo apt install ./FORGE_<Version>_linux-x64.deb`. FORGE reports new
  versions; install them the same way.

**Requirements:** x64 with glibc 2.35 or newer (for example Ubuntu 22.04, Debian 12, Fedora 36), WebKitGTK 4.1
(`libwebkit2gtk-4.1-0`; the deb package installs it), `git` and `python3` from your distribution, and a Claude
subscription as above. FORGE includes Node.js and the GitHub CLI.

**Language:** FORGE is available in English and German. You choose the language on first start and can change
it later in Settings.

<details>
<summary>Which file is the right one?</summary>

FORGE Setup is the same file for every version. Without it: not every release has an installer. "Latest" always points to the newest release that has one. Older installers
are named `FORGE_<Version>_<Runtime>_x64-setup.exe`. The files `FORGE_<Version>_update_<Runtime>.zip` are only
for updating existing installations and are not enough for a new installation. FORGE uses the file
`FORGE_<Version>.sig` itself to verify updates (releases up to 0.1.101 have a `.sig` per file and a `.runtime` file).

macOS and Linux: the `.dmg`, `.AppImage` and `.deb` files are for installing. `FORGE_<Version>_darwin-*.app.tar.gz`
is the update for installed Macs, and `FORGE_<Version>_<platform>.sig` holds the signatures of that platform's
files. These files are added to a release a little after the Windows files.
</details>

**Updates:** FORGE checks for them shortly after start and then every 30 minutes. You see the changes and install
with one click. Every update is signed, and FORGE verifies the signature before installing.

## Privacy

Projects, chat histories and settings stay on your computer: `%APPDATA%\forge` on Windows,
`~/Library/Application Support/forge` on macOS and `~/.config/forge` on Linux (or `$XDG_CONFIG_HOME/forge`).

- **Anonymous usage statistics (off by default):** FORGE asks once on first start and asks you to turn them on.
  The totals show us how FORGE is used. Without an answer they stay off. When on, FORGE sends totals to
  [forge.vanturis.de](https://forge.vanturis.de) every 5 minutes: a random ID for the installation,
  the versions of FORGE and of the operating system, the interface language, the type of Claude subscription (for example Pro or Max 5x) and counters such
  as tokens per Claude model, estimated API cost, sessions, projects and agents. No content, no project names, no
  paths, no IP addresses. Turn them on or off under Settings > About FORGE > Privacy; when you turn them off,
  FORGE deletes the data already sent from the service.
- **Anthropic:** Claude Code sends your prompts and the project context to Anthropic with your own account.
  FORGE does not read any credentials.

<details>
<summary>All connections in detail</summary>

- **Installing and updating Claude Code:** If Claude Code is missing, FORGE downloads the official installer from
  `claude.ai`. To tell you about new versions, FORGE reads the version number from `downloads.claude.ai`.
- **Helper tasks:** Commit messages, session titles and the changelog in the update window also run through your
  Claude account.
- **Phone (optional, off by default):** Depending on the setting, call audio goes to Google (Gemini) or to
  OpenAI, each with your own API keys. The SIP connection goes to your phone system or SIP provider.
- **GitHub:** Updates and profile pictures in commits come from GitHub. Sync (optional) stores your FORGE data
  encrypted in a private repository of your GitHub account. All other GitHub features use your own account
  through the GitHub CLI.
- **npm registry:** The first time you start a test database in the dev tools, FORGE downloads PostgreSQL once
  as an npm package for your system (for example `@embedded-postgres/windows-x64` or
  `@embedded-postgres/darwin-arm64`) from `registry.npmjs.org`.
- **Usage statistics (only when turned on):** FORGE asks on first start, without an answer they stay off. To
  prevent abuse, the service keeps only a salted hash of the IP address in memory, for one day at most. The
  totals of all users are public at [forge.vanturis.de/stats](https://forge.vanturis.de/stats).

More in the [Vanturis privacy policy](https://vanturis.de/datenschutz) (German).
</details>

## Support FORGE

<a href="https://buy.stripe.com/9B64gBc4e5j80vg1WxbV600"><img src="https://img.shields.io/badge/Support-FORGE-e11d48?style=for-the-badge&logo=githubsponsors&logoColor=white" alt="Support FORGE"></a>

If FORGE helps you, we appreciate a voluntary contribution. You choose the amount. The money goes to Vanturis UG
(haftungsbeschränkt), the company that develops FORGE. It is not a charity, so there is no donation receipt.

- **Suggestions and bugs:** [open an issue on GitHub](https://github.com/vanturis/forge/issues/new/choose),
  in English or German. For bugs, the FORGE version and the details from Settings > About FORGE > Diagnostics help.
- **Security vulnerabilities:** please do not report them as an issue. Follow [SECURITY.md](SECURITY.md) instead.
- **Contributing:** contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

FORGE is an open source product of [Vanturis UG (haftungsbeschränkt)](https://vanturis.de), licensed under the
[GNU Affero General Public License, version 3](LICENSE.md) (AGPL-3.0-only).

- Use, modification and distribution are free, also for work and in companies.
- If you distribute a modified version or offer it as a service over a network, you must publish its source code
  under the AGPL.
- An additional permission under section 7 of the AGPL covers the combination with the Claude Agent SDK and
  Claude Code by Anthropic, see [NOTICE](NOTICE).
- A commercial license without the obligations of the AGPL is available from [Vanturis](https://vanturis.de).

Bundled third-party software and its licenses: [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Development

FORGE is a pnpm monorepo:

| Folder | Contents |
|---|---|
| `apps/desktop` | Tauri app (Rust) with a React interface |
| `apps/installer` | FORGE Setup: online installer that downloads the newest version from GitHub (Tauri, standalone) |
| `packages/sidecar` | Node process that controls Claude Code, Git, phone and database |
| `packages/protocol` | shared types and RPC methods (Zod) |
| `services/stats` | statistics service behind forge.vanturis.de (Next.js, standalone) |

<details>
<summary>Tools and commands</summary>

| Tool | Version |
|---|---|
| Node.js | 22.13 or newer |
| pnpm | 10.x |
| Rust and Cargo | stable (MSVC on Windows) |
| Visual Studio Build Tools | 2022, workload "C++ Build Tools" (Windows only) |

On macOS you need the Xcode Command Line Tools, on Linux the system libraries from
`.github/workflows/ci.yml` (WebKitGTK 4.1 and others). On Windows:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
winget install Rustlang.Rustup
```

```bash
pnpm install
pnpm dev              # builds the sidecar and starts the app (Tauri dev)
pnpm lint             # ESLint across all packages
pnpm typecheck        # TypeScript strict for protocol, sidecar and desktop
pnpm test             # unit and integration tests without real Claude calls
pnpm test:e2e         # E2E with a real Claude session (uses a little of your subscription quota)
pnpm build            # release with installer (downloads the bundled runtime the first time)
pnpm prepare:runtime  # only prepare the bundled runtime
pnpm notices          # regenerate THIRD_PARTY_NOTICES.md (after changing dependencies)
```

Environment variables for special cases: `FORGE_NODE` (path to node), `FORGE_SIDECAR` (path to `sidecar.mjs`),
`FORGE_DATA_DIR` (data folder), `FORGE_E2E=0` (skip E2E), `FORGE_E2E_MODEL` (model for E2E).

`.github/workflows/release.yml` builds a release every night when `main` changed (Windows first, then macOS and
Linux, see [ADR 0014](docs/adr/0014-macos-and-linux.md)). `.github/workflows/ci.yml` runs types and tests on all
three systems for pull requests.
</details>

More documentation: [Architecture](docs/ARCHITECTURE.md) · [Security concept](docs/SECURITY.md) ·
[Tests](docs/TESTING.md) · [Architecture decisions](docs/adr) · project knowledge in `.forge/knowledge/`

---

<p align="center">
  <sub>A product of <a href="https://vanturis.de">Vanturis UG (haftungsbeschränkt)</a> · <a href="https://vanturis.de/impressum">Imprint</a> · <a href="https://vanturis.de/datenschutz">Privacy policy</a></sub><br>
  <sub>FORGE is an independent project and not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic, PBC.</sub>
</p>

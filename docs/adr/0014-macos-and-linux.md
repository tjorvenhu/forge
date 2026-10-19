<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0014-macos-und-linux.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0014: FORGE for macOS and Linux

Date: 2026-10-19 · Status: accepted

## Goal

FORGE also ships for macOS (Apple silicon and Intel) and Linux (x64). The Windows release stays exactly as it
is: same jobs, same files, same signatures.

## Decisions

**Platforms.** Each platform has a fixed tag: `win32-x64` (Windows, as before), `darwin-arm64`, `darwin-x64`
and `linux-x64`. FORGE does not build other combinations (Linux on ARM, Windows on ARM).

**What is bundled.** As on Windows, `scripts/prepare-runtime.mjs` puts everything into
`apps/desktop/src-tauri/runtime/`, and Tauri bundles the folder as a resource.

| | Windows | macOS and Linux |
|---|---|---|
| Node.js 24.21.0 | `node.exe` only | the whole official folder (`node/bin/node`, npm, npx) |
| GitHub CLI 2.102.0 | `gh/bin/gh.exe` | the official archive without man pages (`gh/bin/gh`) |
| Git | PortableGit | no, from the system |
| Python | NuGet package | no, from the system |
| Sidecar | `sidecar/sidecar.mjs` | `sidecar/sidecar.mjs` |

Every archive is pinned with version and SHA-256 (Node from `SHASUMS256.txt`, gh from `gh_<v>_checksums.txt`).
On macOS and Linux the executable bits are kept. In the archive npm, npx and corepack are symbolic links.
Tauri copies resources file by file and resolves links on the way, so the script replaces these three links
with small shell scripts. Afterwards the folder must not contain any links, otherwise the script stops.

**Why no Git and no Python on macOS and Linux.** On Windows both are often missing, and Claude Code does not
run there without Git Bash. On macOS, `git` and `python3` come with the Xcode Command Line Tools: the first
call offers to install them. On Linux both belong to the distribution's package manager. Own copies would be
large. They would have to be built for each system, and Python would need other ways for pip and venv than on
Windows. Node and gh stay, because the sidecar needs Node and FORGE relies on gh for the GitHub sign-in.

**Runtime key.** Windows: unchanged `node-<v>_git-<v>_gh-<v>_python-<v>`. macOS and Linux:
`<tag>_node-<v>_gh-<v>`, for example `darwin-arm64_node-24.21.0_gh-2.102.0`. `prepare-runtime.mjs --key`
prints it for the machine, `--target <tag>` for another architecture of the same system. `VERSIONS.json` has
the same form as on Windows, only without `git` and `python`.

**Release files.** `release.yml` keeps the jobs `changes` and `release` (Windows). After them, the jobs
`macos` (matrix: `aarch64-apple-darwin` and `x86_64-apple-darwin`, both on the arm64 runner) and `linux`
(`ubuntu-22.04`, so the AppImage also runs with an older glibc) build the same version and add their files to
the same release with `gh release upload --clobber`:

- `FORGE_<v>_darwin-arm64.app.tar.gz` and `FORGE_<v>_darwin-x64.app.tar.gz`: `FORGE.app` as the top-level
  folder, for updates inside the app.
- `FORGE_<v>_darwin-arm64.dmg` and `FORGE_<v>_darwin-x64.dmg`: for new installations.
- `FORGE_<v>_linux-x64.AppImage` and `FORGE_<v>_linux-x64.deb`.
- `FORGE_<v>_<tag>.sig`: the signatures of that platform's files, in the same JSON format as `FORGE_<v>.sig`
  (`sign-update.mjs --manifest`, secret `FORGE_UPDATE_SIGNING_KEY`). It is uploaded last, so the app never
  offers a half-uploaded file.

No `.sig` per file and no `.runtime` marker: those forms exist only for Windows installations up to 0.1.101.
Every run builds macOS and Linux completely, nightly too. There are no small updates with only app and sidecar
on these systems. A failure in these jobs changes nothing about the Windows release.

**Updates.** The app only offers files with a valid signature. On macOS and Linux it takes the newest release
that has a file for its platform. So a release may have only Windows files for a while, or for good if the
macOS or Linux job fails.

| Installation | Update |
|---|---|
| Windows (NSIS) | as before: update zip or installer |
| macOS `.app` | downloads `.app.tar.gz`, replaces `FORGE.app` and restarts |
| Linux AppImage | downloads the new AppImage and replaces the file |
| Linux `.deb` | reports the new version, installing goes through the package manager |

**Signing on macOS.** Without an Apple developer account there is no notarization. The app is only signed ad
hoc (`signingIdentity: "-"`), so that it starts on Apple silicon at all. Gatekeeper blocks the first start.
Users open FORGE once with right-click > Open, from macOS 15 on through System Settings > Privacy & Security >
Open Anyway, or with `xattr -dr com.apple.quarantine /Applications/FORGE.app`. The release job checks the
signature with `codesign --verify --deep`. Files FORGE downloads itself for an update get no quarantine flag,
so updates do not need this step.

**Windows only.** The online installer `FORGE-Setup.exe` (`setup.yml`), the Authenticode signature through
Azure Artifact Signing, the small update zips and the NSIS installer.

## Consequences

- Three more release jobs. A release is complete only after the slowest one. Until then macOS and Linux find
  the previous release.
- Without notarization the first start on macOS stays awkward. An Apple developer account would solve that.
- On macOS and Linux FORGE depends on the system's `git` and `python3`.
- `.github/workflows/ci.yml` checks types and tests on Windows, macOS and Linux, for pull requests and by hand.
- New versions of Node or gh: enter them in `prepare-runtime.mjs` for all four platforms.
  `node scripts/prepare-runtime.mjs --check-hashes` downloads and verifies every archive on any system.

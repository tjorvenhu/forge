---
title: "macOS und Linux: Plattform-Vertrag, Laufzeit, Updates, install.sh, Prüfen ohne Mac (FORGE_PLATFORM, Cross-Check)"
summary: "Wie FORGE auf macOS und Linux läuft (seit 2026-10-19): Plattform-Tags, Laufzeit-Layout, Release-Assets, Update-Wege, Online-Installer install.sh und /download, was nur Windows kann, und wie man macOS- und Linux-Builds von Windows aus prüft."
tags: ["release","tauri","sidecar","update","installer","stolperfalle"]
updated: "2026-10-20T08:32:03.642Z"
---

# macOS und Linux (seit 2026-10-19)

Entscheidungen in `docs/adr/0014-macos-und-linux.de.md`. Windows blieb dabei absichtlich unverändert (gleiche Assets, gleicher Laufzeit-Schlüssel, gleicher Update-Weg).

## Vertrag zwischen Rust, Sidecar, Frontend und Release
- Plattform-Tags: `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`. Rust gibt dem Sidecar `FORGE_PLATFORM` und `FORGE_INSTALL_KIND` (`nsis`, `app`, `appimage`, `system` für .deb, `dev`) mit; Sidecar: `packages/sidecar/src/util/platform.ts`. Frontend erkennt die Plattform selbst am User-Agent: `apps/desktop/src/lib/platform.ts` (`isMac`, `byPlatform`, `hasPrimaryModifier`, `formatShortcuts`).
- Kürzel-Texte: `withPlatformShortcuts` in `i18n/index.ts` macht auf dem Mac aus „Strg+K“ in allen Texten „⌘K“ (auch Rückgaben von Text-Funktionen). Neue Texte also einfach mit „Strg+…“/„Ctrl+…“ schreiben.
- Laufzeit unter macOS/Linux: `runtime/node/bin/node` (ganze Node-Distribution), `runtime/gh/bin/gh`, `runtime/sidecar/sidecar.mjs`, `VERSIONS.json`. **Kein git und kein Python**: die kommen vom System (Hinweis im Setup). Schlüssel `<tag>_node-<v>_gh-<v>`. `scripts/prepare-runtime.mjs --target <tag>`, `--check-hashes` prüft nur die gepinnten SHA-256.
- **macOS ab 13.5** (`minimumSystemVersion` in `tauri.macos.conf.json`): das mitgelieferte Node.js 24 läuft erst ab 13.5.
- Release-Assets (Jobs `macos` und `linux` in `release.yml`, laufen nach dem Windows-Job und hängen ihre Dateien an dessen Release): `FORGE_<v>_darwin-*.app.tar.gz` (In-App-Update), `.dmg`, `FORGE_<v>_linux-x64.AppImage` (Installation und Update), `.deb` (nur Hinweis auf neue Version), Signaturen `FORGE_<v>_<tag>.sig`. Die App nimmt das neueste Release **mit** ihrem Asset; ein fehlgeschlagener Mac-Job berührt Windows nicht.
- Update anwenden: `apps/desktop/src-tauri/src/update/unix.rs` (sh-Skript mit Rollback; macOS tauscht `FORGE.app`, entfernt die Quarantäne, `open -n`; Linux ersetzt `$APPIMAGE` atomar).
- Nur Windows: Online-Installer FORGE-Setup.exe, Authenticode, „FORGE ist nicht vollständig installiert“/setup.exe-Reparatur, DPAPI (macOS: AES-Schlüssel im Schlüsselbund, Linux: `secret-tool` oder Schlüsseldatei 0600).
- Prozesse: Unix nutzt Prozessgruppen statt Job Objects (`job.rs`, Sidecar `killTree` mit `detached` + `process.kill(-pid)`). macOS-Apps aus dem Finder haben einen Minimal-PATH: `shell_env.rs` übernimmt beim Start PATH der Login-Shell.
- Screenshots: macOS mit `xcap`; Linux **ohne xcap** über `org.freedesktop.portal.Screenshot` (zbus), Rückfall auf grim/gnome-screenshot/spectacle/maim/scrot/import. Grund: xcaps PipeWire-Bindings (libspa 0.10) brauchen neuere Header als Ubuntu 22.04, und auf 22.04 wird die AppImage wegen glibc 2.35 gebaut.

## Online-Installer für macOS und Linux (Wunsch des Besitzers 2026-10-20: „immer derselbe Installer, wegen Codesign“)
- `scripts/install.sh`, Aufruf `curl -fsSL https://forge.vanturis.de/install.sh | sh`. Entscheidung: Skript statt Installer-App, weil eine heruntergeladene App auf dem Mac ohne Apple-Entwicklerkonto von Gatekeeper blockiert wird; per curl geladen hat nichts die Quarantäne-Markierung. Das Skript sucht das neueste Release mit Asset für das System (GitHub-API ist eingerückt, awk liest `digest` vor `browser_download_url`), prüft die **SHA-256 aus dem GitHub-`digest`** (Ed25519 geht in sh nicht: LibreSSL auf dem Mac kann es nicht), installiert macOS nach `/Applications` (sonst `~/Applications`), Linux als `~/.local/bin/forge` mit `.desktop`-Eintrag (ohne libfuse2: `APPIMAGE_EXTRACT_AND_RUN=1`). `FORGE_VERSION`, `FORGE_INSTALL_DIR` zum Testen.
- Website: `/download` (`services/stats/src/app/download/page.tsx`) leitet Windows (Client-Hint `sec-ch-ua-platform` oder User-Agent) direkt auf FORGE-Setup.exe um, sonst Reiter Windows/macOS/Linux mit Befehl und Dateien des neuesten Releases (`lib/builds.ts`, 15 min Cache; „noch keine Version“, solange es keine gibt). `?os=windows|macos|linux` zeigt die Seite ohne Umleitung. `/install.sh` leitet auf `raw.githubusercontent.com/.../main/scripts/install.sh` um: Änderungen am Skript brauchen kein neues Deploy der Website. README-Download zeigt auf `https://forge.vanturis.de/download` (funktioniert erst nach Coolify-Deploy der Website).

## Prüfen ohne Mac und ohne Linux
- **macOS-Cross-Check von Windows:** `rustup target add aarch64-apple-darwin`, dann in `apps/desktop/src-tauri`: `CC_aarch64_apple_darwin=<abs>\cc.cmd AR_aarch64_apple_darwin=<abs>\ar.cmd TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo check --lib --tests --target aarch64-apple-darwin`. `objc2-exception-helper` braucht sonst einen C-Compiler; der Schein-Compiler liegt gitignored unter `apps/desktop/src-tauri/target/fakecc/` (`cc.cmd`/`ar.cmd` rufen Node-Skripte, die nur leere Ausgabedateien schreiben; bei `ar` eine `.a` mit `!<arch>\n`). Fehlt er nach `cargo clean`: neu anlegen.
- **Linux-Cross-Check von Windows:** zusätzlich Schein-`pkg-config.cmd` im selben Ordner (Node-Skript: `--modversion` → `99.0.0`, sonst leere Ausgabe): `PKG_CONFIG=<abs>\pkg-config.cmd PKG_CONFIG_ALLOW_CROSS=1 CC_x86_64_unknown_linux_gnu=<abs>\cc.cmd AR_x86_64_unknown_linux_gnu=<abs>\ar.cmd TAURI_CONFIG=... cargo check --lib --tests --target x86_64-unknown-linux-gnu`. Findet Typ- und cfg-Fehler; Crates mit bindgen gegen echte Header (wie libspa) prüft nur CI.
- **CI:** `.github/workflows/ci.yml` (Windows, macOS, Ubuntu 22.04; nur `workflow_dispatch` und Pull Requests): `gh workflow run ci.yml -R vanturis/forge --ref main`. Erster grüner Lauf auf allen drei: 2026-10-20 (Run 39392982305). Logs gibt es erst nach Ende des ganzen Laufs (`gh run view <id> --log-failed`).
- Workflow-YAML prüfen: `pnpm dlx js-yaml .github/workflows/release.yml`.

## Stolperfallen aus den ersten CI-Läufen
- Windows-Runner: TEMP enthält den 8.3-Kurznamen (`C:\Users\RUNNER~1\...`), Projektpfade sind kanonisch lang. `folderDeleteBlocker` vergleicht deshalb mit `os.tmpdir()` **und** `realpathSync.native(os.tmpdir())`; betrifft auch Nutzer mit langem Benutzernamen.
- Ubuntu: Der allererste Browserstart (Edge) reißt die 20-s-Grenze; die Vorschau versucht es mit Wegwerf-Profil ein zweites Mal und prüft den Dev-Server, bevor ein Browser startet.
- Tests mit Windows-Annahmen (`open.cmd`, WSL-Pfad `/mnt/...`, Groß/Klein bei Duplikaten) laufen je Plattform.

## Offen (Stand 2026-10-20)
Der erste Release mit macOS/Linux-Assets steht noch aus (nächster Lauf von `release.yml`); dmg, AppImage, In-App-Update und install.sh sind auf echter Hardware ungetestet. Hero-Text der Website nennt noch „Windows 10/11“.

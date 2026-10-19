---
title: "macOS und Linux: Plattform-Vertrag, Laufzeit, Updates, Prüfen ohne Mac (FORGE_PLATFORM, FORGE_INSTALL_KIND, Cross-Check)"
summary: "Wie FORGE auf macOS und Linux läuft (seit 2026-10-19): Plattform-Tags, Laufzeit-Layout, Release-Assets, Update-Wege, was nur Windows kann, und wie man den macOS-Build von Windows aus prüft."
tags: ["release","tauri","sidecar","update","stolperfalle"]
updated: "2026-10-19T18:36:54.258Z"
---

# macOS und Linux (seit 2026-10-19)

Entscheidungen in `docs/adr/0014-macos-und-linux.de.md`. Windows blieb dabei absichtlich unverändert (gleiche Assets, gleicher Laufzeit-Schlüssel, gleicher Update-Weg).

## Vertrag zwischen Rust, Sidecar, Frontend und Release
- Plattform-Tags: `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`. Rust gibt dem Sidecar `FORGE_PLATFORM` und `FORGE_INSTALL_KIND` (`nsis`, `app`, `appimage`, `system` für .deb, `dev`) mit; Sidecar: `packages/sidecar/src/util/platform.ts`. Frontend erkennt die Plattform selbst am User-Agent: `apps/desktop/src/lib/platform.ts` (`isMac`, `byPlatform`, `hasPrimaryModifier`, `formatShortcuts`).
- Kürzel-Texte: `withPlatformShortcuts` in `i18n/index.ts` macht auf dem Mac aus „Strg+K“ in allen Texten „⌘K“ (auch Rückgaben von Text-Funktionen). Neue Texte also einfach mit „Strg+…“/„Ctrl+…“ schreiben.
- Laufzeit unter macOS/Linux: `runtime/node/bin/node` (ganze Node-Distribution), `runtime/gh/bin/gh`, `runtime/sidecar/sidecar.mjs`, `VERSIONS.json`. **Kein git und kein Python**: die kommen vom System (Hinweis im Setup). Schlüssel `<tag>_node-<v>_gh-<v>`. `scripts/prepare-runtime.mjs --target <tag>`, `--check-hashes` prüft nur die gepinnten SHA-256.
- Release-Assets (Jobs `macos` und `linux` in `release.yml`, laufen nach dem Windows-Job und hängen ihre Dateien an dessen Release): `FORGE_<v>_darwin-*.app.tar.gz` (In-App-Update), `.dmg`, `FORGE_<v>_linux-x64.AppImage` (Installation und Update), `.deb` (nur Hinweis auf neue Version), Signaturen `FORGE_<v>_<tag>.sig`. Die App nimmt das neueste Release **mit** ihrem Asset; ein fehlgeschlagener Mac-Job berührt Windows nicht.
- Update anwenden: `apps/desktop/src-tauri/src/update/unix.rs` (sh-Skript mit Rollback; macOS tauscht `FORGE.app`, entfernt die Quarantäne, `open -n`; Linux ersetzt `$APPIMAGE` atomar).
- macOS ist nur ad hoc signiert (kein Apple-Konto): beim ersten Start Rechtsklick > Öffnen oder `xattr -dr com.apple.quarantine`.
- Nur Windows: Online-Installer FORGE-Setup.exe, Authenticode, „FORGE ist nicht vollständig installiert“/setup.exe-Reparatur, DPAPI (macOS: AES-Schlüssel im Schlüsselbund, Linux: `secret-tool` oder Schlüsseldatei 0600).
- Prozesse: Unix nutzt Prozessgruppen statt Job Objects (`job.rs`, Sidecar `killTree` mit `detached` + `process.kill(-pid)`). macOS-Apps aus dem Finder haben einen Minimal-PATH: `shell_env.rs` übernimmt beim Start PATH der Login-Shell.

## Prüfen ohne Mac und ohne Linux
- **macOS-Cross-Check von Windows:** `rustup target add aarch64-apple-darwin`, dann in `apps/desktop/src-tauri`: `CC_aarch64_apple_darwin=<abs>\cc.cmd AR_aarch64_apple_darwin=<abs>\ar.cmd TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo check --lib --tests --target aarch64-apple-darwin`. `objc2-exception-helper` braucht sonst einen C-Compiler; der Schein-Compiler (`cc.cmd`/`ar.cmd` rufen ein Node-Skript, das nur leere Ausgabedateien schreibt) liegt gitignored unter `apps/desktop/src-tauri/target/fakecc/`. Fehlt er (z. B. nach `cargo clean`), neu anlegen: Skript schreibt bei `-o <datei>` eine leere Datei, bei `ar` eine `.a` mit `!<arch>\n`. Linken geht so nicht, `check` reicht.
- **Linux** lässt sich so nicht prüfen (gtk/webkit/pipewire-sys brauchen echte Header): nur über `.github/workflows/ci.yml` (Windows, macOS, Ubuntu 22.04; Trigger nur `workflow_dispatch` und Pull Requests, nicht Push). `gh workflow run ci.yml -R vanturis/forge --ref <branch>`.
- Workflow-YAML prüfen: `pnpm dlx js-yaml .github/workflows/release.yml` (kein yaml-Paket im Repo).

## Offen (Stand 2026-10-19)
Noch kein echter Build auf macOS/Linux gelaufen; erst nach dem ersten CI-Lauf ist klar, ob AppImage (xcap/pipewire-Abhängigkeiten), dmg und die Updates funktionieren. Website (`services/stats`) und Hero-Text nennen noch „Windows 10/11“; erst ändern, wenn es echte Mac/Linux-Downloads gibt.

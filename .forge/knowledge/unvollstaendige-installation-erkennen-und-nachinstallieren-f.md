---
title: "Unvollständige Installation erkennen und nachinstallieren (FullInstallService, FORGE_RUNTIME_KEY)"
summary: "Wie FORGE eine fehlende oder veraltete mitgelieferte Laufzeit (node, git, gh, python) erkennt und den passenden vollen Installer wie ein Update installiert; wichtig bei Änderungen an der Laufzeit, am Release-Workflow oder am Update-Ablauf."
tags: ["update","installer","sidecar","tauri","telefon","stolperfalle"]
updated: "2026-10-17T21:03:03.439Z"
---

Anlass (2026-10-17): Ein Nutzer hat auf einem neuen Rechner das Update-Zip statt der setup.exe genommen; git und gh fehlten, nur der Einrichtungsassistent meckerte bei GitHub. Außerdem brauchen Installationen mit älterer Laufzeit (anderer Schlüssel, seit Python im Schlüssel steht: alle älteren) einmal den vollen Installer.

## Erwartete Laufzeit
- release.yml setzt im Schritt „Build app“ `FORGE_RUNTIME_KEY` (aus `node scripts/prepare-runtime.mjs --key`, Format `node-<v>_git-<v>_gh-<v>_python-<v>`). Rust bettet ihn per `option_env!` ein (`update::expected_runtime()`), `sidecar.rs` gibt ihn **nur im Release-Build** als `FORGE_RUNTIME_EXPECTED` an den Sidecar (leer, wenn ein lokaler Release-Build ihn nicht kennt). Ist die Variable nicht gesetzt (Dev-Modus), prüft FORGE nichts.
- Ein lokaler Build ohne die Variable kennt keinen Schlüssel: dann wird nur geprüft, ob node/git/gh da sind.

## Prüfung (packages/sidecar/src/update/full-install.ts)
- `checkRuntime(dir, expected)` zerlegt den Schlüssel (`name-version_name-version…`) und verlangt für **jedes genannte Werkzeug** das Programm (`TOOL_FILES`: node/node.exe, git/cmd/git.exe, gh/bin/gh.exe, python/python.exe; unbekannte Werkzeuge: der Ordner mit ihrem Namen) und dieselbe Version in `VERSIONS.json`. Ein weiteres Werkzeug im Schlüssel zählt dadurch ohne Codeänderung; Pfad und Anzeigename in `TOOL_FILES`/`TOOL_LABELS` ergänzen.
- Hängt nicht an `installedRuntimeKey` (app-update.ts), außer der Schlüssel hat ein unbekanntes Format.
- Startet der Sidecar gar nicht (node fehlt), fragt der Startbildschirm in App.tsx den Rust-Befehl `install_check` (`update::runtime_gaps`, gleiche Pfade) und verweist auf die Release-Seite.

## Reparatur
- `pickInstaller(releases, key)` (app-update.ts): neuestes Release mit einem signierten Installer für den Schlüssel, egal welche Version (der Installer liegt meist an einem älteren Release). Den Schlüssel liefert die Markierung `FORGE_<v>_x64-setup.<key>.runtime` oder bei älteren Releases der Installer-Name (siehe Eintrag zum Release-Workflow). Ist das kleine Update für diesen Schlüssel neuer, schreibt der Download die Kette (`forge-update-chain.json`), und `AppUpdateService` installiert es nach dem Neustart ohne Rückfrage.
- Releases kommen anonym per HTTPS (`GitHubReleases`), mit gh-Token nur, wenn GitHub ablehnt. Findet FORGE dort nichts, sucht es im Downloads-Ordner nach einer setup.exe, die passen kann; sonst „setup.exe auswählen“ (`app.useLocalInstaller`). Beides über `localInstallerFits`: langer Name muss den Schlüssel haben, kurzer Name ab 0.1.8 wird angenommen (eine falsche Laufzeit fällt nach der Installation auf), kurze Namen bis 0.1.7 sind alt.
- Download in den Unterordner `full` des Update-Ordners im Temp-Verzeichnis (`FULL_DIR`, den der Update-Download nicht löscht). Prüfung: Signatur (`fetchSigned`), SHA-256 (`digest`), Größe laut GitHub, „MZ“-Kopf, mindestens 1 MB. Fortschritt per Ordnergröße alle 500 ms (`received`). Eine selbst gewählte setup.exe wird nicht auf Signatur geprüft.
- Installieren: `installFull(qc)` in `lib/app-install.ts`, gleicher Weg wie `installUpdate` (`runInstaller`: Download, `app.prepareInstall`, `invoke("install_update")`).
- NSIS-Aufruf (update.rs): `/P /UPDATE /R /D=<Ordner der laufenden exe>`. `/D=` muss zuletzt und **ohne Anführungszeichen** kommen (NSIS nimmt den Rest der Zeile), darum `raw_arg`. Im Tauri-Template setzt `/D=` `$INSTDIR` vor `.onInit`, der Registry-Ordner wird dann nicht genommen; `/R` startet FORGE nur im passiven oder stillen Modus neu (`.onInstSuccess`). Im Dev-Build kein `/D=`. update.rs erkennt Installer nur an der Endung `-setup.exe`.

## Normaler Update-Weg
`pickRelease` nimmt bei fremder Laufzeit zuerst einen Installer für den Schlüssel des kleinen Updates des neuesten Releases (auch aus älteren Releases), dann wie früher irgendeinen neueren Installer. Gibt es neuere Releases, aber nichts Installierbares, sagt `check()` das in `message` statt still „aktuell“.

## Oberfläche, Telefon, Suche
- Banner oben im Hauptbereich (`InstallRepairBanner`, „Später“ blendet bis zum nächsten Start aus), Karte „Installation“ in Einstellungen, Über FORGE, Palette (`install-check`, `install-full`, `install-file`), Rechtsklick auf Banner und Karte.
- Telefon: `forge_system` `install_check`, `install_repair` (nur nach Tastatur-Code, weil der Neustart das Gespräch beendet; ruft `app.repairInstall`, das Ereignis `install.repair` startet `installFull` im Hauptfenster).
- Tests: `packages/sidecar/test/full-install.test.ts`, `InstallRepair.test.tsx`, Rust `update::tests`. `cargo test` in einem frischen Worktree braucht den gitignorten Ordner runtime neben Cargo.toml (Platzhalter `runtime/sidecar/sidecar.mjs` darin) und `apps/desktop/dist`, sonst bricht tauri-build ab.

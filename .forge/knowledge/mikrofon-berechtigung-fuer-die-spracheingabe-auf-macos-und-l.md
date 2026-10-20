---
title: "Mikrofon-Berechtigung für die Spracheingabe auf macOS und Linux (Entitlements.plist, mic.rs, tccutil)"
summary: "Warum das Diktat auf macOS ohne Anfrage „Zugriff verweigert“ meldete (Hardened Runtime ohne audio-input-Entitlement), wie FORGE macOS erneut fragen lässt und warum Linux einen eigenen Berechtigungs-Handler braucht."
tags: ["diktat","tauri","stolperfalle","release","composer"]
updated: "2026-10-20T10:47:48.960Z"
---

Stand 2026-10-20.

## macOS
- Tauri signiert die App standardmäßig mit **Hardened Runtime** (`codesign -dv /Applications/FORGE.app` zeigt `flags=...(adhoc,runtime)`). Ohne Entitlement `com.apple.security.device.audio-input` verweigert macOS das Mikrofon **still**: keine Systemanfrage, getUserMedia wirft `NotAllowedError`. `NSMicrophoneUsageDescription` in `Info.plist` allein reicht nicht.
- Lösung: `apps/desktop/src-tauri/Entitlements.plist`, eingebunden über `bundle.macOS.entitlements` in `tauri.macos.conf.json`. Prüfen: `codesign -d --entitlements - /Applications/FORGE.app`.
- macOS fragt pro App nur einmal. `src-tauri/src/mic.rs` (`mic_access`, `mic_settings`): AVFoundation-Status abfragen, bei „nicht entschieden“ selbst fragen (`requestAccessForMediaType`), bei `ask_again` erst `tccutil reset Microphone <identifier>` (nur FORGEs eigener Eintrag), dann erneut fragen. Frontend: `useDictation.ts` fragt auf dem Mac vor getUserMedia `micAccess()`; bei Ablehnung Toast mit Knopf „Zugriff anfragen“, und wenn macOS weiter Nein sagt, öffnet sich die Mikrofon-Seite der Systemeinstellungen.
- Ad-hoc-Signatur: Die TCC-Einträge hängen am cdhash. Nach Updates kann macOS deshalb wieder fragen.
- `RcBlock` und `&AVMediaType` sind nicht Send: in async-Commands vor dem `await` fallen lassen (eigener Block-Scope).

## Linux
- WebKitGTK lehnt jede Medienanfrage ab, die niemand beantwortet, und wry hängt nur einen Handler an, wenn einer gesetzt ist. `mic::allow_in` hängt sich per `with_webview` an `permission-request` und erlaubt nur Audio (kein Video, kein Bildschirm). Wird für das Hauptfenster in `setup` und für jedes Chat-Fenster nach `build()` aufgerufen. Der Linux-Pfad ist nur per Cross-Check kompiliert und noch nicht auf echter Hardware getestet.

## Prüfen auf dem Mac
Rust per rustup (`~/.cargo/bin`). `TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo check --lib` in `src-tauri`. Linux-Cross-Check auf dem Mac: `rustup target add x86_64-unknown-linux-gnu`, Schein-`cc`/`ar`/`pkg-config` als sh-Skripte in `target/fakecc/` (cc legt nur die `-o`-Datei an, ar schreibt `!<arch>\n`, pkg-config antwortet auf `--modversion` mit `99.0.0`), dann `PKG_CONFIG=... PKG_CONFIG_ALLOW_CROSS=1 CC_x86_64_unknown_linux_gnu=... AR_x86_64_unknown_linux_gnu=... cargo check --lib --target x86_64-unknown-linux-gnu`.

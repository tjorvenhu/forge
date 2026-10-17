# ADR 0013: Updates über GitHub-Releases

Datum: 2026-10-12 · Status: angenommen

## Ziel

Neue Versionen ohne manuelles Neuinstallieren: Sobald auf GitHub ein Update liegt, bietet FORGE es an.

## Entscheidungen

**Bauen:** `.github/workflows/release.yml` läuft bei jedem Push auf `main` (nicht bei reinen Doku-Änderungen) auf
`windows-latest`: Version `0.1.<run_number>` in `tauri.conf.json`, Lint und Typecheck, Sidecar und Frontend
(einmal, `beforeBuildCommand` leer über `tauri.ci.json`), dann `gh release create v0.1.<n>` mit den
Commit-Betreffs seit dem letzten Tag als Notizen. Ein neuerer Push bricht einen laufenden Build ab.

**Zwei Arten von Releases** (Nachtrag 2026-10-12, vorher dauerte jeder Build 9,5 Minuten): node, git und gh sind
476 MB und ändern sich fast nie; allein das LZMA-Packen im NSIS-Installer kostete 2 Minuten.

- `FORGE_<v>_update_<laufzeit>.zip` bei jedem Release: nur `forge-desktop.exe`, `runtime/sidecar/sidecar.mjs`
  und `update.json`, etwa 4 MB. Gebaut mit `tauri build --no-bundle`, ohne Laufzeit-Download und ohne NSIS.
- `FORGE_<v>_<laufzeit>_x64-setup.exe` nur, wenn es für den Laufzeit-Schlüssel noch keinen Installer gibt (neue
  node-, git-, gh- oder Python-Version in `scripts/prepare-runtime.mjs`) oder auf Wunsch (Run workflow → full).

Der Laufzeit-Schlüssel ist `node-<v>_git-<v>_gh-<v>_python-<v>` (`prepare-runtime.mjs --key`, Python seit 2026-10-17); die installierte App liest
ihn aus `runtime/VERSIONS.json`. Rust baut mit Thin-LTO statt vollem LTO (eine Minute schneller, kaum größer),
die Toolchain wird nicht mehr aktualisiert. „Latest“ auf GitHub bleibt beim neuesten vollen Installer
(`--latest=false` für die anderen): Download für Neuinstallationen, und ältere FORGE-Versionen, die nur
`releases/latest` lesen, finden dort immer einen Installer.
Unit-Tests laufen dort nicht: zwei Tests scheitern unter Windows an verzögert gelöschten Dateien.

**Prüfen und Laden** (`packages/sidecar/src/update/app-update.ts`, `github-releases.ts`; Nachtrag 2026-10-17,
vorher über `gh` mit der Anmeldung des Nutzers, solange das Repository privat war): direkt per HTTPS an die
GitHub-API (`/repos/tjorvenhu/forge/releases`, `/compare`, Dateien über die API-Adresse des Assets mit
`Accept: application/octet-stream`). Zuerst anonym, damit Updates ohne GitHub-Konto gehen. Nur wenn GitHub ablehnt
(401/403/404/429: privates Repository oder Ratenlimit von 60 Anfragen pro Stunde und IP), ein zweiter Versuch mit dem
Token der gh-Anmeldung (`gh auth token`), falls es eine gibt.
Erste Prüfung kurz nach dem Start, dann alle 30 Minuten (Einstellung `updateChecks`), nur in der Desktop-App
(`FORGE_APP_VERSION` gesetzt). Der Installer landet in `%TEMP%\forge-update` und wird gegen den SHA-256 geprüft,
den GitHub für die Datei meldet (`digest`), und immer gegen seine Signatur (siehe unten); bei Abweichung verworfen. Auswahl (`pickRelease`): Hat das neueste
Release ein kleines Update für den installierten Laufzeit-Schlüssel, wird es genommen; sonst der neueste volle
Installer. Danach folgen wieder kleine Updates. Die Oberfläche zeigt Art und Größe.

**Installieren** (Rust-Befehl `install_update`, `src-tauri/src/update.rs`): nur Dateien aus
`%TEMP%\forge-update`. `*-setup.exe` wie unten. `*_update_*.zip` wird mit `tar.exe` nach `staged` entpackt
und darf genau die drei erwarteten Dateien enthalten; die Version in `update.json` nur Ziffern und Punkte. Ein
PowerShell-Skript (außerhalb des Job-Objekts gestartet) wartet, bis FORGE beendet ist, benennt die alten Dateien
in `.forge-old` um, kopiert die neuen, stellt bei einem Fehler die alten wieder her, setzt `DisplayVersion` im
Uninstall-Eintrag und startet FORGE neu. Protokoll: `%TEMP%\forge-update\apply-update.log`. Der Installer:
Die Hülle beendet Terminals und Sidecar sauber (offene Sessions werden wie beim Schließen unterbrochen und lassen
sich fortsetzen), startet den Installer selbst mit `/P /UPDATE /R` (ohne Rückfragen, Einstellungen bleiben,
FORGE startet danach neu) und beendet sich. Nicht der Sidecar startet ihn: dessen Job-Objekt würde den Installer
beim Beenden von FORGE mit beenden.

**Signatur (Nachtrag 2026-10-17, mit der Veröffentlichung):** Jedes Release-Asset hat daneben `<asset>.sig`:
Ed25519 über `FORGE-UPDATE-1\n<Dateiname>\n<sha256 hex>` (`scripts/sign-update.mjs`, base64). Der Name in der
Nachricht bindet die Signatur an Version und Laufzeit. Privater Schlüssel: Secret `FORGE_UPDATE_SIGNING_KEY` im
Repository (PEM, PKCS8), ohne ihn bricht der Workflow schon im Schritt Plan ab. Öffentlicher Schlüssel fest in
`packages/sidecar/src/update/signature.ts`. Die App bietet nur Assets mit `.sig` an (`signedOnly`), ältere
unsignierte Releases sind damit unsichtbar. Deshalb zählt im Workflow nur ein signierter Installer als vorhanden:
Das erste Release nach der Umstellung baut den vollen Installer neu. Ein neuer Schlüssel heißt: neuen öffentlichen
Schlüssel in `signature.ts`, Secret ersetzen; installierte Versionen mit dem alten Schlüssel nehmen danach nur noch
den Installer von Hand. Ein Installer, den der Nutzer selbst auswählt (Downloads-Ordner), wird nicht geprüft: Den
startet er auch so. Code-Signing (SmartScreen) fehlt weiterhin.

## Nachtrag 2026-10-13: Sessions überstehen das Update

Ziel: Ein Update soll laufende Claude-Sessions nicht schließen und nicht anhalten.

**Warum die Claude-Prozesse nicht durchlaufen:** Jede Session ist ein CLI-Prozess, der über stdio am Sidecar hängt.
Freigaben (`canUseTool`), die Sperrliste (PreToolUse-Hook) und die FORGE-Werkzeuge (In-Process-MCP-Server) laufen
im Sidecar. Ein neuer Sidecar kann diese Pipes und Callbacks nicht übernehmen; ein dauerhafter Session-Prozess
außerhalb des Updates müsste genau diesen Code enthalten und wäre selbst wieder zu aktualisieren. Deshalb:
anhalten, merken, nach dem Neustart fortsetzen. Der Verlauf liegt im Transkript der CLI, `resume` setzt dort an.

**Ablauf:** Das Hauptfenster ruft vor `install_update` `app.prepareInstall` auf. Beim Beenden schreibt der Sidecar
dann nach dem Drain (Auto-Commits und Tests fertiger Durchläufe) jede Session mit laufendem CLI-Prozess in
`update_resume`, mit `working`, wenn ein Durchlauf, eine Hintergrundaufgabe oder ein Subagent lief. Gilt nur
zwei Minuten nach `prepareInstall`; scheitert `install_update`, nimmt `prepareInstall { cancel: true }` es zurück.
Der neue Sidecar öffnet die Sessions 3 s nach dem Start wieder: ruhende ohne Prompt (Tab und Status sind wieder da),
arbeitende mit einer automatischen Nachricht (`source: "auto"`) und davor dem Ereignis `app.updated` (Karte
„FORGE aktualisiert“ mit beiden Versionen). Marken älter als 30 Minuten verfallen: FORGE kam dann nicht direkt
aus dem Update zurück. Unterbrochene Befehle laufen nicht weiter, die Nachricht sagt Claude, sie neu zu starten.
Offene Chat-Fenster merkt sich das Hauptfenster (`localStorage`) und öffnet sie nach dem Start wieder.

**Zwei Schritte:** Liegt beim Start die Ketten-Datei, kann gleich der zweite Schritt folgen. Die Sessions warten
dann (`holdsResume`, höchstens 5 Minuten), bis klar ist, ob er installiert wird; sonst würden sie anlaufen und
sofort wieder angehalten. Startet er, bleiben die Marken für den nächsten Start stehen.

**Telefon:** `forge_system update_install` (RPC `app.installUpdate`) bittet das Hauptfenster per Ereignis
`update.install`, zu installieren; das Gespräch endet mit dem Neustart. Befehlspalette: „FORGE … installieren“.

Nicht abgedeckt: Terminals im unteren Panel und Dev-Server starten nach dem Update nicht von selbst neu; ein laufender
Anruf endet.

## Tests

`app-update.test.ts`: Versionsvergleich, Update gefunden, Download mit Prüfsumme und Signatur, falsche Prüfsumme,
falsche Signatur ohne Prüfsumme, unsignierte Assets, aktuell, noch kein Release, Wahl zwischen kleinem Update und
vollem Installer, Download des kleinen Updates. `update-signing.test.ts`: Signaturskript gegen Prüfung, anonymer
Abruf mit Token nur bei Ablehnung, Ratenlimit.
Das Austausch-Skript ist von Hand geprüft (Erfolg und Rückbau bei gesperrter Datei).

# HANDOFF – Stand 2026-10-10

## Aktueller Stand

Phasen 0 bis 3 sind umgesetzt und auf Windows 11 getestet (Details in docs/TASKS.md und ADR 0007). FORGE startet als Tauri-Fenster, nutzt die
installierte Claude-Code-CLI mit dem bestehenden Max-Login über den Agent SDK und bildet den
Terminal-Workflow ab: Projekte, Sessions mit Streaming, Freigaben, Stop/Resume, Git-Status/Diff und
geprüfte Commits. Details: [README.md](README.md), [docs/TASKS.md](docs/TASKS.md).

Definition of Done (Master-Prompt, Abschnitt 12):

| Kriterium | Stand |
|---|---|
| App startet als Fenster mit echter Navigation | erfüllt |
| Projektordner importieren, entfernen, nach Neustart wiederfinden | erfüllt (Unit + UI) |
| Neuer Projektordner lässt sich erstellen | erfüllt (Unit) |
| Claude Max über offiziellen Weg, kein API-Key | erfüllt (`apiKeySource: none`, E2E) |
| Reale Session starten und Prompt senden | erfüllt (E2E + UI) |
| Live-Ergebnisse und Tool-Events im Workspace | erfüllt |
| Stop, Fehlerbehandlung, Wiederaufnahme | erfüllt (E2E inkl. Absturz) |
| Git-Status und echter Diff | erfüllt |
| Reviewten Commit sicher erstellen | erfüllt (E2E + UI) |
| Permission-Profil wirksam | erfüllt (E2E: Safe fragt, Bypass-Sperrliste greift) |
| Tests laufen und stehen im README | erfüllt |
| Keine Demo-Projekte oder Dummy-Buttons in kritischen Pfaden | erfüllt; Phase-2-Seiten zeigen ehrlich „noch nicht verfügbar“ |

## Testresultate

Siehe [docs/TESTING.md](docs/TESTING.md): Lint/Typecheck sauber, 76 + 7 Unit-/Integrationstests,
8 E2E-Tests mit echter Claude-Session, alle grün. Linux nicht getestet.

## Befehle

```bash
pnpm install
pnpm dev            # Desktop-App im Entwicklungsmodus
pnpm lint && pnpm typecheck && pnpm test
pnpm test:e2e       # echte Claude-Aufrufe (Modell haiku), FORGE_E2E=0 überspringt
pnpm build          # Release + NSIS-Installer unter apps/desktop/src-tauri/target/release/bundle/
```

`pnpm build` lädt beim ersten Mal Node, PortableGit und gh (geprüft per SHA-256) nach `.runtime-cache/`.

Rust ist per rustup unter `%USERPROFILE%\.cargo\bin` installiert. Neue Terminals haben es im PATH;
in bereits offenen Shells ggf. `$env:Path += ";$env:USERPROFILE\.cargo\bin"`.

## Bekannte Fehler und Einschränkungen

- Linux ungetestet. Windows-Installer enthält Node, Git und gh (rund 92 MB).
- Modellanzeige zeigt bei laufenden Sessions den aufgelösten Namen (z. B. `claude-opus-5-5`) statt des Anzeigenamens.
- Untätige Sessions behalten ihren Claude-Prozess, bis „Beenden“ geklickt oder die App geschlossen wird.
- Radix-Dialoge schließen sich, wenn das Fenster beim Öffnen keinen Fokus hat (nur bei Fernsteuerung
  per UI Automation beobachtet, bei normaler Bedienung nicht).
- Für Remote Control muss Claude dem Ordner einmal vertrauen (im eingebetteten Terminal bestätigen).
- Geplante Aufgaben laufen nur bei geöffnetem FORGE.
- Claude-Code-Installation aus der App ist nicht getestet (hätte die vorhandene Installation verändert). Claude- und GitHub-Anmeldung sind bis zur Anzeige von URL bzw. Code geprüft; abschließen kann nur der Nutzer im Browser.
- Die Usage-Anzeige nutzt eine experimentelle SDK-Methode; nach SDK-Updates prüfen.

## Genau drei nächste Aufgaben

1. **Auf GitHub mit echtem Konto prüfen:** `gh`-Login in FORGE abschließen, dann Projekt veröffentlichen,
   Feature-Workflow mit Push und PR laufen lassen, PR-Status kontrollieren.
2. **Linux-Build:** Tauri-Abhängigkeiten installieren, `pnpm build` unter Ubuntu, E2E-Lauf, .deb testen.
3. **Ressourcen:** untätige Claude-Prozesse nach einstellbarer Zeit schließen; Installer signieren.

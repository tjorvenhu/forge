# HANDOFF – Stand 2026-10-11

## Aktueller Stand

Phasen 0 bis 4 sind umgesetzt und auf Windows 11 getestet (Details in docs/TASKS.md, ADR 0007 und 0009).
Phase 4: Rückfragen- und Plan-Karten, Kontextanzeige mit Komprimieren, Befehlspalette (Strg+K),
Volltextsuche über alle Verläufe, Dev-Server pro Projekt.
Phase 5: Telefon über SIP (ADR 0010): Anrufe an FORGE und Rückrufe von FORGE, Claude als Gesprächspartner. FORGE startet als Tauri-Fenster, nutzt die
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

Siehe [docs/TESTING.md](docs/TESTING.md): Lint/Typecheck sauber, 150 + 21 Unit-/Integrationstests,
17 E2E-Tests mit echter Claude-Session, alle grün.

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

- FORGE läuft nur unter Windows. Der Installer enthält Node, Git und gh (rund 92 MB).
- Modellanzeige zeigt bei laufenden Sessions den aufgelösten Namen (z. B. `claude-opus-5-5`) statt des Anzeigenamens.
- Untätige Sessions behalten ihren Claude-Prozess, bis „Beenden“ geklickt oder die App geschlossen wird.
- Radix-Dialoge schließen sich, wenn das Fenster beim Öffnen keinen Fokus hat (nur bei Fernsteuerung
  per UI Automation beobachtet, bei normaler Bedienung nicht).
- Remote Control nutzt `enableRemoteControl` aus dem Agent SDK. Die Methode steht nicht in den SDK-Typen; nach SDK-Updates prüfen (`packages/sidecar/src/claude/runtime.ts`).
- Nachrichten vom Handy werden über `--replay-user-messages` erkannt, Rückfall ist das Transkript. Der Weg Handy → FORGE ist mit simulierten Events getestet, nicht mit der echten App.
- Claude-Code-Installation aus der App ist nicht getestet (hätte die vorhandene Installation verändert). Claude- und GitHub-Anmeldung sind bis zur Anzeige von URL bzw. Code geprüft; abschließen kann nur der Nutzer im Browser.
- Die Usage-Anzeige nutzt eine experimentelle SDK-Methode; nach SDK-Updates prüfen.
- Die Volltextsuche umfasst Prompts und Antworten, keine Tool-Ein- und Ausgaben.
- Die Kontextanzeige gibt es nur bei laufendem Claude-Prozess (nach dem ersten Durchlauf), nicht für beendete Sessions.
- Ein Dev-Server ohne Adresse in der Ausgabe zeigt „startet …“, bis er eine meldet.
- Installer-Signierung und Auto-Update sind zurückgestellt: kein Code-Signing-Zertifikat.
- Telefon: nur gegen eine Test-Anlage geprüft, nicht gegen die echte Anlage und nicht mit echten OpenAI-Sprachdiensten.
  Nur UDP und G.711, kein TLS/SRTP. Die Windows-Firewall fragt beim ersten Anruf nach Zugriff für Node.js.

## Genau drei nächste Aufgaben

1. **Telefon mit der echten Anlage testen:** Zugangsdaten und OpenAI-Key unter Einstellungen → Telefon eintragen,
   einschalten, Testanruf, dann einmal selbst anrufen (Status fragen, PIN eingeben, Anweisung schicken).
2. **Auf GitHub mit echtem Konto prüfen:** `gh`-Login in FORGE abschließen, dann Projekt veröffentlichen,
   Push, PR und Projekt löschen mit GitHub-Repository prüfen.
3. **Ressourcen:** untätige Claude-Prozesse nach einstellbarer Zeit schließen.

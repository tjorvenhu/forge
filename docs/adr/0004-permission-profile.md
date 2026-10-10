# ADR 0004: Permission-Profile und Policy-Engine

Datum: 2026-10-10 · Status: angenommen

## Profile

| Profil | Claude-Modus | Freigaben | Zusatz |
|---|---|---|---|
| Safe | `default` | jede Anfrage einzeln in FORGE, kein „für Session erlauben" | `WebFetch`/`WebSearch` deaktiviert |
| Balanced | `acceptEdits` | Datei-Edits im Projekt automatisch, Rest einzeln oder für die Session | – |
| Autonomous | `bypassPermissions` | keine Rückfragen | Standard für neue Projekte, siehe unten |

Zusätzlich pro Session: **Nur planen** (`plan`), unabhängig vom Profil.

## Harte Sperrliste (alle Profile, auch Bypass)

Umgesetzt als `PreToolUse`-Hook im Sidecar, nicht als Claude-Setting, damit Repo-Dateien sie nicht
aufweichen können:

- `git push --force`/`-f`/`--force-with-lease`, Push auf `main`/`master`, `git reset --hard`,
  `git branch -D`, `git clean -fdx`, rekursives Löschen von Laufwerks- oder Home-Wurzel.
- Datei-Tools auf sensiblen Pfaden: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`,
  `~/.claude/.credentials.json`, Browserprofile (Chrome, Edge, Firefox), Windows Credential Store.
- Im Autonomous-Profil zusätzlich: Schreibzugriffe außerhalb des Projektordners.

## Autonomous als Standard (Revision 2026-10-10)

Ursprünglich war Autonomous doppelt gesperrt: global freischalten (Eintippen von `BYPASS`) und pro
Projekt mit Projektname bestätigen. Das war im Alltag zu umständlich und wurde entfernt.

- `defaultProfile` ist jetzt `autonomous`; neue Projekte und Worktrees übernehmen es direkt.
- Der Wechsel auf Autonomous ist ein normaler Klick im Profil-Menü, ohne Bestätigungsdialog.
- Das Tag `sandbox-only` bleibt die Ausnahme pro Projekt: Autonomous ist dann nicht wählbar, und
  wird das Tag in einem Autonomous-Projekt gesetzt, fällt es auf Balanced zurück. `resolveProfile`
  prüft das beim Sessionstart noch einmal.
- Die harte Sperrliste und die Schreibsperre außerhalb des Projekts bleiben unverändert.

Ein Profilwechsel gilt sofort auch für laufende Sessions (`SessionService.applyProjectProfile`):
Permission-Modus per `setPermissionMode`, Freigabe-Umfang und Schreibsperre über das Profil der
Live-Session. Ein aktiver Plan-Modus bleibt bestehen. Damit der Wechsel nach Bypass möglich ist, startet
jede Session mit `allowDangerouslySkipPermissions: true`. Ohne das Flag lehnt die CLI den Wechsel ab.
Der aktive Modus wird trotzdem immer explizit gesetzt. `disallowedTools` steht beim Prozessstart fest.
Wechselt eine laufende Session nach Safe, sperrt der PreToolUse-Hook die Web-Tools (`profile-tool`).

Bypass ist weiterhin keine Sandbox. Befehle laufen mit den Rechten des Nutzers. Repo-Dateien wie
`.claude/settings.json` ändern den Modus nicht, weil FORGE ihn immer explizit setzt.

## Audit

Jede Freigabeentscheidung (Nutzer oder Policy) wird mit Zeit, Session, Tool, Entscheidung und Quelle in
`approvals` gespeichert. Tool-Eingaben werden vor dem Speichern durch den Secret-Redactor geschickt.

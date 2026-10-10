# ADR 0004: Permission-Profile und Policy-Engine

Datum: 2026-10-10 · Status: angenommen

## Profile

| Profil | Claude-Modus | Freigaben | Zusatz |
|---|---|---|---|
| Safe | `default` | jede Anfrage einzeln in FORGE, kein „für Session erlauben" | `WebFetch`/`WebSearch` deaktiviert |
| Balanced | `acceptEdits` | Datei-Edits im Projekt automatisch, Rest einzeln oder für die Session | – |
| Autonomous | `bypassPermissions` | keine Rückfragen | standardmäßig gesperrt, siehe unten |

Zusätzlich pro Session: **Nur planen** (`plan`), unabhängig vom Profil.

## Harte Sperrliste (alle Profile, auch Bypass)

Umgesetzt als `PreToolUse`-Hook im Sidecar, nicht als Claude-Setting, damit Repo-Dateien sie nicht
aufweichen können:

- `git push --force`/`-f`/`--force-with-lease`, Push auf `main`/`master`, `git reset --hard`,
  `git branch -D`, `git clean -fdx`, rekursives Löschen von Laufwerks- oder Home-Wurzel.
- Datei-Tools auf sensiblen Pfaden: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`,
  `~/.claude/.credentials.json`, Browserprofile (Chrome, Edge, Firefox), Windows Credential Store.
- Im Autonomous-Profil zusätzlich: Schreibzugriffe außerhalb des Projektordners.

## Autonomous-Freischaltung

1. Global in Einstellungen freischalten (Warnung, Bestätigung durch Eintippen von `BYPASS`).
2. Pro Projekt aktivieren (zweite Bestätigung mit Projektname).
3. Hinweis bei jedem Sessionstart. Bypass ist keine Sandbox.

FORGE kann nicht zuverlässig erkennen, ob es in einer VM oder einem Container läuft. Die Bestätigung
enthält diese Anforderung ausdrücklich. Importierte Repos, Tags oder `.claude/settings.json` schalten
Autonomous nie frei, weil FORGE den Modus immer explizit setzt.

## Audit

Jede Freigabeentscheidung (Nutzer oder Policy) wird mit Zeit, Session, Tool, Entscheidung und Quelle in
`approvals` gespeichert. Tool-Eingaben werden vor dem Speichern durch den Secret-Redactor geschickt.

# ADR 0008: Remote Control über die SDK-Session, Projekt löschen, Automationen entfernt

Datum: 2026-10-10 · Status: angenommen

## Remote Control

Problem mit ADR 0007: `claude remote-control` startet eigene Sessions. Was in FORGE geschrieben wurde,
war in der Claude-App nicht zu sehen und umgekehrt.

Neu: Die laufende Agent-SDK-Query bietet `enableRemoteControl(enabled, name)` (Control-Request
`remote_control`, so nutzen es auch die IDE-Hosts). Die Methode steht nicht in den SDK-Typen (0.3.296);
sie ist in `AgentSdkRuntime` gekapselt. Antwort: `session_url` (claude.ai/code/session_…), Status kommt als
`system/bridge_state` (ready, connected). Im Spike verbunden, auch ohne erste Nachricht und ohne
Ordner-Vertrauen.

- Remote ist pro Projekt an: alle offenen Sessions werden verbunden, neue und fortgesetzte automatisch.
  Ohne offene Session öffnet FORGE eine leere („Remote-Session“), die den Titel der ersten Nachricht bekommt.
- Nachrichten aus der App: Sessions laufen mit `--replay-user-messages` (über `extraArgs`). Eigene Nachrichten
  kommen mit der eigenen `uuid` zurück und werden ignoriert; unbekannte `uuid`s sind Nachrichten aus der App.
  `command_lifecycle: started` mit unbekannter `uuid` markiert einen Durchlauf von dort (Status, Git-Basis für
  Auto-Commit). Rückfall: fehlt das Echo, liest FORGE nach dem Durchlauf das Transkript.
- Sicherheit: Nachrichten von der App laufen durch dieselbe Session, also mit Profil, Freigaben (`canUseTool`)
  und Sperrliste (PreToolUse-Hook). Das ist strenger als vorher.
- Remote-Zustand wird nicht gespeichert; nach Neustart ist er aus.

## Projekt löschen

`projects.remove` nimmt optional `deleteFolder` und `deleteGitHubRepo`. Reihenfolge: offene Sessions schließen,
GitHub-Repo löschen (scheitert am ehesten, dann ist nichts verloren), Ordner löschen, Eintrag entfernen.
Gesperrt: Laufwerke, Home und Vorfahren, Standardordner im Home, FORGE-Daten und Installationsordner, Ordner mit
weiteren Projekten. Worktrees werden über `git worktree remove` gelöscht. `gh repo delete` braucht den Scope
`delete_repo`; FORGE fragt ihn per `gh auth refresh -s delete_repo` (Device-Flow wie beim Login) erst an, wenn
der Nutzer das Repo löschen will. Die UI verlangt bei jeder löschenden Option das Eintippen des Projektnamens.

## Entfernt

Feature-Workflow und geplante Aufgaben (Ansicht „Automatisierungen“) auf Wunsch des Nutzers. Migration 3 löscht
die Tabellen `workflows` und `schedules`. Projekt-Tags und Worktrees bleiben.

## Tooltips

Native `title`-Tooltips werden app-weit durch eine eigene Ebene ersetzt (`TitleTooltips`): das Attribut wandert
beim Hover nach `data-forge-title` und danach zurück. So greift das eigene Aussehen auch in CodeMirror und xterm.

## Effort

Effort (low, medium, high, xhigh, max, die Namen von Claude Code) als Auswahl auf drei Ebenen: global (Einstellungen), pro Projekt und pro Session im
Composer. Start über die SDK-Option `effort`, Wechsel in laufender Session über `applyFlagSettings({ effortLevel })`.
Welche Stufen ein Modell kann, meldet Claude Code in der Modellliste (`supportsEffort`, `supportedEffortLevels`);
ohne Unterstützung blendet FORGE die Auswahl aus. Migration 4: `projects.default_effort`, `sessions.effort`.
Modellnamen kommen aus derselben Liste („opus“ → „Opus 5.5“).

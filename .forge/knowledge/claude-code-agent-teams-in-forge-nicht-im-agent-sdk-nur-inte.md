---
title: "Agent-Teams (nur Branch experimental): Lead-Session orchestriert Rollen-Subagenten (teams.*, TeamBoard)"
summary: "Agent-Teams sind seit 2026-10-24 aus dev entfernt und liegen nur auf dem Branch experimental. Wie man sie zurückholt und wie sie funktionieren (Lead mit Rollen-Subagenten, Freigaben, Verbrauch, Rollenmodelle, Crew, E2E)."
tags: ["agenten","sdk","git","stolperfalle"]
updated: "2026-10-24T12:12:32.490Z"
---

# Agent-Teams: nur auf Branch experimental (seit 2026-10-24)

## Stand
- Auf Wunsch des Besitzers aus dev entfernt, weil das Feature noch in Entwicklung ist. Der Branch `experimental`
  (origin/experimental) steht auf f755a8d, dem letzten dev-Stand mit Teams.
- Entfernt hat es Commit c27cdcf („Agent-Teams aus dev entfernt…“) in einem Stück: teams.* RPCs, Team-Board,
  Start-Dialog, Rollenmodelle, Schalter global/pro Projekt, Telefon `agent_team`, Crew-Aufgabe als Team,
  Team-Prüfbefehle, Team-Anzeige in Crew und Crew-Web.
- **Geblieben auf dev:** die DB-Migrationen `projects.teams_enabled`, `sessions.team`, `sessions.team_models` in
  `persistence/db.ts`. Die Migrationsliste zählt nach Position, deshalb nicht löschen. dev liest die Spalten nicht.
  Ebenfalls geblieben, weil allgemein: `StartOptions.agents` in `claude/runtime.ts`, das Event `task.usage` und die
  Tokens pro Subagent/Hintergrundaufgabe.
- **Zurückholen:** dev in experimental mergen. Dadurch kommt auch die Entfernung mit. Danach auf experimental
  `git revert c27cdcf` und Konflikte mit neuerem Code lösen. Später experimental in dev mergen.
- Crew-Kompatibilität: dev schickt beim Teilen von Sessions kein `team`/`teamModels` mehr. Ein Stand von
  experimental erwartet `team` als Pflichtfeld in `crew/share.ts`; beim Zurückholen optional machen.

## Aufbau (auf experimental)
- **Team = Session** mit `sessions.team = 1`, Rollenmodelle in `sessions.team_models`. `lifecycle.attach` gibt
  `agents: teamAgents(rec.teamModels)` mit und hängt `teamLeadContext` an (`packages/sidecar/src/teams/team-agents.ts`).
- **Rollen** (`TEAM_ROLES`, `TEAM_ROLE_SPECS` in `packages/protocol/src/team.ts`), Subagent-Typ `team-<rolle>`:
  scout Haiku low nur lesen, developer Sonnet, specialist Opus high, tester Sonnet medium, reviewer Opus high nur lesen.
  Lead: Opus high, wählbar fable und sonnet.
- **Rollenmodelle:** Vorgabe `Settings.teamRoleModels` (Einstellungen → Claude), pro Start im StartTeamDialog,
  Telefon `agent_team start models`; `parseTeamRoleModels`/`mergeTeamRoleModels`.
- **Lead-Regeln:** Größe einschätzen, Scouts parallel, TodoWrite-Plan Pflicht ab zwei Mitgliedern, eigene Dateien
  pro Paket, höchstens 5 Mitglieder im Hintergrund, am Ende Tester und Reviewer.
- **Ansicht:** `buildTeam(events, …)` liefert Mitglieder, Plan und Verbrauch pro Modell. `turn.result.models` ist pro
  CLI-Prozess kumuliert, daher je Prozessabschnitt (bis zum nächsten `session.init`) den letzten Wert summieren.
- **Freigaben** im Board pro Mitglied (approval.request → toolUseId → parentToolUseId), nur bei laufendem Prozess.
- **Prüfbefehle ohne Rückfrage:** `ApprovalGate.teamCheck` + `isTeamCheckCommand` (`teams/team-checks.ts`) im Profil
  Balanced: Tests, Lint, Typecheck, `node --test`, lesende Befehle, `cd "pfad" && …`; keine Verkettung, kein `$()`.
- **Crew:** `CrewAgent.team = { working }`, `crew.taskStart` mit `team: true`. Auf dev bleibt nur: eine Session mit
  Hintergrund-Subagenten zählt in der Crew als „arbeitet“.

## E2E mit echtem Claude (auf experimental)
- `FORGE_E2E_TEAM=1 npx vitest run -c vitest.e2e.config.ts test/e2e/team.e2e.test.ts` im Paket sidecar, etwa 1 Minute.
- Ergebnis 2026-10-22: Lead startete 3 team-developer parallel auf Sonnet, prüfte selbst. Ohne Pflicht legte der
  Lead keinen Plan an; unter Windows nutzt er das PowerShell-Werkzeug.

## Entscheidung (Vorgeschichte)
- Zuerst liefen Claude Codes eigene Agent Teams im Terminal-Reiter: winziges Terminal, nur ein Agent. Verworfen
  zugunsten des Nachbaus mit Modellwahl pro Rolle. `STRIP_ENV` in terminal.rs stammt noch daher.

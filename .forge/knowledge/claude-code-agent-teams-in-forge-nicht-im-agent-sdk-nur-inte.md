---
title: "Agent-Teams nativ: Lead-Session orchestriert Rollen-Subagenten mit eigenen Modellen (teams.*, TeamBoard)"
summary: "Wie FORGEs Agent-Teams funktionieren (Session mit team=1, Lead plant und verteilt an Rollen-Subagenten mit eigenem Modell), Freigaben/Prüfbefehle, Verbrauch pro Mitglied, Rollenmodelle, Crew-Anbindung, E2E-Lauf, Stolperfallen."
tags: ["agenten","sdk","telefon","ui","usage","stolperfalle"]
updated: "2026-10-22T19:09:02.226Z"
---

# Agent-Teams in FORGE (nativ, seit 2026-10-22)

## Entscheidung
- Zuerst liefen Claude Codes experimentelle Agent Teams im Terminal-Reiter. Das hat der Besitzer verworfen: Das Terminal war winzig, der Lead setzte nur einen Agenten ein, und es sah schlecht aus.
- Stattdessen gibt es einen Nachbau mit Hinweis auf erhöhten Verbrauch und gezielter Modellwahl pro Rolle. Die Terminal-Variante ist komplett entfernt; nur `STRIP_ENV` in terminal.rs bleibt.

## Aufbau
- **Team = Session:** Ein Team ist eine Session mit `sessions.team = 1`, die Rollenmodelle liegen in `sessions.team_models` (JSON, `Session.teamModels`, beim Start festgelegt). `lifecycle.attach` gibt bei jedem Start und Resume `agents: teamAgents(rec.teamModels)` mit und hängt `teamLeadContext(rec.teamModels)` an (`packages/sidecar/src/teams/team-agents.ts`). Die Rollenbeschreibungen nennen dem Lead das tatsächliche Modell.
- **Rollen** (`TEAM_ROLES`/`TeamRole` in models.ts, Spezifikation `TEAM_ROLE_SPECS` in `packages/protocol/src/team.ts`), Subagent-Typ `team-<rolle>`:
  - scout: Haiku, low, nur lesen, `omitClaudeMd`
  - developer: Sonnet
  - specialist: Opus, high
  - tester: Sonnet, medium
  - reviewer: Opus, high, nur lesen
- **Lead:** Opus, Effort high; wählbar sind fable und sonnet.
- **Abweichende Rollenmodelle:**
  - Vorgabe in `Settings.teamRoleModels`: Einstellungen → Claude unter dem Agent-Teams-Schalter (`RoleModelsEditor`), Palette `team-models`, Telefon `forge_settings team_models`.
  - Pro Start im StartTeamDialog („Als Vorgabe merken“) und über Telefon `agent_team start models`.
  - Für Text gibt es `parseTeamRoleModels` und `mergeTeamRoleModels`; Rollennamen gehen auf Deutsch oder Englisch, „standard“ setzt eine Rolle zurück.
- **Lead-Regeln:**
  - Zuerst die Größe der Aufgabe einschätzen.
  - Scouts parallel losschicken.
  - Den TodoWrite-Plan vor dem Start der Mitglieder anlegen; Pflicht, sobald zwei oder mehr Mitglieder arbeiten.
  - Jedes Paket hat eigene Dateien.
  - Höchstens 5 Mitglieder gleichzeitig im Hintergrund.
  - Am Ende Tester und Reviewer.
- **Ansicht:** `buildTeam(events, {live, cwd, roleModels, liveTokens})` liest die `TEAM_EVENT_TYPES` und liefert:
  - Mitglieder mit Tätigkeit, Dateien, Tokens und offener Freigabe;
  - den Plan;
  - `models`: Verbrauch pro Modell. `turn.result.models` ist pro CLI-Prozess kumuliert, deshalb wird je Prozessabschnitt (bis zum nächsten `session.init`) der letzte Wert summiert.
- **Tokens pro Mitglied:**
  - Am Ende kommt das Event `task.usage` (Normalizer aus `task_notification.usage`, vordergründig und im Hintergrund).
  - Live liefert `task_progress.usage.total_tokens` die Werte in `SubagentProgress.tokens` bzw. `BackgroundTask.tokens`. `AgentTeams.get` reicht sie als `liveTokens` weiter.
- **Freigaben:**
  - Das Board zeigt pro Mitglied die wartende Freigabe (approval.request → toolUseId → parentToolUseId → Mitglied) mit Erlauben, „Immer in dieser Session“ und Ablehnen (`sessions.respondApproval`).
  - Nur bei laufendem Prozess, sonst sind offene Anfragen hinfällig.
- **Prüfbefehle ohne Rückfrage:**
  - `ApprovalGate.teamCheck`: In Team-Sessions mit Profil Balanced laufen Bash- und PowerShell-Befehle ohne Rückfrage, wenn `isTeamCheckCommand` sie erkennt (`teams/team-checks.ts`): Tests, Lint, Typecheck, `node --test`, lesende Befehle, das testCommand des Projekts, `cd "pfad" && …`.
  - Keine Verkettung mit `; | & > <`, kein `$()`.
  - Protokolliert mit source policy, reason team-check. Im Profil Safe wird weiter gefragt.
- **RPCs:**
  - `teams.list`, `teams.get`
  - `teams.start` (leadModel, roleModels)
  - `teams.message` (an den Lead)
  - `teams.stop` (Hintergrund-Agenten, dann der Turn)
  - Event `teams.updated` (gedrosselt, 400 ms)
- **Oberfläche:**
  - `AgentTeams.tsx`: Team-Karten und Start-Dialog.
  - `TeamBoard.tsx`: über dem Chat des Leads, mit Mitgliederkarten, Plan und Verbrauch.
  - `TeamModels.tsx`: `RoleModelsEditor`, `TeamUsage` (Balken nach geschätzten Kosten pro Modell plus Anteil an den Abo-Fenstern aus `sessions.usage`).
  - Telefon `agent_team` mit status, message, start und stop.

## Crew-Modus
- **Was ohne Zusatz klappt:** Die Crew sieht eine Team-Session als einen Agenten. Bearbeitungen der Mitglieder zählen zu dessen Dateien, weil Subagent-`tool.use` Session-Events derselben Session sind. Die Crew-Hooks (`toolContext` pre/post) greifen auch bei den Mitgliedern.
- **`CrewAgent.team = { working }`:** `onSessionUpdated` zählt eine Session mit Hintergrund-Agenten oder Subagenten als „arbeitet“, auch wenn der Lead wartet.
- **Crew-Aufgabe als Team:** `crew.taskStart` mit `team: true` startet `CrewDeps.sessions.startTeam` (app.ts → `teams.start`). Erreichbar über den Crew-Reiter (Knopf mit Users-Symbol und Rechtsklick), Telefon `crew task_start team`; `crew_status` nennt Teams.

## E2E mit echtem Claude
- Aufruf: `FORGE_E2E_TEAM=1 npx vitest run -c vitest.e2e.config.ts test/e2e/team.e2e.test.ts` (im Paket sidecar). Ziel sind drei unabhängige JS-Funktionen; die Dauer liegt bei etwa 1 Minute.
- Ergebnis vom 2026-10-22:
  - Der Lead (Opus) startete 3 team-developer parallel im Hintergrund, alle auf Sonnet, mit eigenen Dateien.
  - Danach prüfte er selbst und antwortete auf Deutsch.
  - Kein Scout und kein Review, weil die Aufgabe klein war.
- Vitest zeigt das console.log bestandener Tests nicht. Die Auswertung kommt aus dem Transkript `~/.claude/projects/*team-projekt*/<session>.jsonl` mit `subagents/agent-*.jsonl` und `.meta.json` (agentType, Modell, usage).
- Daraus gelernt:
  - Mitglieder rufen `cd "Pfad mit Leerzeichen" && …` auf.
  - Unter Windows nutzt der Lead das PowerShell-Werkzeug.
  - Ohne Pflicht legte der Lead keinen Plan an.

## Stolperfallen
- `\n` in Python-Heredocs unter Git Bash wird zum echten Zeilenumbruch und zerbricht TS-Strings. Ersetzungsskripte deshalb als Datei schreiben oder das Edit-Werkzeug nehmen.
- Schreibzugriffe außerhalb des Projektordners sperrt die FORGE-Policy. Worktrees unter `.claude/worktrees/` anlegen; nach `git worktree move` neu installieren mit `CI=true pnpm install --frozen-lockfile --prefer-offline`.
- Ein optionales Feld in `Settings` braucht `-?` im Mapped Type `BooleanSetting` (palette-actions.tsx).
- Auf diesem Rechner schlagen 12 Sidecar-Tests schon auf dev fehl, ohne Bezug zu Teams: backup, agent-auto-merge, agent-finish (3), git-commit-files, knowledge-staleness, phone-call, preview (2), project-git, worktrees.

---
title: "Crew: Live-Zusammenarbeit mehrerer FORGE-Installationen (CrewService, Relay in der Website, crew_status/crew_task/crew_message)"
summary: "Wie mehrere Leute mit FORGE gleichzeitig am selben Projekt arbeiten: Relay, Verschlüsselung, Beitritt mit Prüfcode, Präsenz der Agenten, Hinweise per Hook, Push-Erkennung und Auto-Pull; was bei Änderungen zu beachten ist."
tags: ["crew","zusammenarbeit","sidecar","relay","agenten","git","stolperfalle"]
updated: "2026-10-22T19:00:00.000Z"
---

Seit 2026-10-22. Entscheidungen und Begründungen: `docs/adr/0015-crew-live-zusammenarbeit.de.md`. Name „Crew“, weil „Teams“ schon Claude Codes Agent Teams sind (`teams/agent-teams.ts`).

## Wo was liegt
- Protokoll: `packages/protocol/src/crew.ts` (Crew, CrewMember, CrewAgent, CrewTask, CrewFeedItem, `CREW_RELAY_URL`), RPC `crew.*` in `rpc.ts`, Events `crew.updated` und `crew.notice`. `remoteIdentity()` in `git-remote.ts` (host/owner/repo, https = ssh).
- Sidecar `packages/sidecar/src/crew/`: `crew-service.ts` (alles Fachliche), `link.ts` (Relay: SSE lesen mit Reconnect/Backoff, POST mit Outbox), `crypto.ts` (AES-256-GCM mit AAD `room|kid`, X25519 + HKDF, Prüfcode `fingerprint`), `wire.ts` (zod-Nachrichten, Einladungscode `forge-crew1.<base64url JSON>`), `state.ts` (Datensatz, LWW-Merge), `session-tools.ts` (Werkzeuge + Start-Kontext). Texte `i18n/{de,en}/core/crew.ts`.
- Relay: Teil der Website `services/stats` (Wunsch des Besitzers: im selben Docker-Container wie die Website, keine eigene Ressource). Kern `src/lib/crew-relay.ts` (`RelayCore`, ohne Next), Singleton `crewRelay()` auf `globalThis` (Next bündelt jede Route einzeln). Routen `src/app/crew/v1/rooms/[room]/route.ts` (POST), `.../stream/route.ts` (SSE), `src/app/crew/health/route.ts`. `CREW_RELAY_URL` = `https://forge.vanturis.de/crew`, der Client hängt `/v1/rooms/<raum>` an. Stream mit `Cache-Control: no-transform` (Traefik komprimiert sonst und puffert). Braucht keine Datenbank. Wirkt erst nach Ausrollen der Website in Coolify (nicht automatisch). Neue Routen brauchen `pnpm exec next typegen`, sonst kennt `RouteContext` sie nicht.
- Desktop: Workspace-Tab „crew“, `components/crew/`, `lib/crew.ts`, Texte `i18n/{de,en}/crew.ts`. Telefon: Werkzeug `crew`.
- Tests: `packages/sidecar/test/crew.test.ts` startet den Relay in-process über den node:http-Adapter `services/stats/src/lib/crew-relay-node.ts` (gleiche Pfade `/crew/...`); mit `CREW_TEST_RELAY=http://127.0.0.1:<port>/crew` laufen dieselben Tests gegen eine gestartete Website (`next build`, dann `node .next/standalone/server.js`) und zwei CrewService-Instanzen mit echten Git-Repos (bare origin).

## Ablauf
- Daten: `<Datenordner>/crew/<id>.json` (Datensatz), `crew/profile.json` (Name, Farbe, Relay), Schlüssel als Secret `crew-<id>` (DPAPI). `app.ts` lässt `crew-*` aus Backups und GitHub-Sync heraus (`localSecret`), beim Wiederherstellen bleiben sie.
- Beitritt: `crew.join` legt die Crew als `pending` an und schickt nach `ready` des Streams `join_request` (mit X25519-Schlüssel) über den Einladungsschlüssel. Jedes Mitglied, das den Einladungsschlüssel kennt (Einladungen werden per `invite`/`state` geteilt), sieht die Anfrage mit Prüfcode und kann mit `crew.respond` annehmen → `join_accept` mit dem Crew-Schlüssel, versiegelt per `sharedKey(own, req.pub, "grant:<request>")`.
- Verbunden: `hello` → alle antworten (verzögert) mit `state` (Mitglieder, Aufgaben, Feed, Einladungen inkl. Schlüssel). Präsenz alle 30 s und nach Änderungen (1,5 s entprellt). Online = in den letzten 90 s gehört.
- Entfernen nur durch den Gründer (`owner`, unveränderlich nach dem ersten Kennen): neuer Schlüssel pro Epoche, `rekey` mit pro Mitglied versiegeltem Schlüssel; Nachrichten Entfernter mit alter Epoche werden ignoriert.

## Agenten
- `SessionService.withCrew` hängt Werkzeuge und Kontext an `forgeSessionTools` an (nur wenn das Projekt bzw. sein Hauptprojekt Crew-Mitglied ist; neue Werkzeuge erst nach Neustart der Session).
- Neuigkeiten (`noteLocal` → `takeNews`): mit der nächsten Nachricht über `TurnHost.note` in `turns.ts` und live über den PostToolUse-Hook (`SessionSink.toolContext` in `claude/runtime.ts`, `additionalContext`). Warnung vor Edits auf fremde Dateien über PreToolUse-`additionalContext` (`editWarning`, Edit/Write/MultiEdit/NotebookEdit, einmal pro Session+Datei in 10 min).
- Präsenz aus Server-Events (`onServerEvent` in `app.ts`-emit): `user.message` (Auftrag), `tool.use` mit Edit-Werkzeugen (Dateien relativ zum Projekt; Worktree-Pfade relativ zum Worktree), `turn.result` (fertig + Feed-Eintrag `turn`).
- Aufgaben mit `assignee`: Empfänger bekommt `crew.notice` kind `task`; `acceptTasks: "auto"` startet direkt eine Session (`startTask`), deren erstes erfolgreiches Durchlaufende die Aufgabe auf `done` setzt.

## Git
- `refreshGit`: Dateien = `git status` + `git diff --name-only origin/<branch>...HEAD`; `ahead`/`behind` gegen `refs/remotes/origin/<branch>` ohne Fetch.
- Eigener Push: `origin/<branch>` hat sich seit `originSeen` vorwärts bewegt und die neuen Commits haben die Autor-E-Mail aus `git config user.email` **im Repo** (nicht nur global) → Feed `push`. Fetch-Ergebnisse anderer zählen deshalb nicht als eigener Push.
- Bei `push` eines anderen: `git.incoming` (fetch) und mit `autoPull` (Standard an) `git.pull` (Rebase, Stash), nur wenn `sessions.projectBusy` falsch ist; sonst `behind` + Hinweis an die Agenten, nach dem nächsten Durchlaufende neuer Versuch.

## Stolperfallen
- Bash-Heredocs verlieren Backslashes und scheitern an manchen Sonderzeichen: Texte mit Regex oder Typografie mit dem Write/Edit-Werkzeug schreiben.
- `rmSync` löscht unter Pfaden mit Umlauten auf Windows/Node 24.11 nichts: `drop()` nutzt `unlinkSync`. Tests räumen mit Wiederholung auf, weil laufende git-Prozesse Dateien kurz offen halten.
- Feed-Texte sind Daten (Prompt-/Commit-Auszüge), nicht übersetzt; die Oberfläche setzt sie je nach `kind` in Sätze.

---
title: "Crew: Live-Zusammenarbeit mehrerer FORGE-Installationen (CrewService, Relay, Sessions teilen, Crew-Chat, Bubble)"
summary: "Wie mehrere Leute mit FORGE gleichzeitig am selben Projekt arbeiten: Relay, Verschlüsselung, Beitritt, Präsenz, Hinweise per Hook, Push/Auto-Pull, Sessions anderer ansehen/übernehmen (crew/share.ts), Crew-Chat und Bubble; was bei Änderungen zu beachten ist."
tags: ["crew","zusammenarbeit","sidecar","relay","agenten","git","stolperfalle"]
updated: "2026-10-22T19:52:06.275Z"
---

Seit 2026-10-22. Die Entscheidungen und ihre Begründungen stehen in `docs/adr/0015-crew-live-zusammenarbeit.de.md`. Der Name lautet „Crew“, weil „Teams“ die Agent-Teams sind (`teams/agent-teams.ts`).

## Wo was liegt
- **Protokoll:**
  - `packages/protocol/src/crew.ts` mit Crew, CrewMember, CrewAgent (`team?`), CrewTask, CrewFeedItem, CrewShare und CrewShareRequest, außerdem `CREW_RELAY_URL` und die Share-Limits.
  - RPC `crew.*` in `rpc.ts`, Events `crew.updated` und `crew.notice` (Arten u. a. `share` und `shared`).
- **Sidecar** in `packages/sidecar/src/crew/`:
  - `crew-service.ts`: alles Fachliche.
  - `link.ts`: Verbindung zum Relay. Liest per SSE mit Reconnect und sendet per POST mit Outbox. Die Klasse `RelayLink` wird auch für Share-Räume genutzt.
  - `crypto.ts`: AES-256-GCM, AAD `room|kid`.
  - `wire.ts`: zod-Nachrichten, darunter `share_ask`, `share_answer`, `share_stop`, `share_keep` und `ShareMessage` für den Share-Raum.
  - `state.ts`: Datensatz mit `shareAgents` (Standard `ask`) und LWW-Merge.
  - `share.ts`: Sessions anderer.
  - `session-tools.ts`.
- **Relay:** Teil der Website `services/stats` (`src/lib/crew-relay.ts`). Es speichert nur im Arbeitsspeicher, höchstens 256 KB pro Nachricht, 500 Nachrichten pro Raum und 240 POSTs pro Minute und IP. Räume sind beliebige IDs mit 16 bis 64 Zeichen aus `[A-Za-z0-9_-]`. Änderungen wirken erst nach dem Ausrollen in Coolify.
- **Desktop** (`components/crew/`):
  - `CrewTab.tsx`: volle Höhe. Container-Queries `@container`/`@3xl:`; schmal gibt es Reiter Chat, Leute und Aufgaben.
  - `CrewChat.tsx`: Feed und Nachrichten als eine Unterhaltung, Enter sendet. Wird im Reiter und in der Bubble genutzt.
  - `CrewBubble.tsx`: verschiebbar, Position in localStorage `forge.crew.bubble`. Ungelesen-Stand über `useCrewRead` in `lib/crew.ts` (localStorage `forge.crew.read`). Bei sichtbarem Crew-Reiter ausgeblendet.
  - `MirrorBar.tsx`: ersetzt im Chat den Composer, wenn die Session eine Kopie ist (`session.mirror`).
  - Seitenleiste `OpenSessions.tsx` mit Crew-Kennzeichen am Projekt und Live-, Kopie- bzw. Team-Kennzeichen an Sessions.
- **Telefon:** `crew` mit `session_view`, `session_takeover` und `session_answer`, dazu `settings` mit `share_sessions`.

## Sessions anderer (crew/share.ts)
- **Ablauf:**
  - A schickt `share_ask` (Mitglied, Session-ID, Modus) in den Crew-Raum.
  - B entscheidet je nach `shareAgents`: bei `ask` als Anfrage in `crew.shareRequests` plus notice `share`, bei `auto` sofort, bei `off` mit Absage.
  - B antwortet mit `share_answer` und einem zufälligen eigenen Raum.
  - B schickt die Kopie gzip-komprimiert, base64-kodiert und in Stücke zu 180k Zeichen geteilt (`chunk`), mit dem Crew-Schlüssel und AAD `<raum>|room:<epoch>` versiegelt. So landen die großen Stücke nicht im Crew-Raum mit seinen 500 Plätzen.
- **Ansehen (view):**
  - `sessions.importCopy` mit `mirror` (Spalte `sessions.crew_mirror`).
  - B schickt danach neue Events als `live`-Batches (n fortlaufend, 1 s gesammelt), A hängt sie mit `appendMirror` an.
  - A schickt alle 4 min `share_keep`. B beendet nach 10 min ohne `keep` oder nach 4 h.
  - Nach einem Neustart setzt `endMirrors` alle Kopien auf nicht mehr live.
- **Übernehmen (takeover):**
  - B holt das Transkript `~/.claude/projects/<cwd, Nicht-Alphanumerisches zu "->/<id>.jsonl` (sucht notfalls in allen Ordnern).
  - B erstellt Git-Daten mit `WorktreeService.snapshot` (Commit des Arbeitsstands mit temporärem Index). Basis ist `merge-base HEAD origin/<branch>`, das Bundle `refs/forge-share/<request>` geht von Basis bis Snapshot.
  - A holt den Stand mit `git fetch` aus dem Bundle (vorher bei Bedarf `fetch origin`), legt den Worktree auf `crew/<mitglied>/<titel>` mit `startAt: snapshot` an und macht dann `reset --mixed <head>`, damit nicht committete Änderungen nicht committet bleiben.
  - A schreibt das Transkript mit neuer Session-ID; Bens Projektpfad wird in der JSON-Schreibweise durch den Worktree-Pfad ersetzt.
  - Daraus entsteht `importCopy` mit `claudeSessionId`, sodass die nächste Nachricht mit `resume` weitermacht.
- **Kopien:**
  - `db.importEvents` bucht keinen Verbrauch. `appendEvent` würde bei `turn.result` `claude_usage` schreiben, also Bens Tokens als unsere zählen.
  - Kopien nehmen keine Nachrichten an: `assertWritable` in `SessionService.send`, `resume` und `edit`.
  - Crew-Präsenz ignoriert Mirror-Sessions, `listTeamSessions` lässt sie weg.
  - Das Team-Board einer Live-Kopie zeigt die Mitglieder, aber keine Freigabe-Knöpfe.
- **Test:** `test/crew.test.ts` „lets a member watch …“ läuft durchgehend mit zwei Installationen, einem Relay im selben Prozess und echtem Git. Unter Windows checkt Git mit CRLF aus, deshalb vergleicht der Test normalisiert.

## Ablauf (Grundlagen)
- **Daten:** Datensätze liegen in `<Datenordner>/crew/<id>.json`, das Profil in `profile.json`, die Schlüssel als Secret `crew-<id>`. Backup und Sync lassen `crew-*` aus.
- **Beitritt:** über `join_request` mit X25519, Annahme mit `join_accept`. Entfernen kann nur der Gründer; dabei gibt es einen neuen Schlüssel pro Epoche.
- **Präsenz:** wird alle 30 s gesendet und nach Änderungen entprellt. Als online gilt ein Mitglied, das in den letzten 90 s zu hören war. Eine Session mit Hintergrund-Agenten zählt als „arbeitet“; Team-Sessions melden `team.working`.
- **Hinweise an Agenten:** PreToolUse-Warnung bei Dateien, die andere bearbeiten, und PostToolUse- bzw. nächste-Nachricht-News. Gilt auch für Subagenten.
- **Git:** Eigener Push wird über die Autor-E-Mail erkannt. Bei Pushes anderer folgen `git.incoming` und Auto-Pull, solange das Projekt nicht beschäftigt ist.

## Stolperfallen
- Ältere FORGE-Versionen verwerfen unbekannte Raumnachrichten (zod-Union). Neue Felder in bestehenden Typen deshalb optional halten (z. B. `CrewAgent.team`).
- Bash- und Python-Heredocs verlieren `\n` und Backslashes. Code-Ersetzungen als Skriptdatei schreiben oder das Edit-Werkzeug nehmen.
- `rmSync` löscht unter Umlaut-Pfaden auf Windows mit Node 24.11 nichts; stattdessen `unlinkSync` bzw. `rmdirSync` verwenden.

---
title: "Crew: Live-Zusammenarbeit (CrewService, Relay, Sessions teilen, Crew-Chat, Crew im Browser /crew)"
summary: "Wie mehrere Leute gleichzeitig am selben Projekt arbeiten: Relay, Verschlüsselung, Beitritt, Präsenz, Hinweise, Push/Auto-Pull, Sessions teilen, Crew-Chat, Töne, GitHub-Bilder und Crew im Browser ohne FORGE (/crew auf der Website)."
tags: ["crew","zusammenarbeit","sidecar","relay","agenten","git","stats","stolperfalle"]
updated: "2026-10-23T11:07:18.416Z"
---

Seit 2026-10-22. Die Entscheidungen und ihre Begründungen stehen in `docs/adr/0015-crew-live-zusammenarbeit.de.md`. Der Name lautet „Crew“, weil „Teams“ die Agent-Teams sind (`teams/agent-teams.ts`).

## Wo was liegt
- **Protokoll:**
  - `packages/protocol/src/crew.ts` mit Crew, CrewMember (`web?`, `avatar?`), CrewAgent (`team?`), CrewTask, CrewFeedItem, CrewShare und CrewShareRequest, außerdem `CREW_RELAY_URL`, `CREW_WEB_URL`/`crewWebLink`, `CREW_AVATAR_PREFIX`/`isCrewAvatar` und die Share-Limits.
  - RPC `crew.*` in `rpc.ts`, Events `crew.updated` und `crew.notice` (Arten u. a. `share` und `shared`).
- **Sidecar** in `packages/sidecar/src/crew/`:
  - `crew-service.ts`: alles Fachliche. `loadAvatar` holt beim Start einmal das GitHub-Bild (`deps.avatar`, in `app.ts` aus `github.account()`), setzt es auf die eigene MemberCard und schickt `hello`.
  - `link.ts`: Verbindung zum Relay. Liest per SSE mit Reconnect und sendet per POST mit Outbox. Die Klasse `RelayLink` wird auch für Share-Räume genutzt.
  - `crypto.ts`: AES-256-GCM, AAD `room|kid`.
  - `wire.ts`: zod-Nachrichten, darunter `share_ask` (optional `events`), `share_answer`, `share_stop`, `share_keep` und `ShareMessage` für den Share-Raum. MemberCard mit optional `web` und `avatar`.
  - `state.ts`: Datensatz mit `shareAgents` (Standard `ask`) und LWW-Merge.
  - `share.ts`: Sessions anderer.
  - `session-tools.ts`.
- **Relay:** Teil der Website `services/stats` (`src/lib/crew-relay.ts`). Es speichert nur im Arbeitsspeicher, höchstens 256 KB pro Nachricht, 500 Nachrichten pro Raum und 240 POSTs pro Minute und IP. Räume sind beliebige IDs mit 16 bis 64 Zeichen aus `[A-Za-z0-9_-]`. Änderungen wirken erst nach dem Ausrollen in Coolify.
- **Desktop** (`components/crew/`):
  - `CrewTab.tsx`: volle Höhe. Container-Queries `@container`/`@3xl:`; schmal gibt es Reiter Chat, Leute und Aufgaben. Browser-Mitglieder mit Globus „Browser“.
  - `CrewDialogs.tsx`: `InviteDialog` (Code, „Link kopieren“, der QR-Code enthält den Web-Link) und `MemberAvatar` (GitHub-Bild mit `avatar`, sonst Initialen).
  - `CrewChat.tsx`: Feed und Nachrichten als eine Unterhaltung, Enter sendet. Wird im Reiter und in der Bubble genutzt.
  - `CrewBubble.tsx`: verschiebbar, Position in localStorage `forge.crew.bubble`. Ungelesen-Stand über `useCrewRead` in `lib/crew.ts` (localStorage `forge.crew.read`). Bei sichtbarem Crew-Reiter ausgeblendet.
  - `MirrorBar.tsx`: ersetzt im Chat den Composer, wenn die Session eine Kopie ist (`session.mirror`).
  - Seitenleiste `OpenSessions.tsx` mit Crew-Kennzeichen am Projekt und Live-, Kopie- bzw. Team-Kennzeichen an Sessions.
  - Töne (`lib/sounds.ts`, in `crewNotice` von `lib/crew.ts`): `knock` (Klingel) bei Beitrittsanfrage, Session-Anfrage und Aufgabe für mich, `message` bei Nachrichten. Hängen an der Einstellung `sounds`; Vorhören in Einstellungen > Töne.
- **Telefon:** `crew` mit `session_view`, `session_takeover` und `session_answer`, dazu `settings` mit `share_sessions`. Browser-Mitglieder heißen dort „(im Browser)“.

## Crew im Browser (/crew, seit 2026-10-23)
- Seite `services/stats/src/app/crew/page.tsx` (noindex), Oberfläche `src/components/crew-web/`, Kern ohne Framework in `src/lib/crew-web/` (`crypto.ts` WebCrypto, `wire.ts`, `link.ts`, `client.ts` mit `CrewWebClient`, Texte `messages.ts`).
- Einladungslink `https://forge.vanturis.de/crew#forge-crew1.…`: Der Code steht hinter `#`, erreicht also nie den Server; die Seite liest ihn einmal und nimmt ihn aus der Adresszeile. FORGEs `decodeInvite` sucht das Präfix irgendwo im Text, deshalb nimmt FORGE den Link auch als Code.
- Der Browser ist ein eigenes Mitglied (eigener X25519-Schlüssel, `web: true` auf der MemberCard), kommt nur nach Prüfcode herein und zählt zu den 8 Plätzen. Schlüssel und Stand liegen in `localStorage` (`forge.crew.web`, `forge.crew.web.<id>`, Profil `forge.crew.web-profile`).
- Kann: Chat lesen und schreiben, Aufgaben anlegen/ändern/löschen, Beitrittsanfragen annehmen, Session live ansehen (`share_ask` mit `events: 400`; ältere FORGE schicken alles, bei echten Sessions bis etwa 13 Teile, geht in wenigen Sekunden). Hat keine Sessions und lehnt `share_ask` an sich ab. Sendet alle 30 s eine leere Präsenz, damit er online gilt. Nach dem Entsperren des Handys (`wake`) schickt er sofort `share_keep`; beendete Live-Ansichten haben „Erneut versuchen“.
- **Leute** wie FORGEs Seitenleiste: Projekt (Crew-Projekt, Branch, ungepushte Commits), darunter Sessions (`CrewAgent.branch` null), dann parallele Agenten (mit Branch); Bogenlinien wie `Branch` in `OpenSessions.tsx`. Ein Klick auf eine Zeile öffnet die Live-Ansicht.
- **Live-Ansicht** ist FORGEs Chat nachgebaut (Wunsch des Nutzers: 1:1): `lib/crew-web/chat-items.ts` (Faltung wie `apps/desktop/.../chat-items.ts`, nur Hauptgespräch, Schlüssel nach Position, weil die Kopie keine seq/ts hat), `lib/crew-web/tool-view.ts` (Kopie von `tool-view.ts`), `components/crew-web/session-chat.tsx` (ChatRow mit Gutter, ClaudeMark am Antwortbeginn, ToolCard mit Statuspunkt, Diff- und Ausgabevorschau, Details aufklappbar, TodoCard, Freigabe nur lesend, Ergebniszeile, FORGE-Karten) und `.fc-*`/`.markdown` in `app/crew/crew.css` mit Größen und Farben aus `apps/desktop/src/styles.css`. Markdown mit `react-markdown` und `remark-gfm` (wie FORGE). Pfade relativ zu `payload.cwd` der Kopie. Änderungen am FORGE-Chat hier nachziehen.
- **Stolperfallen:**
  - Längenprüfungen in `crew-web/wire.ts`: `str()` hat 100.000 Zeichen als Standard, ein Share-`chunk` hat bis 180.000. Das ließ jede echte Session-Kopie stumm verwerfen (Ansicht blieb bei „wird übertragen“), weil Testsessions in ein kurzes Stück passten. Der Test nutzt deshalb eine kaum komprimierbare 400-KB-Session mit mehreren Teilen.
  - `wire.ts` ist eine Kopie der Sidecar-Formen ohne zod: Die Sidecar-Tests importieren `client.ts` direkt aus `services/stats`, dort sind im CI keine Website-Pakete installiert. Neue Nachrichtenfelder in beiden Dateien nachziehen. `chat-items.ts` und `session-chat.tsx` importiert der Sidecar nicht, dort dürfen Website-Pakete stehen.
  - Keine DOM-Typnamen (`AesGcmParams`, `CryptoKeyPair`) in `crew-web/crypto.ts`: Der Sidecar kompiliert die Datei ohne DOM-Lib mit.
  - Pakete der Website mit `pnpm add --ignore-workspace` in `services/stats` installieren; ohne den Schalter bricht pnpm am Monorepo-Workspace ab („undefined is not a function“).
  - `.crew-page svg` setzt alle Symbole auf 16 px und schlägt das `width`-Attribut: Größere oder kleinere SVGs (ClaudeMark) brauchen ein Inline-`style` oder eine eigene Regel.
  - Profilbilder nur von `https://avatars.githubusercontent.com/` (`isCrewAvatar`/`isAvatar`): Ein Mitglied darf die anderen keine beliebige Adresse laden lassen. Ältere FORGE geben Karten ohne `avatar` weiter; `mergeMember` überschreibt das Bild deshalb nur, wenn die Karte eins hat.
  - WebCrypto ist async: Eingehende Umschläge laufen über eine Promise-Kette, sonst geraten Beitritt und Rekey durcheinander. WebCrypto hängt das GCM-Tag an, der Sidecar hält es getrennt.
  - `.btn-outline` der Website ist für Links gebaut; auf `<button>` bleibt sonst das Grau des Browsers (in `crew.css` überschrieben).
  - `next dev` der Website lud in dieser Umgebung die Seite in einer Schleife neu (auch `/stats`). Zum Prüfen `pnpm build` und `pnpm start` nehmen. Schreiben außerhalb des Projekts ist im Autonomous-Profil gesperrt: Hilfsdateien im Projekt ablegen und danach löschen.
  - Gegen den echten Relay oder mit echten Sessions prüfen: ein tsx-Skript in `packages/sidecar` mit `CrewService` (Relay lokal `http://localhost:3917/crew` oder `https://forge.vanturis.de/crew`, Events einer echten Session aus `%APPDATA%/forge/forge.db`, nur lesend) und dem Browser über `preview_interact`; danach löschen.
- **Test:** `test/crew.test.ts` „lets someone follow the crew in the browser …“ (Beitritt, Nachricht, Aufgabe, Präsenz, GitHub-Bild, Live-Ansicht mit mehreren Teilen, Neuladen, Entfernen), der Krypto-Abgleich Node gegen WebCrypto und `services/stats/src/lib/crew-web/chat-items.test.ts`.

## Sessions anderer (crew/share.ts)
- **Ablauf:**
  - A schickt `share_ask` (Mitglied, Session-ID, Modus, optional `events`) in den Crew-Raum.
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
- **Hinweise an Agenten:** PreToolUse-Warnung bei Dateien, die andere bearbeiten, und PostToolUse- bzw. nächste-Nachricht-News. Gilt auch für Subagenten. `crew_status` nennt Browser-Mitglieder mit dem Hinweis, dass sie keine Sessions haben.
- **Git:** Eigener Push wird über die Autor-E-Mail erkannt. Bei Pushes anderer folgen `git.incoming` und Auto-Pull, solange das Projekt nicht beschäftigt ist.

## Stolperfallen
- Ältere FORGE-Versionen verwerfen unbekannte Raumnachrichten (zod-Union). Neue Felder in bestehenden Typen deshalb optional halten (z. B. `CrewAgent.team`, `MemberCard.web`, `MemberCard.avatar`, `share_ask.events`).
- Bash- und Python-Heredocs verlieren `\n` und Backslashes (auch in Regex wie `/\\/g`). Code-Ersetzungen als Skriptdatei schreiben oder das Edit-Werkzeug nehmen.
- `rmSync` löscht unter Umlaut-Pfaden auf Windows mit Node 24.11 nichts; stattdessen `unlinkSync` verwenden.
- Die Telefon-Testdaten in `test/phone-call.test.ts` („works in a crew …“) müssen alle Pflichtfelder von `Crew` haben (`shareAgents`, `shareRequests`, `shares`), sonst bricht `crew status` mit „Cannot read properties of undefined“ ab.

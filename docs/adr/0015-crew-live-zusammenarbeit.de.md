<a href="0015-crew-live-collaboration.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0015: Crew – mehrere FORGE-Installationen arbeiten live an einem Projekt

Datum: 2026-10-22 · Status: angenommen

## Ziel

Zwei oder mehr Menschen arbeiten mit FORGE gleichzeitig am selben Projekt, jeder auf seinem Rechner, ohne
Worktrees. Ihre Agenten wissen jederzeit, was die Agenten der anderen tun, was fertig ist und was noch offen
ist, und können sich Arbeit teilen. So arbeitet mehr Agentenkraft parallel, ohne doppelte Arbeit und ohne
Konflikte.

## Entscheidungen

**Relay statt Peer-to-Peer.** Rechner hinter NAT erreichen sich nicht direkt. Ein kleiner Relay hält pro Raum eine nummerierte Liste von Nachrichten und
liefert sie per Server-Sent Events aus; geschrieben wird per POST. Kein WebSocket: Node hat dafür keinen
eingebauten Server, SSE und `fetch` laufen ohne Pakete auf beiden Seiten und durch jeden Proxy. Der Relay
merkt sich die neuesten Nachrichten eine Weile, damit ein Mitglied nach einer Pause aufholt.

**Relay in der Website.** Der Relay ist Teil der FORGE-Website (`services/stats`, Next.js, Routen
`/crew/v1/rooms/<raum>` und `/crew/v1/rooms/<raum>/stream`, Kern ohne Framework-Code in `lib/crew-relay.ts`).
Er läuft im selben Container wie die Website: keine eigene Domain, Ressource oder Bereitstellung. Next bündelt
jede Route einzeln, deshalb liegt der eine Relay des Prozesses auf `globalThis`. Der Stream sendet
`Cache-Control: no-transform`, damit der Proxy davor ihn nicht komprimiert und puffert. Der Relay braucht keine
Datenbank; er läuft auch, wenn Postgres weg ist.

**Ende-zu-Ende-verschlüsselt.** Alles im Raum ist mit dem Crew-Schlüssel versiegelt (AES-256-GCM, Raum und
Schlüssel-Kennung als AAD). Der Relay sieht nur Raum, Absender-Kennung und verschlüsselte Bytes.

**Beitritt mit Einladung und Freigabe.** Der Einladungscode (`forge-crew1.…`, auch als QR-Code) enthält
Relay, Raum, einen eigenen Einladungsschlüssel, den Ablauf (24 h) sowie Crew, Projekt und Herkunft (origin)
für die Vorschau. Mit ihm kann man nur um Beitritt bitten. Die Anfrage enthält einen X25519-Schlüssel des
Neuen; ein Mitglied lässt ihn herein und schickt den Crew-Schlüssel, versiegelt mit dem gemeinsamen
Schlüssel aus X25519 und HKDF. Beide Seiten zeigen denselben Prüfcode (Fingerabdruck des Schlüssels), damit
man ihn vor dem Annehmen am Telefon oder im Chat abgleichen kann. Wer nur den Code mitgelesen hat, kommt nicht
an den Crew-Schlüssel. Ein neuer Code macht den alten ungültig.

**Entfernen mit neuem Schlüssel.** Nur wer die Crew gegründet hat, entfernt Mitglieder. Dabei entsteht ein
neuer Crew-Schlüssel, versiegelt für jedes verbleibende Mitglied. Der Entfernte liest nur, dass er draußen
ist.

**Jeder hat den ganzen Stand.** Kein Server-Zustand: Jedes Mitglied hält Mitglieder, Aufgaben (der neueste
Stand nach `updatedAt` gewinnt, gelöschte bleiben als Grabstein), Feed und Präsenz selbst
(`<Datenordner>/crew/<id>.json`; die Schlüssel liegen im Secret-Store und nie in Backups oder im
GitHub-Sync). Ein `hello` nach dem Verbinden wird mit dem ganzen Stand beantwortet. So schadet ein Neustart
des Relays nicht.

**Projekt über origin, Code über Git.** Ein Projekt gehört zur Crew, wenn sein origin auf dasselbe
Repository zeigt (`remoteIdentity`: Host/Besitzer/Repo, https und ssh gleich). Code reist nicht über den
Relay, sondern über Git: FORGE erkennt eigene Pushes (Commits der eigenen Git-Identität auf
`origin/<branch>`) und meldet sie der Crew. Die anderen holen sie (`git fetch`) und übernehmen sie auf Wunsch
selbst (`autoPull`, Standard an), solange in ihrem Projekt keine Session arbeitet. Dafür dient das
vorhandene `GitEngine.pull` (Rebase, nicht committete Arbeit in den Stash und zurück, Konflikte brechen ab).

**Was Agenten erfahren.** Drei Wege, alle in `crew/crew-service.ts` und `crew/session-tools.ts`:

1. Start-Kontext und die Werkzeuge `crew_status`, `crew_task` und `crew_message` (alle ohne Rückfrage).
2. Neuigkeiten (Nachrichten, Aufgaben, fertige Aufträge, Pushes, Überschneidungen) als Hinweis mit der
   nächsten Nachricht (`TurnHost.note`) und live nach Werkzeugaufrufen (PostToolUse-Hook mit
   `additionalContext`).
3. Vor jedem Edit/Write auf eine Datei, die bei einem anderen Mitglied in Arbeit ist, eine Warnung
   (PreToolUse-Hook mit `additionalContext`, einmal pro Session und Datei in 10 Minuten).

**Was jeder teilt (Präsenz).** Branch, nicht gepushte Dateien (Arbeitsstand und eigene Commits), Anzahl
ungepushter Commits und je Session: Titel, Status, aktueller Auftrag, im Durchlauf geänderte Dateien und
letztes Ergebnis. Fertige Durchläufe landen im Feed. Prompts und Ergebnisse gehen damit an die
Crew-Mitglieder. Das ist der Zweck, steht aber auch so in der Oberfläche.

**Mehr Agentenkraft.** Aufgaben haben eine Zuweisung. Bekommt ein Mitglied eine, startet sein FORGE je nach
Einstellung (`acceptTasks`: auto, ask, off) selbst eine Session dafür; deren erfolgreiches Ende markiert die
Aufgabe als erledigt.

**Crew im Browser (Nachtrag 2026-10-23).** Wer gerade nicht am Rechner ist, folgt der Crew auf der Website
(`/crew`, auch am Handy). Der Einladungslink (`https://forge.vanturis.de/crew#<code>`, auch im QR-Code)
öffnet sie; FORGE nimmt denselben Link als Code. Der Browser ist ein eigenes Mitglied mit eigenem
X25519-Schlüssel (Kennzeichen `web` auf der Mitgliedskarte) und kommt wie jede Installation nur nach dem
Prüfcode herein. Bewusst kein Zugang per geteiltem Crew-Schlüssel ohne Freigabe: Dann könnte man ihn beim
Entfernen nicht ausschließen. Der Browser liest Chat, Leute, Aufgaben und Beitrittsanfragen, schreibt
Nachrichten und Aufgaben, lässt andere herein und sieht eine Session live (`share_ask` mit `events`: nur die
neuesten 400 Ereignisse; ältere FORGE-Versionen ignorieren das Feld und schicken alles). Sessions hat er
keine, Anfragen danach lehnt er ab. Schlüssel und Stand liegen in `localStorage` dieses Browsers.

## Folgen

- Die Website muss mit diesen Routen laufen (in Coolify ausgerollt), sonst bleibt jede Crew offline. Eigene
  Relays sind möglich (Relay-Adresse im Crew-Profil).
- Der Relay hält seine Räume im Speicher des Website-Prozesses: Ein neues Ausrollen vergisst sie, die
  Mitglieder tauschen ihren Stand dann wieder aus. Mit mehreren Website-Instanzen würde der Relay zerfallen;
  die Website läuft als eine.
- Höchstens 8 Mitglieder pro Crew: Jeder beantwortet ein `hello` mit dem ganzen Stand.
- Die Absender-Kennung im Raum ist nicht signiert. Alle Mitglieder kennen den Crew-Schlüssel und vertrauen
  einander; nur das Entfernen und das Gründer-Kennzeichen sind gegen andere Mitglieder geschützt.

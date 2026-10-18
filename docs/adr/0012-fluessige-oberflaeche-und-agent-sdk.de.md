<a href="0012-fluessige-oberflaeche-und-agent-sdk.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0012: Flüssige Oberfläche, Agent SDK weiter ausgebaut

Datum: 2026-10-12 · Status: angenommen

## Oberfläche: Performance

Ausgangslage: Jedes gestreamte Token löste einen eigenen React-Commit aus, rendert den ganzen Chat samt Composer neu
und erzwang über das Auto-Scrollen ein Layout. Jeder Fensterwechsel lud alle sichtbaren Listen neu (Git-Status aller
Projekte, Transkript-Scan); währenddessen stockte der Sidecar und Text kam in Schüben.

- **Rust-Hülle:** ein Lese- und ein Sende-Thread. Was sich angestaut hat, geht als ein Event `sidecar://messages`
  (Liste von Zeilen, höchstens 256) an die Webview. Eine einzelne Zeile geht sofort raus, nichts wartet auf ein Bündel.
- **Session-Store:** Text-Deltas werden gesammelt und einmal pro Frame (`requestAnimationFrame`) geschrieben. Jedes
  andere Event schreibt vorher die wartenden Deltas, damit der fertige Text nicht von späteren Deltas überschrieben
  wird. `markAllStale` und `drop` verwerfen wartende Deltas.
- **Chat:** Composer und Indikatoren sind memoisiert. Auto-Scroll per ResizeObserver statt `scrollHeight` bei jedem
  Render. Scrollposition und gemessene Zeilenhöhen bleiben pro Session erhalten (`initialMeasurementsCache`,
  `initialOffset`). Chat-Einträge werden inkrementell aufgebaut (`IncrementalItems`): Neue Events kosten nur ihre
  eigene Arbeit; ändert sich der Anfang (ältere Seiten), wird neu aufgebaut.
- **Markdown beim Streaming:** in Blöcke an Leerzeilen geteilt (Code-Fences bleiben ganz), nur der letzte Block wird
  neu geparst; Takt 50 ms statt 100 ms. Fertige Nachrichten als Ganzes.
- **Werkzeug-Karten:** Diff und JSON der Eingabe pro Eingabeobjekt zwischengespeichert (WeakMap).
- **Abfragen:** Standard ohne Neuladen bei Fokus, 30 s frisch. Git-Status (5 s), Projektliste und Session-Listen
  (je 60 s) laden bei Fokus nach, weil sie sich außerhalb von FORGE ändern. `session.updated` patcht die Liste des
  Projekts und die Liste laufender Sessions, statt sie neu zu laden. Der Sidecar hält den Transkript-Scan je Ordner
  20 s vor (geleert beim Löschen einer Session).
- **Verlauf:** `sessions.events` liefert 2.000 statt 20.000 Events pro Seite (`HISTORY_PAGE_LIMIT`); interne Aufrufe
  (Zusammenfassung) lesen weiter bis 20.000.
- **Start:** Sessions, Einstellungen, GitHub und Erweiterungen laden bei Bedarf und werden nach dem Start im
  Leerlauf vorgeladen. CodeMirror, xterm und qrcode sind eigene Chunks. Startbundle von 2.012 kB auf rund 990 kB.

## Oberfläche: Bewegung und Rückmeldung

Vorher gab es kaum Bewegung: Dialoge, Menüs, Toasts, Ansichten und Aufklapp-Bereiche erschienen in einem Frame,
Klicks warteten auf den Sidecar, bevor sich etwas tat.

- **Grundlagen** (`styles.css`, `lib/motion.ts`): Dauer- und Easing-Tokens, Keyframes; animiert wird nur `opacity`
  und `transform` (Aufklappen über `grid-template-rows`). `prefers-reduced-motion` schaltet global alles ab.
  Keine zusätzliche Bibliothek.
- **Ein- und Ausblenden:** Dialoge, Befehlspalette, Menüs, Select, Tooltips (Radix `data-state`), Toasts (mit Pause
  beim Darüberfahren). Ansichten, Tabs, Sessions und rechte Spalte blenden beim Wechsel ein, nie aus: Ein Wechsel
  wartet nicht. Tab-Leiste mit gleitendem Indikator, fette aktive Tabs ohne Springen der Nachbarn.
- **Sofortige Rückmeldung:** eigene Nachricht erscheint sofort (`stores/pending-messages.ts`, ersetzt durch das echte
  Event, bei Fehler zurück ins Eingabefeld). Freigaben, Modell, Effort, Plan-Modus, Stopp, Favorit und Profil zeigen
  den neuen Stand beim Klick und springen bei Fehlern zurück. Gedrückt-Zustand auf Buttons und Tabs.
- **Laden:** Skeletons in der Form des Inhalts statt Spinner; Ordner im Dateibaum laden beim Darüberfahren vor.
- **Chat:** neue Zeilen gleiten einmal herein (nicht beim Laden des Verlaufs, nicht beim Zurückscrollen,
  `lib/arrivals.ts`); „Zum Ende“ über dem Eingabefeld, sobald man hochgescrollt hat. Aufklapp-Inhalte werden erst
  beim Öffnen gerendert.
- **Darstellung:** Fensterfarbe der Hülle gleich der App (kein Farbblitz beim Start), einheitlicher Fokus,
  dezente Scrollbars.

## Agent SDK

- **Verzweigen** (`sessions.fork`): neue Session mit dem Verlauf bis vor einer eigenen Nachricht
  (`forkSession(…, { upToMessageId })`, Fork-Punkt ist der Transkript-Eintrag vor der Nachricht). FORGE kopiert die
  Events davor, das Eingabefeld des Zweigs ist mit der Nachricht vorbelegt, das Original bleibt. Auf Wunsch werden
  vorher die Dateien zurückgesetzt (Forks haben keine Datei-Checkpoints). Vor der ersten Nachricht: neue Session.
  Verworfen: `resumeSessionAt` auf derselben Session; das ändert den Verlauf, den der Nutzer gerade sieht.
- **FORGE-Werkzeuge in jeder Session** (MCP-Server `forge` im Prozess, `sessions/forge-tools.ts`): `start_agent`
  (paralleler Agent in neuem Worktree, wie im Tab „Agenten“), `agent_status`, `message_agent`, `notify`
  (Hinweis in FORGE, mit `urgent` auch Anruf). `agent_status` und `notify` sind ohne Rückfrage erlaubt, die anderen
  laufen durch die normalen Freigaben und die Sperrliste. Agenten bekommen nur `notify`: eine Ebene, keine Ketten;
  höchstens 4 laufende Agenten pro Session. Die Zuordnung Agent → Session lebt im Speicher. Was FORGE anbietet,
  steht im Startkontext (SessionStart-Hook, `additionalContext`).
- **Aufgaben:** `agentProgressSummaries` (Subagenten schreiben etwa alle 30 s eine Zeile Fortschritt),
  `perTaskStopAffordance` (Stopp beendet nur den Durchlauf, Hintergrund-Aufgaben laufen weiter und werden einzeln
  gestoppt: `sessions.stopTask`), `backgroundTasks` (`sessions.toBackground`, wie Strg+B). `Session.subagents`
  zeigt laufende Subagenten mit Fortschritt; Hintergrund-Aufgaben tragen `summary`.
- **Strukturierte Antworten:** PR-Titel und -Text per `outputFormat: json_schema` (`completeJson`, `maxTurns: 3`),
  Rückfall auf das Textformat. Mit der echten CLI geprüft (Haiku, 4 s).
- **Ausweichmodell:** Opus fällt bei Überlastung auf Sonnet zurück (`fallbackModel`); andere Modelle ohne.
- Nicht umgesetzt: `maxTurns`/`maxBudgetUsd` als Grenze für Agenten. Beide zählen über die ganze Laufzeit eines
  Streaming-Prozesses und würden lange Sessions abbrechen; bei Abo sind Kosten nur ein API-Äquivalent.

## Tests

Desktop: Token-Bündelung und Reihenfolge, Markdown-Blöcke, Caches. Sidecar: Verzweigen (inkl. Dateien und erster
Nachricht), FORGE-Werkzeuge mit echtem Git-Worktree, Subagenten-Fortschritt, Stopp und Hintergrund.

---
title: "Statistik-Dienst services/stats (forge-stats.vanturis.de, Coolify, außerhalb des Workspace)"
summary: "Wie der Next.js-Statistikdienst in services/stats gebaut, getestet, gestaltet (Animationen, Live-Abfrage) und in Coolify betrieben wird (Tagesstände, Verlauf, Online, Abos, Diagramme), und welche Stolperfallen es dabei gibt."
tags: ["stats","coolify","release","stolperfalle","windows","ui"]
updated: "2026-10-18T10:22:21.312Z"
---

# Statistik-Dienst services/stats (forge-stats.vanturis.de, Coolify, außerhalb des Workspace)

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge-stats.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (URL in `packages/protocol/src/support.ts`, `USAGE_STATS_URL`) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`. Deploy in Coolify geschieht nicht automatisch beim Push.

## Meldeintervall
Die App meldet alle 5 Minuten. Die Sperre pro installId (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`) steht deshalb auf 4 Minuten: gleich lang wie das App-Intervall würde jede zweite Meldung mit 429 abweisen, sobald der Timer etwas früh feuert. „Gerade online“ = Meldung in den letzten `ONLINE_MINUTES` (10, zwei Intervalle, in `src/lib/constants.ts`). Ändert die App ihr Intervall, beide Konstanten, `db.test.ts` und die Texte (Seite, README) mitziehen.

## Verlauf (install_days), Entscheidungen 2026-10-18
- Jede angenommene Meldung schreibt in einem Statement (CTE) `installs` und den Stand des laufenden UTC-Tages in `install_days`; bei 429 wird keins von beiden geschrieben. FK mit `ON DELETE CASCADE`, DELETE der Installation löscht die Tagesstände.
- Zuwachs pro Tag rechnet SQL (`historySql()` in `src/lib/history.ts`, LAG über die Fenster-Tage plus den letzten Stand vor dem Fenster). Bewusst nicht in TS: sonst müssten alle Tagesstände (Installationen x 31 JSON-Zeilen) alle 5 Minuten zum Prozess.
- Ein Zähler, der im früheren Stand fehlt, zählt nicht als Zuwachs (`GREATEST(0, NULL)` ist 0 in Postgres). Grund: neue Zähler kommen mit einer App-Version, die ihren Gesamtstand seit Installation schickt; das wäre ein falscher Sprung.
- Test der SQL-Rechnung: `STATS_TEST_DATABASE_URL=... pnpm test` (sonst übersprungen). Er nutzt Tage im Jahr 2001, damit andere Daten nicht stören.
- Die maximale gültige Meldung (mit `models` und `plan`) ist ca. 2,9 KB, die 4-KB-Grenze passt noch; ein Test prüft das.

## Abos, Modelle, Kosten (Entscheidungen 2026-10-18, vom Besitzer)
- `plan` (Spalte `installs.plan`, z. B. `max_20x`, `max_5x`, `pro`, null = unbekannt) zeigt das Diagramm „Claude-Abos“: aktive Installationen der letzten 30 Tage je Abo, Tag „x online“ mit Live-Punkt. Unbekannt steht zuletzt und grau (`sortPlans` in `src/lib/plans.ts`). Gibt es gar kein bekanntes Abo (alle Installationen vor 0.1.91), zeigt die Karte einen Hinweis statt eines einzelnen Balkens „Unbekannt“.
- `[1m]`-IDs (z. B. `claude-opus-5-5[1m]`, dasselbe Modell mit 1M-Kontext) fasst `modelLabel` mit der normalen ID zusammen; der Besitzer will sie nicht getrennt sehen. Gespeichert bleiben die Roh-IDs.
- „Wert in API-Preisen“ wirkt zu niedrig, weil Kosten erst seit der modelUsage-Version gemeldet werden; außerdem sind ~99 % Cache-Lesezugriffe (sehr billig). Die Kachel nennt „nur für X der Y Tokens bekannt“, wenn weniger als 99 % der Tokens Kosten haben.

## Live und Bewegung (Wunsch des Besitzers 2026-10-18: „dynamisch, mit Animationen“)
- `src/components/live-stats.tsx` (Client) hält die Summen im State: `GET /api/v1/live` alle 30 s (Online gesamt und je Abo, 15 s Server-Cache, `getOnline()` in `db.ts`), `/api/v1/totals` alle 5 min; pausiert bei verdecktem Tab, holt beim Zurückkehren sofort nach. Der Online-Wert aus `/live` überschreibt den aus den 5-Minuten-Summen (die Kachel und die Abo-Tags müssen übereinstimmen).
- `src/components/tiles.ts` (ohne `"use client"`) hält Kachel-Definitionen für Skeleton (Server) und Live-Kacheln (Client). Funktionen aus einer `"use client"`-Datei kann eine Server-Komponente nicht aufrufen, und `db.ts` (pg) darf nicht in den Client-Bundle: deshalb `constants.ts` und nur `import type` aus `db.ts` in Client-Dateien.
- `src/components/motion.tsx`: `AnimatedNumber` zählt hoch, sobald sichtbar (IntersectionObserver), gleitet nach Aktualisierung zum neuen Wert; Server-HTML und Screenreader bekommen den Endwert über `.sr-only`. `Reveal` blendet Diagrammabschnitte beim Scrollen ein und startet die Balken-Animationen (`animation-play-state`).
- CSS am Ende von `globals.css` (Abschnitt „motion“): `forge-ping` für `.live-dot-on`, `forge-rise` für Kacheln (fill `backwards`, nicht `both`: ein gehaltener Endzustand blockiert das Anheben beim Hover), `forge-grow-y/x` für Balken, `col-latest` atmet. `prefers-reduced-motion` kürzt alles auf den Endzustand; ein `<noscript>`-Style in `layout.tsx` zeigt `.reveal` ohne JS.
- Prüfen: preview_interact direkt nach `wait .tile-enter` zeigt Zahlen mitten im Hochzählen; untere Abschnitte erst nach `PageDown`/`End` sichtbar (fullPage-Screenshots zeigen sie leer). Live-Wechsel: `last_seen` per SQL zurücksetzen, ~36 s warten.

## Design
Die Seite übernimmt das Design der Desktop-App ohne Tailwind: Tokens aus `apps/desktop/src/styles.css` als CSS-Variablen in `src/app/globals.css` (nur dunkel, inkl. `--color-success`), Bausteine in `src/components/blocks.tsx`, Diagramme in `src/components/charts.tsx` (Client-Komponente) nach `usage-charts.tsx` des Tagesberichts. Eine Serie in `--color-accent-strong`, Hervorhebung Akzent gegen `--color-subtle`-Grau; mit dem dataviz-Validator gegen `#1a1e25` geprüft. Schrift Geist über das npm-Paket `geist` (next/font/local), nicht über next/font/google (bräuchte Netz beim Build).
- Kacheln: Raster mit 4 Spalten, 2 breite + 8 schmale Kacheln. Eine neue Kachel bricht das Raster; lieber eine bestehende zusammenlegen (so wurde „Aktiv in 30 Tagen“ zur Unterzeile von „Installationen“, Platz für „Gerade online“).
- Diagramm-Abschnitte haben je 2 Karten; eine einzelne Karte bekommt `wide` (`chart-card-wide`, volle Breite), wie „Tokens nach Modell“. `CARDS` im `ChartsSkeleton` mitziehen.

## Stolperfallen
- **Nicht im pnpm-Workspace** (Globs sind apps/* und packages/*). Im Ordner immer `pnpm install --ignore-workspace` bzw. `pnpm add --ignore-workspace`, eigenes `pnpm-lock.yaml`. Die Worktree-Vorbereitung von FORGE installiert hier nichts. Kein Prettier im Repo.
- **Kein `public/`-Ordner**: Das Dockerfile kopiert nur `.next/standalone` und `.next/static`. Bilder statisch importieren, Favicons als `src/app/icon.svg` / `apple-icon.png`.
- `pnpm exec tsc --noEmit` meldet vor dem ersten `pnpm build`/`next dev` Fehler (`RouteContext`, Bild-Importe), weil `next-env.d.ts` und `.next/types` fehlen. Nach dem Build ist es sauber.
- Ohne `outputFileTracingRoot` und `turbopack.root` in `next.config.ts` landet `server.js` unter `.next/standalone/services/stats/`; das Dockerfile erwartet es direkt in `.next/standalone`.
- `next dev` schreibt `services/stats/AGENTS.md` immer wieder neu. Die Datei ist deshalb committet.
- TypeScript bleibt auf ~6.0 wie im Rest des Repos.
- lucide-react 1.x hat keine Marken-Icons mehr (kein `Github`); für den GitHub-Link `GitFork`.
- Summen im Prozess 5 Minuten zwischengespeichert (`getTotals`), `schemaReady` ebenso. Nach Testdaten per SQL oder nach DROP TABLE den Dev-Server neu starten.
- TaskStop beendet unter Windows nur pnpm, der Next-Prozess (`start-server.js`) hält Port 4100 weiter. Danach Port prüfen und den eigenen Prozess (Kommandozeile mit `services\stats`) beenden.
- Die Sperre "20 neue IDs pro IP und Tag" liegt nur im Speicher und beginnt nach jedem Neustart von vorn. Der Dienst ist für eine Instanz gedacht.

## Lokal gegen Postgres testen
FORGE-Testdatenbank mit `dev_control database start` (URL aus der Antwort, der Port ändert sich gegenüber `dev_environment`). Dann im Ordner `DATABASE_URL=... pnpm exec next dev -p 4100`. Der Dev-Server von FORGE (`pnpm dev` im Root) ist der Tauri-Start und passt hier nicht. SQL ohne psql: kleines Node-Skript mit `require('pg')` aus `services/stats/node_modules`. Verlauf mit Inhalt: pro simuliertem Tag per curl melden, dann per SQL `UPDATE install_days SET day = day - N WHERE day = heute` und `UPDATE installs SET last_seen = now() - interval '5 minutes'` (sonst 429). Offline-Installationen: `last_seen` auf vor 2 Tagen setzen. Erst Daten anlegen, dann die Seite laden (Cache). Hover lässt sich mit preview_interact per Klick auf `.col`/`.hbar` prüfen (Fokus zeigt denselben Tooltip). Danach `installs` löschen (install_days per Cascade).

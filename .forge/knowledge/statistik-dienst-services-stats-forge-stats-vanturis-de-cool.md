---
title: "Statistik-Dienst services/stats (forge-stats.vanturis.de, Coolify, außerhalb des Workspace)"
summary: "Wie der Next.js-Statistikdienst in services/stats gebaut, getestet, gestaltet und in Coolify betrieben wird (Tagesstände, Verlauf, Diagramme), und welche Stolperfallen es dabei gibt."
tags: ["stats","coolify","release","stolperfalle","windows","ui"]
updated: "2026-10-17T23:36:03.675Z"
---

# Statistik-Dienst services/stats (forge-stats.vanturis.de, Coolify, außerhalb des Workspace)

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge-stats.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (URL in `packages/protocol/src/support.ts`, `USAGE_STATS_URL`) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`.

## Meldeintervall
Die App meldet alle 5 Minuten. Die Sperre pro installId (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`) steht deshalb auf 4 Minuten: gleich lang wie das App-Intervall würde jede zweite Meldung mit 429 abweisen, sobald der Timer etwas früh feuert. Ändert die App ihr Intervall, Konstante, `db.test.ts` und die Texte (Seite, README) mitziehen.

## Verlauf (install_days), Entscheidungen 2026-10-18
- Jede angenommene Meldung schreibt in einem Statement (CTE) `installs` und den Stand des laufenden UTC-Tages in `install_days`; bei 429 wird keins von beiden geschrieben. FK mit `ON DELETE CASCADE`, DELETE der Installation löscht die Tagesstände.
- Zuwachs pro Tag rechnet SQL (`historySql()` in `src/lib/history.ts`, LAG über die Fenster-Tage plus den letzten Stand vor dem Fenster). Bewusst nicht in TS: sonst müssten alle Tagesstände (Installationen x 31 JSON-Zeilen) alle 5 Minuten zum Prozess.
- Ein Zähler, der im früheren Stand fehlt, zählt nicht als Zuwachs (`GREATEST(0, NULL)` ist 0 in Postgres). Grund: neue Zähler kommen mit einer App-Version, die ihren Gesamtstand seit Installation schickt; das wäre ein falscher Sprung.
- Test der SQL-Rechnung: `STATS_TEST_DATABASE_URL=... pnpm test` (sonst übersprungen). Er nutzt Tage im Jahr 2001, damit andere Daten nicht stören.
- Neue Zähler `userTurns`, `costUsdCents` und das Feld `models` (je Modell-ID tokens und costUsdCents, max. 20) kommen ab der App-Version mit `Db.usageTotals()`-Modellen. Die maximale gültige Meldung ist ca. 2,9 KB, die 4-KB-Grenze passt noch; ein Test prüft das.

## Design
Die Seite übernimmt das Design der Desktop-App ohne Tailwind: Tokens aus `apps/desktop/src/styles.css` als CSS-Variablen in `src/app/globals.css` (nur dunkel), Bausteine in `src/components/blocks.tsx`, Diagramme in `src/components/charts.tsx` (Client-Komponente) nach `usage-charts.tsx` des Tagesberichts. Eine Serie in `--color-accent-strong`, Hervorhebung (neueste Version) Akzent gegen `--color-subtle`-Grau; mit dem dataviz-Validator gegen `#1a1e25` geprüft (das Grau fällt nur beim Chroma-Check durch, gewollt als Neutral). Schrift Geist über das npm-Paket `geist` (next/font/local), nicht über next/font/google (bräuchte Netz beim Build).

## Stolperfallen
- **Nicht im pnpm-Workspace** (Globs sind apps/* und packages/*). Im Ordner immer `pnpm install --ignore-workspace` bzw. `pnpm add --ignore-workspace`, eigenes `pnpm-lock.yaml`. Die Worktree-Vorbereitung von FORGE installiert hier nichts.
- **Kein `public/`-Ordner**: Das Dockerfile kopiert nur `.next/standalone` und `.next/static`. Bilder statisch importieren, Favicons als `src/app/icon.svg` / `apple-icon.png`.
- `pnpm exec tsc --noEmit` meldet vor dem ersten `pnpm build`/`next dev` Fehler (`RouteContext`, Bild-Importe), weil `next-env.d.ts` und `.next/types` fehlen. Nach dem Build ist es sauber.
- Ohne `outputFileTracingRoot` und `turbopack.root` in `next.config.ts` landet `server.js` unter `.next/standalone/services/stats/`; das Dockerfile erwartet es direkt in `.next/standalone`.
- `next dev` schreibt `services/stats/AGENTS.md` immer wieder neu. Die Datei ist deshalb committet.
- TypeScript bleibt auf ~6.0 wie im Rest des Repos.
- lucide-react 1.x hat keine Marken-Icons mehr (kein `Github`); für den GitHub-Link `GitFork`.
- Summen im Prozess 5 Minuten zwischengespeichert (`getTotals`), `schemaReady` ebenso. Nach Testdaten per SQL oder nach DROP TABLE den Dev-Server neu starten.
- TaskStop beendet unter Windows nur pnpm, der Next-Prozess (`start-server.js`) hält Port 4100 weiter. Danach Port prüfen und den eigenen Prozess (Kommandozeile mit dem Worktree-Pfad) beenden.
- Die Sperre "20 neue IDs pro IP und Tag" liegt nur im Speicher und beginnt nach jedem Neustart von vorn. Der Dienst ist für eine Instanz gedacht.

## Lokal gegen Postgres testen
FORGE-Testdatenbank mit `dev_control database start` (URL aus der Antwort, der Port ändert sich gegenüber `dev_environment`). Dann im Ordner `DATABASE_URL=... pnpm exec next dev -p 4100`. Der Dev-Server von FORGE (`pnpm dev` im Root) ist der Tauri-Start und passt hier nicht. SQL ohne psql: kleines Node-Skript mit `require('pg')` aus `services/stats/node_modules`. Verlauf mit Inhalt: pro simuliertem Tag per curl melden, dann per SQL `UPDATE install_days SET day = day - N WHERE day = heute` und `UPDATE installs SET last_seen = now() - interval '5 minutes'` (sonst 429). Hover lässt sich mit preview_interact per Klick auf `.col`/`.hbar` prüfen (Fokus zeigt denselben Tooltip). Danach `install_days` und `installs` löschen.

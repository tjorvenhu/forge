---
title: "Website und Statistik-Dienst services/stats (forge.vanturis.de: Landingpage auf /, Statistik auf /stats, Coolify)"
summary: "Wie die Next.js-Website in services/stats (Landingpage auf /, Statistik auf /stats) gebaut, getestet, gestaltet (Animationen, Live-Abfrage, Englisch/Deutsch) und in Coolify betrieben wird, und welche Stolperfallen es dabei gibt."
tags: ["stats","coolify","release","stolperfalle","i18n","ui"]
updated: "2026-10-19T15:23:09.742Z"
---

# Website und Statistik-Dienst services/stats

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (`USAGE_STATS_URL` in `packages/protocol/src/support.ts`) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`. Deploy in Coolify geschieht nicht automatisch beim Push.

## Landingpage und Statistik (seit 2026-10-19, Wunsch des Besitzers)
- `/` ist die Landingpage (`src/components/landing.tsx`, CSS in `src/app/landing.css`): Hero mit App-Fenster (Screenshot `src/assets/app-{de,en}.webp`), 8 Funktionskarten (Texte wie „Was FORGE kann“ im README), vier Zahlen aus `getTotals()` (per Suspense mit Skeleton, bei DB-Fehler fehlt der Abschnitt), Download-Aufruf. Download-Link `DOWNLOAD_URL` (FORGE-Setup.exe aus Release „installer“), `DOCS_URL` je Sprache in `src/lib/constants.ts`.
- `/stats` ist die frühere Startseite „FORGE in Zahlen“ (`src/app/stats/page.tsx`, `loading.tsx`, eigene Metadaten `statsMeta`).
- Die App verlinkt die Statistik über `STATS_PAGE_URL` (= `USAGE_STATS_URL + "/stats"`, protocol/support.ts). Meldungen und Spenden-Abfrage laufen weiter über `USAGE_STATS_URL`. Ältere Apps verlinken auf `/`, dort führt „Statistik“ in der Kopfzeile weiter.
- Kopfzeile (sticky): Logo-Link, Seitenlinks (`src/components/nav.tsx`, markiert die aktuelle Seite), Sprache, Unterstützen (Outline mit rotem Herz), Herunterladen (primär). Fußzeile mit Logo, Seitenlinks, Leitsatz.
- Kein Hintergrund-Raster aus Kästchen: der Besitzer fand es „brutal KI-like“. Generell keine Deko-Muster; Glows nur an Kanten oder hinter einem Element.

## Domain (Umzug 2026-10-18)
- Neu `forge.vanturis.de`, vorher `forge-stats.vanturis.de`. Apps bis 0.1.103 melden an die alte Domain (fest einkompiliert): die alte muss als zweite Domain am Dienst bleiben (Coolify: beide durch Komma, HAProxy: Zertifikat für beide). Prüfen: `curl https://forge.vanturis.de/api/health` liefert `ok`.

## Meldeintervall
Die App meldet alle 5 Minuten. Sperre pro installId (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`) = 4 Minuten, sonst würde jede zweite Meldung mit 429 abgewiesen. „Gerade online“ = Meldung in den letzten `ONLINE_MINUTES` (10, `src/lib/constants.ts`). Ändert die App ihr Intervall: beide Konstanten, `db.test.ts` und Texte mitziehen.

## Verlauf (install_days)
- Jede angenommene Meldung schreibt in einem Statement `installs` und den Stand des UTC-Tages in `install_days`; bei 429 nichts. FK mit `ON DELETE CASCADE`.
- Zuwachs pro Tag rechnet SQL (`historySql()` in `src/lib/history.ts`, LAG), nicht TS: sonst müssten alle Tagesstände alle 5 Minuten zum Prozess.
- Ein im früheren Stand fehlender Zähler zählt nicht als Zuwachs (`GREATEST(0, NULL)` = 0): neue Zähler kommen mit ihrem Gesamtstand seit Installation.
- Test: `STATS_TEST_DATABASE_URL=... pnpm test` (sonst übersprungen), Tage im Jahr 2001. Maximale Meldung ca. 2,9 KB, Grenze 4 KB.

## Abos, Modelle, Kosten
- `installs.plan` (z. B. `max_20x`, `pro`, null = unbekannt) → Diagramm „Claude-Abos“ (aktive Installationen 30 Tage, „x online“). Unbekannt zuletzt und grau (`sortPlans`). Ohne bekanntes Abo ein Hinweis statt eines Balkens.
- `[1m]`-IDs fasst `modelLabel` mit der normalen ID zusammen (gespeichert bleiben Roh-IDs).
- „Wert in API-Preisen“: Kosten erst seit der modelUsage-Version, ~99 % Cache-Lesezugriffe; die Kachel nennt „nur für X der Y Tokens bekannt“ unter 99 %.

## Sprachen Englisch/Deutsch
- Standard Englisch. Cookie `lang` > Accept-Language > Englisch (`pickLocale`, `getLocale()` in `src/lib/locale-server.ts`). Keine /en- oder /de-Routen.
- `LanguageSwitch` (`src/components/locale.tsx`): Formular mit Submit-Button je Sprache, Server-Action setzt nur das Cookie. Geht ohne JS.
- Texte in `src/lib/messages.ts` (`de` Quelle, `en: Messages`); Server `i18n(locale)`, Client `useI18n()`. Zahlen/Datum über `formats(locale)`.
- Funktionen aus `"use client"`-Dateien kann der Server nicht aufrufen, und Server-Komponenten können keine Funktionen (z. B. `format`) an Client-Komponenten geben: dafür `CountUp` in `motion.tsx` (formatiert selbst per `useI18n`).
- preview_screenshot schickt deutsches Accept-Language. Englisch prüfen: Klick auf `button[value=en]`, dann `wait html[lang=en]`.

## Live und Bewegung
- `src/components/live-stats.tsx` (Client): `/api/v1/live` alle 30 s, `/api/v1/totals` alle 5 min, pausiert bei verdecktem Tab; Online aus `/live` gewinnt.
- `src/components/tiles.ts` (ohne `"use client"`) für Skeleton und Live-Kacheln. `db.ts` (pg) nie in den Client-Bundle: nur `import type`.
- `motion.tsx`: `AnimatedNumber`, `Reveal` (blendet beim Scrollen ein; auf der Landingpage auch die Funktionskarten gestaffelt). `<noscript>`-Style in `layout.tsx` zeigt `.reveal` und `.reveal .feature` ohne JS.
- CSS „motion“ am Ende von `globals.css`: `forge-rise` (fill `backwards`, nicht `both`, sonst blockiert es Hover-Transforms), `forge-ping`, `forge-sweep`, `forge-grow-y/x`; `prefers-reduced-motion` kürzt alles.
- `.tile-value` hat `overflow: hidden`; Kacheln mit Live-Punkt `.tile-value-live`.
- Prüfen: untere Abschnitte erst nach `PageDown`/`End` sichtbar (fullPage-Screenshots zeigen Reveal-Abschnitte leer).

## Design
Tokens der Desktop-App als CSS-Variablen in `src/app/globals.css` (nur dunkel), Bausteine `src/components/blocks.tsx`, Diagramme `src/components/charts.tsx`. Schrift Geist über npm-Paket `geist` (nicht next/font/google, bräuchte Netz beim Build).
- Statistik-Kacheln: 4 Spalten, 2 breite + 8 schmale. Neue Kachel bricht das Raster.
- Diagramm-Abschnitte je 2 Karten; einzelne Karte `wide`; `CARDS` im `ChartsSkeleton` mitziehen.

## Stolperfallen
- **Nicht im pnpm-Workspace**: im Ordner `pnpm install --ignore-workspace` / `pnpm add --ignore-workspace`, eigenes Lockfile. Kein Prettier.
- **Kein `public/`-Ordner** (Dockerfile kopiert nur `.next/standalone` und `.next/static`): Bilder statisch importieren (`.webp`, `.svg`, `.png` gehen), Favicons als `src/app/icon.svg` / `apple-icon.png`.
- `tsc --noEmit` meldet vor dem ersten `pnpm build`/`next dev` Fehler (fehlende `next-env.d.ts`/`.next/types`).
- Ohne `outputFileTracingRoot` und `turbopack.root` landet `server.js` unter `.next/standalone/services/stats/`.
- `next dev` schreibt `AGENTS.md` immer wieder neu; die Datei ist committet.
- lucide-react 1.x hat keine Marken-Icons (kein `Github`): `GitFork`.
- Summen 5 Minuten im Prozess gecacht (`getTotals`), `schemaReady` ebenso: nach SQL-Testdaten Dev-Server neu starten.
- TaskStop beendet unter Windows nur pnpm; Port 4100 prüfen (`Get-NetTCPConnection -LocalPort 4100`) und den Prozess mit `services\stats` in der Kommandozeile beenden. Vor `pnpm build` den Dev-Server stoppen (beide nutzen `.next`).
- „20 neue IDs pro IP und Tag“ liegt nur im Speicher; der Dienst ist für eine Instanz gedacht.

## Lokal gegen Postgres testen
`dev_control database start` (URL aus der Antwort), dann im Ordner `DATABASE_URL=... pnpm exec next dev -p 4100`. Der Dev-Server von FORGE (`pnpm dev` im Root) ist der Tauri-Start und passt hier nicht. SQL ohne psql: Node-Skript mit `require('pg')` aus `services/stats/node_modules`. Verlauf simulieren: pro Tag per curl melden, dann `UPDATE install_days SET day = day - N WHERE day = heute` und `UPDATE installs SET last_seen = now() - interval '5 minutes'`. Danach `installs` löschen (Cascade).

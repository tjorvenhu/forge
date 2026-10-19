---
title: "Website und Statistik-Dienst services/stats (forge.vanturis.de: Landingpage auf /, Live Stats auf /stats, Coolify)"
summary: "Wie die Next.js-Website in services/stats (Landingpage nach Bildvorlage des Besitzers auf /, Live Stats auf /stats) gebaut, getestet, gestaltet (Inter, Amboss-Silhouette, Live-Abfrage, Englisch/Deutsch) und in Coolify betrieben wird, und welche Stolperfallen es dabei gibt."
tags: ["stats","coolify","release","stolperfalle","i18n","ui"]
updated: "2026-10-19T15:46:17.483Z"
---

# Website und Statistik-Dienst services/stats

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (`USAGE_STATS_URL` in `packages/protocol/src/`, grep nach dem Namen) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`. Deploy in Coolify geschieht nicht automatisch beim Push.

## Landingpage: eins zu eins nach der Bildvorlage des Besitzers (2026-10-19)
Der Besitzer hat eine Vorlage (1536 x 1024) geliefert und verlangt, dass die Seite „1 zu 1“ so aussieht; ein erster, freier Umbau wurde als „richtig scheiße“ abgelehnt. Nichts ergänzen oder weglassen, was die Vorlage nicht zeigt. Maße und Aufbau:
- Kopfzeile 76px (`src/app/layout.tsx`): Logo = `logo-mark.svg` 44x33 + Wortmarke „FORGE“ 28px/800. Rechts „Live Stats“ (BarChart3, ExternalLink-Icon, 17px), „GitHub“ mit echtem Octocat-SVG (`GithubMark` in `nav.tsx`, lucide 1.x hat keine Marken-Icons), Outline-Button „Unterstützen“ (Herz rot, öffnet Spenden-Dialog; der Besitzer wollte ihn ausdrücklich oben), oranger Button „Download“ (46px). Unter 560px nur Icons (`.nav-label` versteckt, `aria-label` an den Links).
- Erster Bildschirm = Hero + vier Karten + Trennlinie mit „Live Stats ansehen →“; Fußzeile erst beim Scrollen. Dafür `main.landing` als Flex-Spalte mit `min-height: calc(100svh - 77px)`, der Hero wächst (`flex: 1`, Mindesthöhe 540px).
- Hero (`src/components/landing.tsx`): Eyebrow „Claude Development Studio“ (14px, orange, 0.24em), Titel „Deine AI“ / „Entwicklungszentrale“ (zweite Zeile orange, `clamp(40px, 4.1vw, 64px)`; lang, braucht zwei Spalten 49/51 und Gutter 72px), Lead 22px, Buttons 58px, Fakten „Windows 10/11 · Open Source · Early Access“ (Windows-Logo als Inline-SVG). Rechts das App-Fenster (`src/assets/app-{de,en}.webp`, Ampel-Punkte, `rotateY(-11deg)`, oranger Rand und Glow, ragt 3 % über den Container).
- Hinter dem Fenster der Amboss (`.hero-anvil`): drei Spans mit `mask: url("../assets/logo-mark.svg")` (Next bündelt relative url() in globalem CSS). `anvil-body` dunkler Verlauf, `anvil-rim` orange um 5px nach oben rechts versetzt (nur obere 36 % = der Funke, sonst schneidet die Kante den Titel), `anvil-glow` dasselbe mit Blur. Unter 1080px aus.
- Container: `--page-width: 1392px`, `--page-gutter: 72px` (32px unter 1080, 16px unter 560), wie der Rand in der Vorlage.
- Schrift Inter (`@fontsource-variable/inter`, Import in `layout.tsx`, `--font-sans: "Inter Variable"`), nicht Geist: der Besitzer wollte die Schrift der Vorlage. Kein next/font/google (kein Netz beim Build).
- Kein Hintergrund-Raster, keine Deko-Muster, kein blass eingeblendetes Logo (sah matschig aus).

## Live Stats (/stats)
`src/app/stats/page.tsx`, `loading.tsx`, `src/components/stats-page.tsx`: zentrierter Kopf (Eyebrow „Live Stats“, „FORGE in Zahlen“, Lead), Zeile mit Live-Badge und „Stand …“, `.stats-grid` mit 8 Zellen und Hairlines (Tokens, Sessions, Durchläufe, Arbeitszeit, Projekte, Agenten, Installationen, Gerade online; `src/components/tiles.ts`). Kosten, Telefonate, Token-Arten, Abos und Versionen werden nicht mehr gezeigt (die API liefert sie weiter). Diagramme (`charts.tsx`): Tokens pro Tag, Aktive Installationen, Tokens nach Modell (breit); kein Tabellen-Umschalter. Darunter „Was erfasst wird“ als vier Karten (`Feature` aus `blocks.tsx`) und Fußnote. Die App verlinkt die Seite über `STATS_PAGE_URL` (= `USAGE_STATS_URL + "/stats"`).

## Domain (Umzug 2026-10-18)
Neu `forge.vanturis.de`, vorher `forge-stats.vanturis.de`. Apps bis 0.1.103 melden an die alte Domain (fest einkompiliert): die alte muss als zweite Domain am Dienst bleiben (Coolify: beide durch Komma, HAProxy: Zertifikat für beide). Prüfen: `curl https://forge.vanturis.de/api/health` liefert `ok`.

## Meldeintervall
Die App meldet alle 5 Minuten. Sperre pro installId (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`) = 4 Minuten, sonst würde jede zweite Meldung mit 429 abgewiesen. „Gerade online“ = Meldung in den letzten `ONLINE_MINUTES` (10, `src/lib/constants.ts`). Ändert die App ihr Intervall: beide Konstanten, `db.test.ts` und Texte mitziehen.

## Verlauf (install_days)
- Jede angenommene Meldung schreibt in einem Statement `installs` und den Stand des UTC-Tages in `install_days`; bei 429 nichts. FK mit `ON DELETE CASCADE`.
- Zuwachs pro Tag rechnet SQL (`historySql()` in `src/lib/history.ts`, LAG), nicht TS. Ein im früheren Stand fehlender Zähler zählt nicht als Zuwachs: am ersten Tag einer Installation zeigt „Tokens pro Tag“ deshalb nichts.
- Test: `STATS_TEST_DATABASE_URL=... pnpm test` (sonst übersprungen), Tage im Jahr 2001. Maximale Meldung ca. 2,9 KB, Grenze 4 KB.

## Modelle
`[1m]`-IDs fasst `modelLabel` (`src/lib/models.ts`) mit der normalen ID zusammen (gespeichert bleiben Roh-IDs). Kosten werden gespeichert und per API geliefert, auf der Seite aber nicht gezeigt.

## Sprachen Englisch/Deutsch
- Standard Englisch. Cookie `lang` > Accept-Language > Englisch (`pickLocale`, `getLocale()` in `src/lib/locale-server.ts`). Keine /en- oder /de-Routen.
- `LanguageSwitch` (`src/components/locale.tsx`, in der Fußzeile): Formular mit Submit-Button je Sprache, Server-Action setzt nur das Cookie. Geht ohne JS.
- Texte in `src/lib/messages.ts` (`de` Quelle, `en: Messages`); Server `i18n(locale)`, Client `useI18n()`. Zahlen/Datum über `formats(locale)`.
- Server-Komponenten können keine Funktionen (z. B. `format`) an Client-Komponenten geben: dafür `AnimatedNumber`/`CountUp` in `motion.tsx`.
- preview_screenshot schickt deutsches Accept-Language, das Cookie bleibt aber im Vorschau-Browser: Sprache prüfen mit Klick auf `button[value=en]`/`[value=de]` (in der Fußzeile, scrollt die Seite), dann `wait html[lang=…]`.

## Live und Bewegung
- `src/components/live-stats.tsx` (Client): `/api/v1/live` alle 30 s, `/api/v1/totals` alle 5 min, pausiert bei verdecktem Tab; Online aus `/live` gewinnt.
- `src/components/tiles.ts` (ohne `"use client"`) für Skeleton und Live-Zellen. `db.ts` (pg) nie in den Client-Bundle: nur `import type`.
- `motion.tsx`: `AnimatedNumber`, `Reveal` (blendet beim Scrollen ein). `<noscript>`-Style in `layout.tsx` zeigt `.reveal` ohne JS.
- Animationen: `forge-rise` (fill `backwards`, nicht `both`, sonst blockiert es Hover-Transforms), `forge-ping`, `forge-grow-y/x`; `prefers-reduced-motion` kürzt alles. Karten und Zellen blenden gestaffelt ein: in Screenshots ist die letzte Karte oft noch halb durchsichtig, das ist kein Fehler.

## Design
Tokens der Desktop-App als CSS-Variablen in `src/app/globals.css` (nur dunkel, plus Primitives: Buttons, Eyebrow, Feature-Karten, Sprachumschalter, Modal, Skeleton, Live-Punkt). Seitenlayout (Kopf, Fuß, Hero, Amboss, Stats-Raster, Diagramme) in `src/app/pages.css`.

## Stolperfallen
- **Nicht im pnpm-Workspace**: im Ordner `pnpm install --ignore-workspace` / `pnpm add --ignore-workspace`, eigenes Lockfile. Kein Prettier.
- **Kein `public/`-Ordner** (Dockerfile kopiert nur `.next/standalone` und `.next/static`): Bilder statisch importieren (`.webp`, `.svg`, `.png` gehen), Favicons als `src/app/icon.svg` / `apple-icon.png`.
- `tsc --noEmit` meldet vor dem ersten `pnpm build`/`next dev` Fehler (fehlende `next-env.d.ts`/`.next/types`).
- Ohne `outputFileTracingRoot` und `turbopack.root` landet `server.js` unter `.next/standalone/services/stats/`.
- `next dev` schreibt `AGENTS.md` immer wieder neu; die Datei ist committet.
- Summen 5 Minuten im Prozess gecacht (`getTotals`), `schemaReady` ebenso: nach SQL-Testdaten Dev-Server neu starten.
- Ein Dev-Server auf Port 4100 bleibt oft aus einer früheren Session laufen (`Get-NetTCPConnection -LocalPort 4100`, Prozess mit `services\stats` in der Kommandozeile). Ein lange laufender Dev-Server kann bei API-Routen mit „Jest worker encountered 2 child process exceptions“ 500 liefern, obwohl der Code stimmt: Prozess beenden und neu starten. Vor `pnpm build` stoppen (beide nutzen `.next`).
- „20 neue IDs pro IP und Tag“ liegt nur im Speicher; der Dienst ist für eine Instanz gedacht.

## Lokal gegen Postgres testen
`dev_control database start` (URL aus der Antwort), dann im Ordner `DATABASE_URL=... pnpm exec next dev -p 4100`. Der Dev-Server von FORGE (`pnpm dev` im Root) ist der Tauri-Start und passt hier nicht. Testdaten am einfachsten per `curl -X POST http://localhost:4100/api/v1/report` (Payload siehe README, `installId` als UUID v4 `00000000-0000-4000-8000-00000000000N`), wieder weg mit `DELETE /api/v1/report/<id>`. Verlauf simulieren: pro Tag melden, dann `UPDATE install_days SET day = day - N` und `UPDATE installs SET last_seen = now() - interval '5 minutes'`.

---
title: "Website und Statistik-Dienst services/stats (forge.vanturis.de: Landingpage auf /, Live Stats auf /stats, Coolify)"
summary: "Next.js-Website in services/stats: Landingpage exakt nach Bildvorlage des Besitzers auf /, Live Stats auf /stats. Maße, Fenster-Perspektive, SVG-Hintergrund, Wortmarke ohne Unterzeile, Unterstützen oben, Live-Abfrage, Englisch/Deutsch, Coolify, Stolperfallen."
tags: ["stats","coolify","release","stolperfalle","i18n","ui"]
updated: "2026-10-19T16:09:29.581Z"
---

# Website und Statistik-Dienst services/stats

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (`USAGE_STATS_URL` in `packages/protocol/src/`) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`. Deploy in Coolify geschieht nicht automatisch beim Push.

## Landingpage: exakt nach der Bildvorlage des Besitzers (Stand 2026-10-19)
Vorlage: 1536 x 1024 (liegt in den FORGE-Uploads als `Forge_ Deine AI-Entwicklungszentrale.png`). Der Besitzer verlangt „pixelgenau“, freiere Umbauten wurden mehrfach scharf abgelehnt. Nichts ergänzen oder weglassen, außer er sagt es. Prüfen bei 1440 x 900 **und** 1536 x 1024 (dort direkt mit der Vorlage vergleichbar). Vergleich: Vorlage mit sharp auf 1440 skalieren, gleiche Ausschnitte untereinander legen (sharp aus `services/stats/node_modules/.pnpm/sharp@*/node_modules/sharp`).
- Vorgaben: Hintergrund `#111418`, Orange `#ff7a1a` (Tokens in `globals.css`), keine übertriebenen Glows, keine Animationen, keine Karten um die vier Blöcke, kein Raster.
- Kopfzeile 76px: Wortmarke `forge-wordmark.png` (944x184 = Marke + „FORGE“ **ohne** „Claude Development Studio“, 34px hoch, Fußzeile 24px). Sie ist aus der alten `forge-logo.png` (945x223, App) zusammengesetzt: Marke (1,21,245x184) + Schriftzug (282,37,663x121) bei x 281/y 32. Die Version mit Unterzeile nannte der Besitzer „das alte Logo“. Rechts: Live Stats, GitHub, **Unterstützen mit rotem Herz** (`SupportButton`, Spenden-Dialog; vom Besitzer oben gewünscht, nicht mehr in der Fußzeile), oranger Download (40px). Links 15px.
- Hero (`landing.tsx`, `pages.css`): Spalten 47,5/52,5, Titel `4.1vw` Gewicht 550, Zeilenhöhe 1.1, Lead `1.39vw`, `max-width: 25.85em` erzwingt den Umbruch nach „mit einer“ wie in der Vorlage (knapp, bei Textänderung neu prüfen). Buttons 55px, Schrift 16,5px/500. Unter 1320px kleinere Buttons und Titel, damit beides neben dem Fenster passt.
- Fenster: echter Screenshot `app-{de,en}.webp` (1600x1000, Projekte-Ansicht), `perspective(1500px) rotateY(-15deg) rotateX(1.5deg)`, Rahmen per Doppel-Background (grau oben links, orange rechts/unten). Die Vorlage zeigt die Session-Ansicht in höherem Format (~1,35) mit größerer UI; mit 1,6 wirkt das Fenster flacher und die UI kleiner. Näher käme nur ein neuer echter Screenshot (~1150x860 logisch, Chat-Ansicht).
- Hintergrund: `HeroArt` in `landing.tsx`, ein SVG in den Pixelkoordinaten der Vorlage (viewBox `380 60 1156 760`, `preserveAspectRatio="none"`), als Kind von `.hero-shot` so positioniert, dass das Fenster der Vorlage (731..1482 x 147..762) auf dem echten Fenster liegt. Inhalt: große dunkle Fläche mit orange beleuchteter Ober-/Rechtskante, leuchtende Kurve und Bodenkante links vom Fenster. Farben über CSS-Klassen an den `<stop>`s (Tokens). Unter 1080px aus.
- Bei 900px Höhe ist es eng: Fläche oben darf nicht unter die Kopfzeile rutschen (`.hero-shot { margin-top }` verschiebt das Fenster, `.hero-art { top }` die Fläche).
- Vier Blöcke: Raster max. 1160px, Icons 25px, zweites Icon grau wie in der Vorlage, Text mit `white-space: pre-line` (DE „Dein Workflow“ hat ein `\n`).
- Schrift Inter (`@fontsource-variable/inter`), kein next/font/google (kein Netz beim Build). Container `--page-width: 1392px`, Gutter 72px.

## Live Stats (/stats)
`src/app/stats/page.tsx`, `loading.tsx`, `src/components/stats-page.tsx`: Kopf, Live-Badge, `.stats-grid` mit 8 Zellen (`tiles.ts`), Diagramme (`charts.tsx`), „Was erfasst wird“. Kosten, Telefonate, Abos, Versionen werden nicht gezeigt (API liefert sie). Die App verlinkt über `STATS_PAGE_URL`. Von der Landingpage verlinkt: Kopfzeile, zweiter Hero-Button, Link unter den Blöcken, Fußzeile.

## Domain
Neu `forge.vanturis.de`, vorher `forge-stats.vanturis.de`. Apps bis 0.1.103 melden an die alte Domain: beide Domains am Dienst lassen. Prüfen: `curl https://forge.vanturis.de/api/health` liefert `ok`.

## Meldeintervall
App meldet alle 5 Minuten, Sperre pro installId 4 Minuten (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`), „Gerade online“ = 10 Minuten (`ONLINE_MINUTES`). Ändert die App ihr Intervall: Konstanten, `db.test.ts`, Texte mitziehen.

## Verlauf (install_days)
Jede angenommene Meldung schreibt `installs` und den UTC-Tag in `install_days` (FK mit CASCADE). Zuwachs pro Tag rechnet SQL (`historySql()`, LAG). Test: `STATS_TEST_DATABASE_URL=... pnpm test`, Tage im Jahr 2001.

## Sprachen
Standard Englisch; Cookie `lang` > Accept-Language. `LanguageSwitch` in der Fußzeile (Server-Action, geht ohne JS). Texte in `src/lib/messages.ts`. preview_screenshot schickt deutsches Accept-Language.

## Stolperfallen
- **Nicht im pnpm-Workspace**: `pnpm install --ignore-workspace`, eigenes Lockfile.
- **Kein `public/`-Ordner**: Bilder statisch importieren, Favicons als `src/app/icon.svg` / `apple-icon.png`.
- `tsc --noEmit` meldet vor dem ersten `next dev`/`build` Fehler (fehlende `.next/types`).
- Dev-Server auf Port 4100 läuft oft aus früheren Sessions weiter und lädt Änderungen per HMR; bei „Jest worker“-500ern neu starten. Vor `pnpm build` stoppen.
- Bash-Heredocs verlieren Backslashes (`\n` in Strings): solche Stellen mit Edit schreiben.
- Lokal mit DB: `dev_control database start`, dann `DATABASE_URL=... pnpm exec next dev -p 4100`. Testdaten per `curl -X POST http://localhost:4100/api/v1/report`, löschen mit `DELETE /api/v1/report/<id>`.

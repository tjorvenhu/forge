---
title: "Website und Statistik-Dienst services/stats (forge.vanturis.de: Landingpage auf /, Live Stats auf /stats, Coolify)"
summary: "Next.js-Website in services/stats: Landingpage und Live Stats exakt nach Bildvorlagen des Besitzers. Hintergrundbild, Fenster-Perspektive, Wortmarke, Stats-Karten und Diagramme, Plattformen, Live-Abfrage, Englisch/Deutsch, Coolify, Stolperfallen."
tags: ["stats","coolify","release","stolperfalle","i18n","ui"]
updated: "2026-10-19T17:30:13.157Z"
---

# Website und Statistik-Dienst services/stats

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (`USAGE_STATS_URL` in `packages/protocol/src/`) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`. Deploy in Coolify geschieht nicht automatisch beim Push; „die Website soll so bleiben“ heißt: nicht in Coolify ausrollen. Der Release-Workflow der App ignoriert `services/`.

## Arbeitsweise mit dem Besitzer (wichtig)
Er liefert Bildvorlagen (1536 x 1024, in den FORGE-Uploads) und verlangt „GENAU SO“; freiere Umsetzungen wurden mehrfach scharf abgelehnt. Nichts ergänzen oder weglassen, außer er sagt es. Prüfen bei 1440 x 900 und 1536 x 1024 (dort direkt mit der Vorlage vergleichbar). Vergleich: Vorlage mit sharp auf gleiche Breite skalieren, gleiche Ausschnitte untereinander legen (sharp aus `services/stats/node_modules/.pnpm/sharp@*/node_modules/sharp`). Animationen im Screenshot abwarten (preview_interact mit wait ~2,5 s), sonst sind Balken halb hoch.
- Vorgaben: Hintergrund `#111418`, Orange `#ff7a1a` (Tokens in `globals.css`), keine übertriebenen Glows.
- **Hintergrund aller Seiten**: Bild des Besitzers als `src/assets/background.webp` (Stand 2026-10-19: dunkle geschwungene Flächen mit orange leuchtenden Kanten, Gemini-Bild 2752x1536 aus seinem Downloads-Ordner; Chat-Anhänge liegen nicht immer als Datei vor, dann in `Downloads` nach der neuesten Datei suchen). Datei in voller Größe mit sharp `webp({quality: 95, smartSubsample: true})`, ~270 KB. Weichzeichnen macht der Browser: `body::before` fixed, `inset: -60px`, `cover`, `filter: blur(12px)`; so will er es („verwaschen“). Ein in eine kleinere Datei eingebackener Blur sah verpixelt aus (Blöcke und Streifen in den dunklen Verläufen), das lehnt er ab. Eigene SVG-/CSS-Formen hinter dem Fenster hat er ebenfalls abgelehnt.

## Landingpage (`landing.tsx`, `pages.css`)
- Kopfzeile 76px: Wortmarke `forge-wordmark.png` (944x184, Marke + „FORGE“ ohne Unterzeile, 34px hoch, Fußzeile 24px). Rechts: Live Stats, GitHub, Unterstützen mit rotem Herz (`SupportButton`, Spenden-Dialog, nur oben), Download (40px). Die geöffnete Seite bekommt eine orange Linie unter dem Link, ohne Pfeil-Icon.
- Hero ohne Eyebrow (vom Besitzer gestrichen). Titel `4.1vw` Gewicht 550, Lead `1.39vw` mit `max-width: 25.85em` (Umbruch nach „mit einer“, bei Textänderung neu prüfen). Unter 1320px kleinere Buttons/Titel.
- Fenster: echter Screenshot `app-{de,en}.webp` 2400x1680 (Chat-Ansicht „Neue Session in forge“, logisch 1200x840 bei Faktor 2; Entstehung siehe Eintrag Repo-Dokumentation/Screenshots), `perspective(1500px) rotateY(-15deg) rotateX(1.5deg)`, `.hero-shot` 100 % der Spalte. Die Claude-Code-Karte im Screenshot zeigt echte Abo-/Nutzungswerte.
- Vier Blöcke darunter: Raster max. 1160px, zweites Icon grau wie in der Vorlage, Text `pre-line` (DE „Dein Workflow“ mit `\n`). Alles inkl. „Live Stats ansehen“ passt bei 1440x900 in den ersten Bildschirm.

## Live Stats (/stats, Vorlage 2026-10-19)
`stats-page.tsx` (Kopf links: Eyebrow, „FORGE in **Zahlen**“, zweizeiliger Lead mit `\n`), `live-stats.tsx` (Live-Pille, „Letzte Aktualisierung …“, vier Karten), `charts.tsx`, `tiles.ts`.
- Karten: Tokens, Sessions, Durchläufe, Arbeitszeit; rechts 7 Mini-Balken der letzten Tage (`Spark`, orange/grau abwechselnd wie in der Vorlage). Unter 1500px weniger Abstand um Icon und Balken, sonst wird die Unterzeile abgeschnitten. Projekte/Agenten/Installationen/Online-Kacheln gibt es nicht mehr.
- Diagrammkarten: Tokens pro Tag (Säulen) und Aktive Installationen (Fläche, SVG mit `preserveAspectRatio="none"` + `vector-effect`, Punkt als HTML), je mit Menü „Letzte 7/14/30 Tage“ (`RangeSelect`, eigenes Menü, kein `<select>`); Top Modelle (3 + „Andere“, Anteil in %, Namen „Claude Opus 4.7“); Plattformen (Ring mit Anzahl Installationen in der Mitte, Legende Windows 10/11, macOS, Linux, Andere). Die Vorlage schreibt „Sessions“ in den Ring; bewusst Installationen, weil es Betriebssysteme der Installationen sind.
- Daten: `history` (30 Tage) hat zusätzlich `sessions`, `claudeWorkMs`; `platforms` aus `installs.os` (App sendet `os.type() os.release()`, z. B. „Windows_NT 10.0.26200“) per `CASE … ILIKE` in `queryPlatforms`. Achsen-Labels `f.axis` („50K“).
- Darunter weiter „Was erfasst wird“ und Fußnote. Skeletons in Form der Karten (`SparkSkeleton`, `ChartsSkeleton`).

## Domain
Neu `forge.vanturis.de`, vorher `forge-stats.vanturis.de`. Apps bis 0.1.103 melden an die alte Domain: beide Domains am Dienst lassen. Prüfen: `curl https://forge.vanturis.de/api/health` liefert `ok`.

## Meldeintervall
App meldet alle 5 Minuten, Sperre pro installId 4 Minuten (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`), „Gerade online“ = 10 Minuten (`ONLINE_MINUTES`).

## Verlauf (install_days)
Jede angenommene Meldung schreibt `installs` und den UTC-Tag in `install_days` (FK mit CASCADE). Zuwachs pro Tag rechnet SQL (`historySql()`, LAG); der erste Stand einer Installation zählt nicht als Zuwachs. Test: `STATS_TEST_DATABASE_URL=... pnpm test`.

## Sprachen
Standard Englisch; Cookie `lang` > Accept-Language. `LanguageSwitch` in der Fußzeile. Texte in `src/lib/messages.ts` (`de` ist Quelle des Typs: Funktionen mit Literal-Rückgabe brauchen `: string`, sonst passt `en` nicht).

## Stolperfallen
- **Nicht im pnpm-Workspace**: `pnpm install --ignore-workspace`, eigenes Lockfile.
- **Kein `public/`-Ordner**: Bilder statisch importieren oder per relativer `url()` in globalem CSS (Next bündelt sie).
- Dev-Server auf Port 4100 läuft oft schon (auch von FORGE neu gestartet); lädt Änderungen per HMR. Summen sind 5 Minuten im Prozess gecacht: nach SQL-Testdaten neu starten.
- Lokale Demodaten: direkt per SQL in `installs` + `install_days` (Test-DB aus `dev_environment`), IDs `00000000-0000-4000-8000-0000000000cN`; löschen mit `DELETE FROM installs WHERE install_id::text LIKE '00000000-0000-4000-8000-0000000000c%'`.
- Bash-Heredocs verlieren Backslashes (`\n`, `` \` ``): solche Stellen mit Edit schreiben.

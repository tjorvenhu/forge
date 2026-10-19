---
title: "Website und Statistik-Dienst services/stats (forge.vanturis.de: Landingpage auf /, Live Stats auf /stats, Coolify)"
summary: "Next.js-Website in services/stats: Landingpage und Live Stats nach Bildvorlagen des Besitzers. Hintergrundbild, geneigtes App-Fenster mit Maus-Parallaxe und srcset, Wortmarke, Spenden-Dialog, Stats-Karten (Kosten, online) und Diagramme, Plattformen, Englisch/Deutsch, Coolify, Stolperfallen."
tags: ["stats","coolify","release","stolperfalle","i18n","ui"]
updated: "2026-10-19T17:38:21.016Z"
---

# Website und Statistik-Dienst services/stats

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (`USAGE_STATS_URL` in `packages/protocol/src/`) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`. Deploy in Coolify geschieht nicht automatisch beim Push; „die Website soll so bleiben“ heißt: nicht in Coolify ausrollen. Der Release-Workflow der App ignoriert `services/`.

## Arbeitsweise mit dem Besitzer (wichtig)
Er liefert Bildvorlagen (1536 x 1024, in den FORGE-Uploads) und verlangt „GENAU SO“; freiere Umsetzungen wurden mehrfach scharf abgelehnt. Danach kommen viele kleine Wünsche hintereinander; jeder gilt, auch wenn er von der Vorlage abweicht. Prüfen bei 1440 x 900 und 1536 x 1024. Vergleich: Vorlage mit sharp auf gleiche Breite skalieren, gleiche Ausschnitte untereinander legen (sharp aus `services/stats/node_modules/.pnpm/sharp@*/node_modules/sharp`; `sharp.cache(false)` und Datei vorher einlesen, sonst ist sie beim Überschreiben gesperrt). Animationen im Screenshot abwarten (preview_interact mit wait ~2,5 s). preview_screenshot rendert mit Pixeldichte 1; Unschärfe auf HiDPI-Bildschirmen sieht man dort nicht.
- Vorgaben: Hintergrund `#111418`, Orange `#ff7a1a` (Tokens in `globals.css`), keine übertriebenen Glows.
- **Hintergrund aller Seiten**: Bild des Besitzers als `src/assets/background.webp` (Stand 2026-10-19: dunkle geschwungene Flächen mit orange leuchtenden Kanten, Gemini-Bild 2752x1536 aus seinem Downloads-Ordner; Chat-Anhänge liegen nicht immer als Datei vor, dann in `Downloads` nach der neuesten Datei suchen). Datei in voller Größe, sharp `webp({quality: 95, smartSubsample: true})`. Weichzeichnen macht der Browser: `body::before` fixed, `inset: -60px`, `cover`, `filter: blur(12px)` („verwaschen“). Ein in die Datei eingebackener Blur sah verpixelt aus, das lehnt er ab. Eigene SVG-/CSS-Formen hinter dem Fenster hat er ebenfalls abgelehnt.

## Landingpage (`landing.tsx`, `pages.css`)
- Kopfzeile 76px: Wortmarke `forge-wordmark.png` (944x184, Marke + „FORGE“ ohne Unterzeile). Rechts: Live Stats, GitHub, Unterstützen mit rotem Herz, Download. Die geöffnete Seite bekommt eine orange Linie unter dem Link.
- Hero ohne Eyebrow. Titel `4.1vw` Gewicht 550, Lead `1.39vw` mit `max-width: 25.85em` (Umbruch nach „mit einer“, bei Textänderung neu prüfen).
- Fenster: echter Screenshot der Chat-Ansicht („Neue Session in forge“), aufgenommen 2400x1680 (Original: `app-{de,en}-2400.webp`), dazu mit sharp lanczos3 verkleinert 800/1200/1600 (`app-{de,en}-<w>.webp`); `<img srcSet sizes="(max-width: 1080px) 100vw, 50vw">`, der Browser wählt die passende Breite. Grund: Unter dem 3D-Transform verkleinert die GPU ohne gutes Filtern; eine viel größere Datei als die Anzeige sah verpixelt aus, eine einzelne kleine auf HiDPI unscharf. Neue Screenshots: alle vier Breiten neu erzeugen.
- Neigung `perspective(2000px) rotateY(-11deg)`, folgt dem Mauszeiger: `Tilt` (`components/tilt.tsx`) setzt `--tilt-x/-y` (-1..1 über das Fenster), CSS addiert ±6°/±4° mit 500 ms Übergang; nur `pointer: fine`, nicht bei reduced motion. Stärkere Neigung (15°) machte den Screenshot sichtbar unscharf. Glow nur dezent.
- Vier Blöcke darunter, alle Icons orange. Alles inkl. „Live Stats ansehen“ passt bei 1440x900 in den ersten Bildschirm.

## Spenden-Dialog (`components/donations.tsx`, Styles in `globals.css`)
Kurz halten: Herz-Kachel + Titel, ein Satz, Karte „Bisher gespendet“ (Betrag groß in Orange, „n Beiträge, vor Gebühren“), Buttons „Beitrag über Stripe“ und „Idee oder Fehler melden“, eine Zeile Hinweis (Vanturis UG, keine Spendenquittung). Betrag aus Stripe (`STRIPE_SECRET_KEY` nur auf dem Live-Server); `next dev` ohne Schlüssel holt ihn von `https://forge.vanturis.de/api/v1/donations` (`liveDonations` in `lib/donations.ts`).

## Live Stats (/stats, Vorlage 2026-10-19)
`stats-page.tsx` (Kopf links: Eyebrow, „FORGE in **Zahlen**“, zweizeiliger Lead mit `\n`), `live-stats.tsx` (Live-Pille, „Letzte Aktualisierung …“, Karten), `charts.tsx`, `tiles.ts`.
- Sechs Karten im 3er-Raster: Tokens, Sessions, Durchläufe, Arbeitszeit, Kosten (`costUsdCents`, „geschätzt, zu API-Preisen“), Gerade online (Live-Punkt statt Balken, live alle 30 s). Rechts je 7 Mini-Balken (`Spark`).
- Diagrammkarten: Tokens pro Tag (Säulen), Aktive Installationen (Fläche), je Menü „Letzte 7/14/30 Tage“ (`RangeSelect`, kein `<select>`); Top Modelle (3 + „Andere“); Plattformen (Ring mit Anzahl Installationen, Legende Windows 10/11, macOS, Linux, Andere).
- Daten: `history` (30 Tage) hat `tokens`, `claudeTurns`, `sessions`, `claudeWorkMs`, `costUsdCents`, `activeInstalls`; `platforms` aus `installs.os` per `CASE … ILIKE` in `queryPlatforms`. Achsen-Labels `f.axis` („50K“).
- Darunter „Was erfasst wird“ und Fußnote. Skeletons in Form der Karten.

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

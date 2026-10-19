---
title: "Website und Statistik-Dienst services/stats (forge.vanturis.de: Landingpage auf /, Live Stats auf /stats, Coolify)"
summary: "Next.js-Website in services/stats: Landingpage und Live Stats nach Bildvorlagen des Besitzers. Hintergrundbild, geneigtes App-Fenster, Spenden-Dialog, Stats-Karten und Diagramme, Englisch/Deutsch, mobile Ansicht, Coolify, Stolperfallen."
tags: ["stats","coolify","release","stolperfalle","i18n","ui"]
updated: "2026-10-19T18:27:15.845Z"
---

# Website und Statistik-Dienst services/stats

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (`USAGE_STATS_URL` in `packages/protocol/src/`) und zeigt die Summen. API, Payload und Coolify stehen in `services/stats/README.md`. Deploy in Coolify geschieht nicht automatisch beim Push; „die Website soll so bleiben“ heißt: nicht in Coolify ausrollen. Der Release-Workflow der App ignoriert `services/`.

## Arbeitsweise mit dem Besitzer (wichtig)
Er liefert Bildvorlagen (1536 x 1024, in den FORGE-Uploads) und verlangt „GENAU SO“; freiere Umsetzungen wurden mehrfach scharf abgelehnt. Danach kommen viele kleine Wünsche hintereinander; jeder gilt, auch wenn er von der Vorlage abweicht. Prüfen bei 1440 x 900 und 1536 x 1024. Vergleich: Vorlage mit sharp auf gleiche Breite skalieren, gleiche Ausschnitte untereinander legen (sharp aus `services/stats/node_modules/.pnpm/sharp@*/node_modules/sharp`; `sharp.cache(false)` und Datei vorher einlesen, sonst ist sie beim Überschreiben gesperrt). Animationen im Screenshot abwarten (preview_interact mit wait ~2,5 s). preview_screenshot rendert mit Pixeldichte 1; Unschärfe auf HiDPI-Bildschirmen sieht man dort nicht.
- Vorgaben: Hintergrund `#111418`, Orange `#ff7a1a` (Tokens in `globals.css`), keine übertriebenen Glows.
- **Hintergrund aller Seiten**: Bild des Besitzers als `src/assets/background.webp` (dunkle geschwungene Flächen mit orange leuchtenden Kanten, 2752x1536). Datei in voller Größe, sharp `webp({quality: 95, smartSubsample: true})`. Weichzeichnen macht der Browser: `body::before` fixed, `inset: -60px`, `cover`, `filter: blur(12px)`. Ein eingebackener Blur sah verpixelt aus, das lehnt er ab. Eigene SVG-/CSS-Formen hinter dem Fenster hat er ebenfalls abgelehnt.

## Landingpage (`landing.tsx`, `pages.css`)
- Kopfzeile 76px: Wortmarke `forge-wordmark.png` (944x184). Rechts: Live Stats, GitHub, Unterstützen mit rotem Herz, Download. Die geöffnete Seite bekommt eine orange Linie unter dem Link.
- Hero ohne Eyebrow. Titel `4.1vw` Gewicht 550, Lead `1.39vw` mit `max-width: 25.85em` (Umbruch nach „mit einer“, bei Textänderung neu prüfen).
- Fenster: echter Screenshot der Chat-Ansicht, aufgenommen 2400x1680 (`app-{de,en}-2400.webp`), dazu mit sharp lanczos3 verkleinert 800/1200/1600; `<img srcSet sizes="(max-width: 1080px) 100vw, 50vw">`. Grund: Unter dem 3D-Transform verkleinert die GPU ohne gutes Filtern. Neue Screenshots: alle vier Breiten neu erzeugen.
- Neigung `perspective(2000px) rotateY(-11deg)`, folgt dem Mauszeiger (`components/tilt.tsx`, `--tilt-x/-y`, ±6°/±4°, nur `pointer: fine`, nicht bei reduced motion). Stärkere Neigung (15°) machte den Screenshot unscharf.
- Vier Blöcke darunter, alle Icons orange. Alles inkl. „Live Stats ansehen“ passt bei 1440x900 in den ersten Bildschirm. Darunter FAQ (`faq-item`, details/summary).

## Mobile Ansicht (bis 560px, überarbeitet 2026-10-19 auf „ist aktuell cooked“)
Breakpoints: 1500, 1320, 1080, 900, 560 px (`pages.css` am Ende, `globals.css` für `.feature`/`.section-head`). Bis 560px: Hero-Buttons gleich breit untereinander; Funktionsblöcke und „Was erfasst wird“ als kompakte Karten mit Icon links (`.feature` als Grid); Statistik-Karten einspaltig und kompakt (zweispaltig passt nicht: Zahlen wie „19,920“ oder lange Token-Summen laufen über); Zeitraum-Auswahl unter dem Diagrammtitel; Anteile (`.share`) mit Name und Prozent in einer Zeile und Balken darunter.
- **Stolperfalle:** Der Spenden-Dialog (`SupportButton`) liegt im DOM innerhalb von `.topbar-nav`. Regeln wie `.topbar-nav .btn` treffen auch seine Buttons; die mobile Icon-Regel ist deshalb `.topbar-nav > .btn`.
- Prüfen bei 360, 375, 390 px, Englisch und Deutsch, Dialog offen. Die Diagramme blenden per IntersectionObserver ein: für fullPage-Screenshots Höhe 2000 setzen, sonst bleiben sie leer.

## Spenden-Dialog (`components/donations.tsx`, Styles in `globals.css`)
Kurz halten: Herz-Kachel + Titel, ein Satz, Karte „Bisher gespendet“, Buttons „Beitrag über Stripe“ und „Idee oder Fehler melden“, eine Zeile Hinweis. Betrag aus Stripe (`STRIPE_SECRET_KEY` nur auf dem Live-Server); `next dev` ohne Schlüssel holt ihn von `https://forge.vanturis.de/api/v1/donations`.

## Live Stats (/stats)
`stats-page.tsx`, `live-stats.tsx`, `charts.tsx`, `tiles.ts`.
- Sechs Karten im 3er-Raster: Tokens, Sessions, Durchläufe, Arbeitszeit, Kosten, Gerade online. Rechts je 7 Mini-Balken (`Spark`).
- Diagrammkarten (2er-Raster, 8 Karten): Tokens pro Tag, Aktive Installationen (je `RangeSelect`, kein `<select>`); Top Modelle (3 + „Andere“); Plattformen (Ring). Seit 2026-10-19 darunter: **Versionen** (aktive Installationen je `app_version`, Top 4 nach Anzahl, absteigend nach Version sortiert, Marke „neueste“ über `newestVersion`), **Claude-Abos** (`plans`, `planName`: „max_20x“ → „Max 20x“, null = „Unbekannt“ als letzte Zeile), **Sprachen** (`languages`, Namen über `Intl.DisplayNames`), **Funktionen** (Zahlenraster: Installationen + `newInstalls30d`, aktiv 30 Tage, eigene Prompts `userTurns`, Projekte, Agenten gestartet/zusammengeführt, Telefonate). Gemeinsame Bausteine: `ShareList`, `topRows`, `withUnknown`. Skeletons für alle Karten in `ChartsSkeleton`.
- Daten: `history` (30 Tage); `versions`, `plans`, `platforms`, `languages` jeweils über aktive Installationen der letzten 30 Tage.
- Darunter „Was erfasst wird“ und Fußnote.

## Erfasste Felder
Meldung: Installations-ID, `appVersion`, `os`, Zähler (`COUNTER_KEYS` in `src/lib/report.ts`), `models`, `plan`, seit 2026-10-19 `language` (Sprache der Oberfläche, `^[a-z]{2}$`, Spalte `installs.language`, ältere Apps: null). Der Besitzer will alles Sinnvolle sehen, aber nichts, was Nutzer ausspäht (keine Inhalte, Namen, Pfade). Neues Feld: Checkliste im Eintrag zur anonymen Nutzungsstatistik. Ein alter Dienst ignoriert unbekannte Felder (zod strippt), eine neue App kann also vor dem Deploy erscheinen.

## Domain
Neu `forge.vanturis.de`, vorher `forge-stats.vanturis.de`. Apps bis 0.1.103 melden an die alte Domain: beide Domains am Dienst lassen. Prüfen: `curl https://forge.vanturis.de/api/health` liefert `ok`.

## Meldeintervall
App meldet alle 5 Minuten, Sperre pro installId 4 Minuten (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`), „Gerade online“ = 10 Minuten (`ONLINE_MINUTES`).

## Verlauf (install_days)
Jede angenommene Meldung schreibt `installs` und den UTC-Tag in `install_days` (FK mit CASCADE). Zuwachs pro Tag rechnet SQL (`historySql()`, LAG); der erste Stand einer Installation zählt nicht als Zuwachs (deshalb zeigt „Tokens pro Tag“ bei frischen Demodaten „Noch keine Daten“). Test: `STATS_TEST_DATABASE_URL=... pnpm test`.

## Sprachen der Seite
Standard Englisch; Cookie `lang` > Accept-Language. `LanguageSwitch` in der Fußzeile (`.lang-btn`, zweiter = Deutsch). Texte in `src/lib/messages.ts` (`de` ist Quelle des Typs: Funktionen mit Literal-Rückgabe brauchen `: string`, sonst passt `en` nicht).

## Stolperfallen
- **Nicht im pnpm-Workspace**: `pnpm install --ignore-workspace`, eigenes Lockfile. ESLint ignoriert `services/`; Typprüfung mit `pnpm exec tsc --noEmit -p .` im Ordner.
- **Kein `public/`-Ordner**: Bilder statisch importieren oder per relativer `url()` in globalem CSS.
- Dev-Server: `DATABASE_URL=<Test-DB aus dev_environment> pnpm exec next dev -p 4100` im Hintergrund (der FORGE-Dev-Server des Projekts ist die Desktop-App, nicht diese Seite). Summen sind 5 Minuten im Prozess gecacht: nach SQL-Testdaten neu starten. TaskStop beendet nur die Shell; der Next-Prozess hält Port 4100 weiter (Prozess am Port mit `Get-NetTCPConnection -LocalPort 4100` finden und beenden).
- Lokale Demodaten: per Node-Skript mit `pg` **im Ordner services/stats** (Schreiben außerhalb des Projekts sperrt die FORGE-Policy; Skript danach löschen) in `installs` (mit `models`, `plan`, `language`) + `install_days` (Zähler aus `COUNTER_KEYS`, steigend über 30 Tage), IDs `00000000-0000-4000-8000-0000000000cN`; löschen mit `DELETE FROM installs WHERE install_id::text LIKE '00000000-0000-4000-8000-0000000000c%'`.
- Bash-Heredocs verlieren Backslashes; Python-Edit-Skripte, die Text mit `\n` suchen, scheitern an CRLF-Arbeitskopien (`core.autocrlf=true`): lieber das Edit-Werkzeug.

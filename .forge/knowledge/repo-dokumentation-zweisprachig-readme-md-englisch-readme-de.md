---
title: "Repo-Dokumentation zweisprachig (README.md englisch, README.de.md deutsch, Sprachumschalter, Flaggen, Screenshots)"
summary: "Wie die Markdown-Dokumente im Repo auf Englisch und Deutsch gepflegt werden und wie die README-Screenshots entstehen; nötig bei jeder Änderung an README, docs/, ADRs, NOTICE, Issue-Vorlagen oder Screenshots."
tags: ["konvention","i18n","release","github","preview"]
updated: "2026-10-18T20:44:19.096Z"
---

Seit Oktober 2026 ist die Repo-Doku zweisprachig. Englisch ist Standard.

- Englisch steht unter dem ursprünglichen Dateinamen, Deutsch unter `<name>.de.md` im selben Ordner: README, CONTRIBUTING, SECURITY, docs/ARCHITECTURE, docs/SECURITY, docs/TESTING, alle docs/adr/*.md, services/stats/README. Neue ADRs und Dokumente ebenfalls in beiden Sprachen anlegen, Änderungen immer in beiden Dateien machen.
- Erste Zeile jeder Datei ist der Sprachumschalter mit SVG-Flaggen aus `.github/assets/flags/` (gb.svg, de.svg, keine Emoji), Pfad relativ zur Ordnertiefe (`../` in docs/, `../../` in docs/adr/ und services/stats/). Englisch: `<img src=".../gb.svg" height="14" alt=""> English · <a href="X.de.md"><img src=".../de.svg" height="14" alt=""> Deutsch</a>`, Deutsch spiegelbildlich.
- Links zwischen Dokumenten zeigen auf die gleiche Sprache (deutsche Dateien auf `.de.md`). Anker unterscheiden sich: englisches README hat `#development`, `#privacy`, `#support-forge`; deutsches `#entwickeln`, `#datenschutz`, `#unterstützen`.
- Dateien, die mit festem Namen in den Installer gehen (tauri.conf.json `resources`: NOTICE, THIRD_PARTY_LICENSES.md, THIRD_PARTY_NOTICES.md), bleiben eine Datei: NOTICE und THIRD_PARTY_LICENSES.md haben die deutsche Fassung unter dem englischen Text (englisch maßgeblich). THIRD_PARTY_NOTICES.md ist englisch, Kopf kommt aus `scripts/third-party-notices.mjs` (`pnpm notices`, läuft offline).
- Issue-Vorlagen (.github/ISSUE_TEMPLATE) sind englisch mit dem Hinweis, dass Deutsch willkommen ist.
- Englischer Stil: knapp, keine Gedankenstriche (— –) als Satzzeichen, keine Werbesprache.

## README-Screenshots
- Deutsch: `.github/assets/screenshots/start.png`, `projekte.png`; Englisch: `.github/assets/screenshots/en/start.png`, `en/projects.png`. Alle 2880x1800 (1440x900 bei Pixeldichte 2), dunkles Theme, gleiche Demo-Inhalte: Projekte forge (Favorit, 2 geändert, TypeScript +2, 2 Tags, ein Agent `bundle-python-4dyz`), landingpage, api-gateway, webshop (je 1 Tag), fünf zuletzt bearbeitete Sessions, darunter eine unterbrochene.
- So entstanden die englischen (2026-10-18), nicht mit echten Nutzerdaten: eigenes Datenverzeichnis per Skript (Klon des Repos plus Worktree, drei kleine Git-Repos; Projekte und Sessions direkt per SQL über `new Db(...).sql`, Einstellungen `language`, `setupDone`, `syncAsked`, `usageStatsAsked`), gebauter Sidecar mit `FORGE_DATA_DIR` hinter einer kleinen HTTP-Brücke, die Oberfläche über Vite (`--port 1430`) mit einer Startseite, die `__TAURI_INTERNALS__` nachbildet (siehe Eintrag zum Git-Reiter / Desktop-UI im Browser). Aufnahme mit Chrome headless über das DevTools-Protokoll (`Emulation.setDeviceMetricsOverride` 1440x900, deviceScaleFactor 2, `Page.captureScreenshot`), nach ~30 s Wartezeit. `preview_screenshot` taugt dafür nicht: höchstens 2560 px breit und verkleinert. `chrome --screenshot --virtual-time-budget` hängt an der offenen Long-Poll-Verbindung.
- Stolperfalle: Die erste Seite nach dem Start der Brücke blieb in Skeletons hängen (Antworten an eine alte Poll-Verbindung). Erst eine andere Ansicht aufnehmen, dann die gewünschte.

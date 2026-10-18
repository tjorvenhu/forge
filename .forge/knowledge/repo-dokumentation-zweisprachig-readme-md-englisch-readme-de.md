---
title: "Repo-Dokumentation zweisprachig (README.md englisch, README.de.md deutsch, Sprachumschalter, Flaggen)"
summary: "Wie die Markdown-Dokumente im Repo auf Englisch und Deutsch gepflegt werden; nötig bei jeder Änderung an README, docs/, ADRs, NOTICE oder Issue-Vorlagen."
tags: ["konvention","i18n","release","github"]
updated: "2026-10-18T15:59:10.855Z"
---

Seit Oktober 2026 ist die Repo-Doku zweisprachig. Englisch ist Standard.

- Englisch steht unter dem ursprünglichen Dateinamen, Deutsch unter `<name>.de.md` im selben Ordner: README, CONTRIBUTING, SECURITY, docs/ARCHITECTURE, docs/SECURITY, docs/TESTING, alle docs/adr/*.md, services/stats/README. Neue ADRs und Dokumente ebenfalls in beiden Sprachen anlegen, Änderungen immer in beiden Dateien machen.
- Erste Zeile jeder Datei ist der Sprachumschalter mit SVG-Flaggen aus `.github/assets/flags/` (gb.svg, de.svg, keine Emoji), Pfad relativ zur Ordnertiefe (`../` in docs/, `../../` in docs/adr/ und services/stats/). Englisch: `<img src=".../gb.svg" height="14" alt=""> English · <a href="X.de.md"><img src=".../de.svg" height="14" alt=""> Deutsch</a>`, Deutsch spiegelbildlich.
- Links zwischen Dokumenten zeigen auf die gleiche Sprache (deutsche Dateien auf `.de.md`). Anker unterscheiden sich: englisches README hat `#development`, `#privacy`, `#support-forge`; deutsches `#entwickeln`, `#datenschutz`, `#unterstützen`.
- Dateien, die mit festem Namen in den Installer gehen (tauri.conf.json `resources`: NOTICE, THIRD_PARTY_LICENSES.md, THIRD_PARTY_NOTICES.md), bleiben eine Datei: NOTICE und THIRD_PARTY_LICENSES.md haben die deutsche Fassung unter dem englischen Text (englisch maßgeblich). THIRD_PARTY_NOTICES.md ist englisch, Kopf kommt aus `scripts/third-party-notices.mjs` (`pnpm notices`, läuft offline).
- Issue-Vorlagen (.github/ISSUE_TEMPLATE) sind englisch mit dem Hinweis, dass Deutsch willkommen ist.
- Screenshots im README zeigen noch die deutsche Oberfläche. Englische Bilder sollen nach `.github/assets/screenshots/en/start.png` und `en/projects.png`; ein HTML-Kommentar im englischen README markiert die Stelle.
- Englischer Stil: knapp, keine Gedankenstriche (— –) als Satzzeichen, keine Werbesprache.

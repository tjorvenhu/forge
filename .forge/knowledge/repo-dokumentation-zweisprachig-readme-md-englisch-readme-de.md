---
title: "Repo-Dokumentation zweisprachig (README.md englisch, README.de.md deutsch, Sprachumschalter, Flaggen, Screenshots)"
summary: "Wie die Markdown-Dokumente im Repo auf Englisch und Deutsch gepflegt werden und wie echte App-Screenshots (README, Landingpage) ohne Tauri aufgenommen werden; nötig bei Änderungen an README, docs/, ADRs, NOTICE, Issue-Vorlagen oder Screenshots."
tags: ["konvention","i18n","release","github","preview"]
updated: "2026-10-19T16:29:50.604Z"
---

Seit Oktober 2026 ist die Repo-Doku zweisprachig. Englisch ist Standard.

- Englisch steht unter dem ursprünglichen Dateinamen, Deutsch unter `<name>.de.md` im selben Ordner: README, CONTRIBUTING, SECURITY, docs/ARCHITECTURE, docs/SECURITY, docs/TESTING, alle docs/adr/*.md, services/stats/README. Neue ADRs und Dokumente ebenfalls in beiden Sprachen anlegen, Änderungen immer in beiden Dateien machen.
- Erste Zeile jeder Datei ist der Sprachumschalter mit SVG-Flaggen aus `.github/assets/flags/` (gb.svg, de.svg, keine Emoji), Pfad relativ zur Ordnertiefe (`../` in docs/, `../../` in docs/adr/ und services/stats/). Englisch: `<img src=".../gb.svg" height="14" alt=""> English · <a href="X.de.md"><img src=".../de.svg" height="14" alt=""> Deutsch</a>`, Deutsch spiegelbildlich.
- Links zwischen Dokumenten zeigen auf die gleiche Sprache (deutsche Dateien auf `.de.md`). Anker unterscheiden sich: englisches README hat `#development`, `#privacy`, `#support-forge`; deutsches `#entwickeln`, `#datenschutz`, `#unterstützen`.
- Dateien, die mit festem Namen in den Installer gehen (tauri.conf.json `resources`: NOTICE, THIRD_PARTY_LICENSES.md, THIRD_PARTY_NOTICES.md), bleiben eine Datei: NOTICE und THIRD_PARTY_LICENSES.md haben die deutsche Fassung unter dem englischen Text (englisch maßgeblich). THIRD_PARTY_NOTICES.md ist englisch, Kopf kommt aus `scripts/third-party-notices.mjs` (`pnpm notices`, läuft offline).
- Issue-Vorlagen (.github/ISSUE_TEMPLATE) sind englisch mit dem Hinweis, dass Deutsch willkommen ist.
- Englischer Stil: knapp, keine Gedankenstriche (— –) als Satzzeichen, keine Werbesprache.

## README-Screenshots
- Deutsch: `.github/assets/screenshots/start.png`, `projekte.png`; Englisch: `.github/assets/screenshots/en/start.png`, `en/projects.png`. Alle 2880x1800 (1440x900 bei Pixeldichte 2), dunkles Theme, Demo-Inhalte: Projekte forge, landingpage, api-gateway, webshop.
- Landingpage-Screenshots `services/stats/src/assets/app-{de,en}.webp`: 2400x1680 (1200x840 bei Faktor 2), Chat-Ansicht mit leerer Session und Text im Composer (2026-10-19).

## Echte Screenshots ohne Tauri aufnehmen (Hilfsdateien danach löschen)
- Eigenes Datenverzeichnis über `FORGE_DATA_DIR`, Demo-Repos unter `C:\tmp\demo\` (liegen noch dort). Einstellungen per RPC `settings.update`: `setupDone`, `syncAsked`, `usageStatsAsked` = true; gegen Störungen `updateChecks`, `desktopNotifications`, `screenshotKey`, `uiCompare`, `learnTemplates` = false. Projekte per `projects.import`.
- Einfachste Brücke: eigene `vite.config.ts` in einem Hilfsordner unter `apps/desktop/`, deren Plugin den gebauten Sidecar startet und `/bridge/send` (stdin), `/bridge/events` (Server-Sent Events) und `/bridge/rpc` anbietet: ein Prozess, kein CORS, keine hängende Erstansicht. Startseite setzt vor dem App-Import `window.__TAURI_INTERNALS__` (`invoke`, `transformCallback`; `plugin:event|listen` merkt die Callback-ID, Zeilen gehen als `sidecar://messages` mit `payload: [line]` zurück; `sidecar_status` → true).
- `chat_windows` muss `{ sessions: [], pinned: [] }` liefern, sonst „sessions is not iterable“ und Meldung „Hintergrunddienst läuft nicht“.
- Aufnahme mit Chrome headless über CDP (`Emulation.setDeviceMetricsOverride` mit deviceScaleFactor 2, `Page.captureScreenshot`). Chrome-Profil nicht im Vite-Root anlegen (Cache-Dateien lösen Reloads aus). `preview_screenshot` taugt nicht (max. 2560 px, verkleinert).
- Reiterleiste der Projektansicht ist standardmäßig zu: Knopf `aria-label="Werkzeugleiste"`. Text in den Composer: `focus()`, dann CDP `Input.insertText`.
- Sprachwechsel: erst `about:blank`, dann `language` per RPC setzen, dann mit `?lang=en` laden (sonst Reload-Schleife zwischen localStorage `forge.language` und Einstellung).
- Die Claude-Code-Karte zeigt die echte lokale Anmeldung (Abo, Nutzung); `github.account` und `claude.checkUpdate` in der Brücke umschreiben, um Avatar und Update-Hinweis auszublenden.

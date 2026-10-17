---
title: "Statistik-Dienst services/stats (forge-stats.vanturis.de, Coolify, außerhalb des Workspace)"
summary: "Wie der Next.js-Statistikdienst in services/stats gebaut, getestet, gestaltet und in Coolify betrieben wird, und welche Stolperfallen es dabei gibt."
tags: ["stats","coolify","release","stolperfalle","windows","ui"]
updated: "2026-10-17T20:36:41.163Z"
---

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge-stats.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (URL in `packages/protocol/src/support.ts`, `USAGE_STATS_URL`) und zeigt die Summen. Details zu API und Coolify stehen in `services/stats/README.md`.

## Meldeintervall
Die App meldet alle 5 Minuten. Die Sperre pro installId (`REPORT_INTERVAL_MINUTES` in `src/lib/db.ts`) steht deshalb auf 4 Minuten: gleich lang wie das App-Intervall würde jede zweite Meldung mit 429 abweisen, sobald der Timer etwas früh feuert. Ändert die App ihr Intervall, Konstante, `db.test.ts` und die Texte (Seite, README) mitziehen.

## Design
Die Seite übernimmt das Design der Desktop-App ohne Tailwind: Tokens aus `apps/desktop/src/styles.css` als CSS-Variablen in `src/app/globals.css` (nur dunkel, die App hat kein helles Theme), Bausteine in `src/components/blocks.tsx` nach ReportView-Kacheln und settings/layout.tsx Group/Row. Schrift Geist über das npm-Paket `geist` (next/font/local, OFL), nicht über next/font/google (bräuchte Netz beim Build). Ändert die App ihre Tokens, hier nachziehen.

## Stolperfallen
- **Nicht im pnpm-Workspace** (Globs sind apps/* und packages/*). Im Ordner immer `pnpm install --ignore-workspace` bzw. `pnpm add --ignore-workspace`, eigenes `pnpm-lock.yaml`. Die Worktree-Vorbereitung von FORGE installiert hier nichts.
- **Kein `public/`-Ordner**: Das Dockerfile kopiert nur `.next/standalone` und `.next/static`. Bilder deshalb statisch importieren (`import logo from "@/assets/forge-logo.png"`, landet in `.next/static/media`), Favicons als `src/app/icon.svg` / `apple-icon.png`.
- `pnpm exec tsc --noEmit` meldet vor dem ersten `pnpm build`/`next dev` Fehler (`RouteContext`, Bild-Importe), weil `next-env.d.ts` und `.next/types` fehlen. Nach dem Build ist es sauber.
- Ohne `outputFileTracingRoot` und `turbopack.root` in `next.config.ts` nimmt Next das Repo-Root (dessen Lockfile) als Wurzel und legt die Standalone-Ausgabe unter `.next/standalone/services/stats/server.js` ab. Mit der Einstellung liegt `server.js` direkt in `.next/standalone`, wie das Dockerfile es erwartet.
- `next dev` schreibt `services/stats/AGENTS.md` (Next-Agentenregeln) immer wieder neu. Die Datei ist deshalb committet.
- TypeScript bleibt auf ~6.0 wie im Rest des Repos; `typescript` 7 (nativ) ist zwar als neueste Version gelistet, Next nutzt aber die JS-API.
- lucide-react 1.x hat keine Marken-Icons mehr (kein `Github`); für den GitHub-Link `GitFork`.
- Die Summen werden im Prozess 5 Minuten zwischengespeichert (`getTotals` in `src/lib/db.ts`). Nach Testdaten direkt per SQL den Dev-Server neu starten, sonst zeigt die Seite den alten Stand.
- Die Sperre "20 neue IDs pro IP und Tag" liegt nur im Speicher und beginnt nach jedem Neustart von vorn. Gegen mehrere Instanzen hilft sie nicht; der Dienst ist für eine Instanz gedacht.

## Lokal gegen Postgres testen
FORGE-Testdatenbank mit `dev_control database start` starten (URL aus der Antwort, der Port kann sich gegenüber `dev_environment` ändern). Dann im Ordner `DATABASE_URL=... pnpm exec next dev -p 4100`. Der Dev-Server von FORGE (`pnpm dev` im Root) ist der Tauri-Start und passt hier nicht. SQL ohne psql: `node -e` mit `require('pg')` aus `services/stats/node_modules`. Nach TaskStop den Port prüfen (siehe Eintrag zu Hintergrund-Servern), danach die Tabelle `installs` wieder löschen.

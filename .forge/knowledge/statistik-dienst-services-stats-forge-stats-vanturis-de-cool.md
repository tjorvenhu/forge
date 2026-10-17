---
title: "Statistik-Dienst services/stats (forge-stats.vanturis.de, Coolify, außerhalb des Workspace)"
summary: "Wie der Next.js-Statistikdienst in services/stats gebaut, getestet und in Coolify betrieben wird, und welche Stolperfallen es dabei gibt."
tags: ["stats","coolify","release","stolperfalle","windows"]
updated: "2026-10-17T20:04:58.163Z"
---

## Was es ist
`services/stats` ist ein eigenständiges Next.js-Projekt (App Router, pg, zod) für https://forge-stats.vanturis.de. Es nimmt die Meldungen von `packages/sidecar/src/stats/usage-stats.ts` an (URL in `packages/protocol/src/support.ts`, `USAGE_STATS_URL`) und zeigt die Summen. Details zu API und Coolify stehen in `services/stats/README.md`.

## Stolperfallen
- **Nicht im pnpm-Workspace** (Globs sind apps/* und packages/*). Im Ordner immer `pnpm install --ignore-workspace` bzw. `pnpm add --ignore-workspace`, eigenes `pnpm-lock.yaml`.
- Ohne `outputFileTracingRoot` und `turbopack.root` in `next.config.ts` nimmt Next das Repo-Root (dessen Lockfile) als Wurzel und legt die Standalone-Ausgabe unter `.next/standalone/services/stats/server.js` ab. Mit der Einstellung liegt `server.js` direkt in `.next/standalone`, wie das Dockerfile es erwartet.
- `next dev` schreibt `services/stats/AGENTS.md` (Next-Agentenregeln) immer wieder neu. Die Datei ist deshalb committet.
- TypeScript bleibt auf ~6.0 wie im Rest des Repos; `typescript` 7 (nativ) ist zwar als neueste Version gelistet, Next nutzt aber die JS-API.
- Die Summen werden im Prozess 5 Minuten zwischengespeichert (`getTotals` in `src/lib/db.ts`). Nach Testdaten direkt per SQL den Dev-Server neu starten, sonst zeigt die Seite den alten Stand.
- Die Sperre "20 neue IDs pro IP und Tag" liegt nur im Speicher und beginnt nach jedem Neustart von vorn. Gegen mehrere Instanzen hilft sie nicht; der Dienst ist für eine Instanz gedacht.

## Lokal gegen Postgres testen
FORGE-Testdatenbank mit `dev_control database start` starten (URL aus der Antwort, der Port kann sich gegenüber `dev_environment` ändern). Dann im Ordner `DATABASE_URL=... pnpm exec next dev -p 4100`. Der Dev-Server von FORGE (`pnpm dev` im Root) ist der Tauri-Start und passt hier nicht. Nach TaskStop den Port prüfen (siehe Eintrag zu Hintergrund-Servern), danach die Tabelle `installs` wieder löschen.

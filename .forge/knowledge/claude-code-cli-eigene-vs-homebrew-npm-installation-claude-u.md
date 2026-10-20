---
title: "Claude-Code-CLI: eigene vs. Homebrew/npm-Installation (claude update No-Op, locateClaude, hasOwnClaude)"
summary: "Warum der Claude-Code-Update-Knopf auf macOS scheinbar nichts tut und wie FORGE seine eigene, aktualisierbare CLI bevorzugt; relevant bei allem rund um Claude-Code-Installation/-Update."
tags: ["stolperfalle","sidecar","update","installer"]
updated: "2026-10-20T09:47:59.407Z"
---

# Claude-Code-CLI: eigene vs. extern verwaltete Installation

FORGE installiert und aktualisiert Claude Code **nicht** über npm, sondern über Anthropics `install.sh`/`install.ps1` (nach `~/.local/bin/claude`) und für Updates den CLI-eigenen `claude update`. Code: `packages/sidecar/src/claude/{setup.ts,update.ts,environment.ts}`.

## Die Stolperfalle (macOS, 2026-10-20)
Ist Claude Code über **Homebrew** (häufig auf dem Mac) oder npm installiert, ist `claude update` ein **stiller No-Op mit Exit-Code 0**: es gibt nur „Claude is managed by Homebrew … brew upgrade claude-code" aus und aktualisiert nichts. FORGE wertete 0 als Erfolg und meldete die unveränderte Version als „installiert" → der Update-Knopf tat scheinbar etwas, änderte aber nie die Version. `claude.checkUpdate` zeigte das Update trotzdem korrekt an, weil es den Release-Endpoint (`downloads.claude.ai/claude-code-releases/<channel>`) abfragt, nicht `claude update`. Auf Linux fällt es seltener auf, weil dort meist `install.sh` (nativer, selbst-aktualisierender Installer) genutzt wird.

## Lösung
FORGE bevorzugt und erzwingt seine **eigene** native Installation (die sich per `claude update` selbst aktualisiert) und legt eine Homebrew/npm-CLI beiseite (entfernt sie nicht):
- `environment.ts`: `ownClaudeCandidates()` = `~/.local/bin/claude[.exe]`, `~/.claude/local/claude[.exe]`. `locateClaude()` prüft diese **vor** `which("claude")`, erst danach Homebrew (`/opt/homebrew/bin`, `/usr/local/bin`). `hasOwnClaude()` = eine davon existiert.
- `app.ts` (Start): Auto-Install läuft, sobald **keine eigene** Installation da ist (`!hasOwnClaude()`), nicht erst wenn gar keine gefunden wird. So wird eine reine Homebrew/npm-CLI beim ersten Start durch die eigene ersetzt. Ein gesetzter `settings.claudePath` wird respektiert.
- `setup.ts` `update()`: ohne gepinnten Pfad und ohne eigene Installation ruft der Update-Knopf direkt `install()` (holt die eigene Kopie). Bei gepinntem Pfad auf eine extern verwaltete CLI: wird im Log `managed by` erkannt, gibt es `updateExternallyManaged` (ehrliche Meldung) statt falschem Erfolg.

Tests: `test/claude-setup.test.ts` (Update → Install-Fallback, managed-by-Meldung), `test/setup-tools.test.ts` (`ownClaudeCandidates`, `hasOwnClaude`).

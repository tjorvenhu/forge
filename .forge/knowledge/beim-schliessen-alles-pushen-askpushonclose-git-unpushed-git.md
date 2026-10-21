---
title: "Beim Schließen alles pushen (askPushOnClose, git.unpushed, git.pushAll, PushAllDialog)"
summary: "Wie FORGE beim Schließen des Hauptfensters nach ungepushter Arbeit fragt, alles committet und pusht, und wo Einstellung, Palette und Telefon dafür hängen."
tags: ["git","tauri","einstellungen","telefon","stolperfalle"]
updated: "2026-10-21T17:12:40.325Z"
---

Gebaut 2026-10-21 (Wunsch des Besitzers: beim Schließen fragen, ob alles Ungepushte gepusht werden soll, damit man an einem anderen Gerät weiterarbeiten kann; Haken „Nicht mehr fragen“, in den Einstellungen wieder einschaltbar).

## Ablauf
- `apps/desktop/src/lib/push-on-close.ts`: `startPushOnClose()` (nur Hauptfenster, aus `main.tsx`) hängt sich an `getCurrentWindow().onCloseRequested`. Liest `settings.get` und `git.unpushed` (je max. 8 s, bei Fehler/Timeout schließt FORGE ohne Frage). Leere Liste: schließt normal. Sonst `preventDefault()` und Store `usePushAll` öffnet `components/git/PushAllDialog.tsx`.
- Schließen danach über `closeMainWindow()` = `destroy()`; braucht die Capability `src-tauri/capabilities/main-close.json` (`core:window:allow-destroy` für `main`). Der Rust-Handler `WindowEvent::Destroyed` des Hauptfensters ruft `app.exit(0)`.
- Dialog-Modi: `close` (Abbrechen, Ohne Pushen schließen / Trotzdem schließen, Pushen und schließen, Haken Nicht mehr fragen → `askPushOnClose: false`) und `manual` (Befehlspalette „Alles auf GitHub pushen“, `openPushAll()`, Skeleton während `git.unpushed` lädt).
- Der Dialog pusht mit `allowProtected: true`, weil die Liste jeden Branch (auch main) vor der Bestätigung zeigt. Telefon (`git` Aktionen `unpushed`, `push_all`) nur mit `allow_protected`.
- macOS Cmd+Q läuft an `onCloseRequested` vorbei (RunEvent::ExitRequested), dort wird nicht gefragt.

## Sidecar
- `packages/sidecar/src/git/push-all.ts` (`PushAll`, in `createHandlers` gebaut, nicht in `Services`).
- Kandidaten: existierend, gitEnabled, **keine Worktrees** (`parentId`), mit `origin`, nicht detached.
- `changed` zählt nur, was ein Commit nehmen würde (ohne `isSensitiveFile`, `isArtifactPath`, Konflikte), wie bei auto-commit. `ahead` über `GitEngine.unpushedCount`: mit Upstream `summary.ahead`, ohne `rev-list --count HEAD --not --remotes=origin`. Kein fetch vorher (Schließen soll schnell sein).
- `pushAll`: Commit-Nachricht über `suggestCommitMessage` (Haiku), Ersatz `system.git.pushAllMessage`. Projekte im selben Repository (Monorepo, `repoRoot`) laufen nacheinander (gemeinsamer Index), Repositories parallel. Konflikte beim Übernehmen vom Server werden als Fehler gemeldet, **keine** Claude-Session wie bei `git.push`.
- Wird der Push abgelehnt (z. B. main ohne allowProtected), bleibt der Commit lokal; `committed` im Ergebnis sagt das.

Tests: `packages/sidecar/test/git-push-all.test.ts` (echtes Git mit bare Remote), `apps/desktop/src/components/git/PushAllDialog.test.tsx`.

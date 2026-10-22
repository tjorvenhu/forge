---
title: "Geteilte Projekteinstellungen im Repo (.forge/project.json: Test- und Dev-Befehl) vs. persönliche Einstellungen"
summary: "Welche Projekteinstellungen im Repo liegen und für alle gelten (Test-/Dev-Befehl) und welche pro Nutzer bleiben (Favorit, Tags, Gruppe, Profil, Modell); Vorrang, Sync, Worktrees."
tags: ["projekte","sidecar","sync","einstellungen","konvention"]
updated: "2026-10-21T16:14:53.407Z"
---

**Entscheidung (2026-10-21):** Test- und Dev-Befehl gehören zum Code, nicht zur Person. Sie liegen in `.forge/project.json` im Repo (wird committet), damit alle, die am selben Repo arbeiten, dieselben Befehle haben. Favorit, Tags, Gruppe, Profil, Standardmodell/-aufwand bleiben persönlich (SQLite `projects` + Sync ins private `forge-data`-Repo des GitHub-Kontos).

**Umsetzung** (`packages/sidecar/src/projects/project-file.ts`, `SHARED_KEYS`):
- Lesen: `ProjectManager.withExists` legt die Werte der Datei über die DB-Werte. Ein Schlüssel in der Datei gewinnt, auch `null` (z. B. `devCommand: null` = für alle automatisch erkennen). Fehlt ein Schlüssel, gilt der lokale DB-Wert. `Project.projectFile` ist true, wenn die Datei mindestens einen Befehl setzt.
- Schreiben: `ProjectManager.update` schreibt nur Schlüssel, die sich gegenüber dem wirksamen Wert ändern, in die Datei (andere Schlüssel bleiben erhalten) und zusätzlich in die DB. Kaputtes JSON wird nicht überschrieben (Fehler `projectFileInvalid`); beim Lesen gelten dann die lokalen Werte.
- Agent-Worktrees (`parentId`) schreiben nie in die Datei; sie lesen die Datei ihres Worktrees.
- Sync (`app.ts`, `updateProject` für SyncService): Befehle von anderen Rechnern gehen nur in die lokale DB, nie in die Repo-Datei. Sonst entsteht eine Änderung im Repo, die beim nächsten Pull kollidiert.
- Cache nach mtime/Größe, weil `projects.all()` oft läuft.

**Folge:** Speichern legt `.forge/` im Projekt an; das Telefon listet dann `.forge` als Ordner und nennt in den Projekteinstellungen „Befehle aus .forge/project.json im Repo“. Bestehende DB-Werte werden nicht automatisch in Dateien migriert; erst beim nächsten Speichern.

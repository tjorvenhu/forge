---
title: "FORGE-Policy-Sperren in Sessions"
summary: "Was die FORGE-Policy einer Claude-Session hier verbietet (Branch löschen, Schreiben außerhalb des Projekts) und wie man damit umgeht."
tags: ["policy","git","stolperfalle"]
updated: "2026-10-13T09:25:16.414Z"
---

In Sessions dieses Projekts blockieren FORGE-Hooks (PreToolUse):
- `git branch -D` / Branch löschen: "FORGE-Policy (git-branch-delete)". Agenten-Branches daher über FORGE aufräumen: Modal "Agent fertig" bzw. Agenten-Reiter (Abschließen/Entfernen), Telefon `finish_agent`/`remove_agent` oder MCP `finish_agent` (braucht Freigabe des Nutzers). Diese laufen im Sidecar, nicht als Bash-Befehl.
- Edit/Write außerhalb des Projektordners (Autonomous-Profil): "write-outside-project". Hilfsskripte deshalb im Projekt anlegen und danach löschen, nicht in %TEMP%.

Zusätzlich: In Bash-Heredocs gehen Backslashes verloren (`\n`, `\``). Code-Änderungen mit mehrzeiligen Strings lieber mit Edit/Write machen.

---
title: "Bash-Heredocs verlieren Backslashes"
summary: "In der Bash-Shell dieser Windows-Umgebung gehen Backslashes in Heredocs verloren; Code mit mehrzeiligen Strings deshalb mit Edit/Write ändern."
tags: ["bash","windows","stolperfalle"]
updated: "2026-10-13T11:43:40.397Z"
---

In Bash-Heredocs gehen hier Backslashes verloren (`\n`, `\``). Wer Code mit Escapes oder mehrzeiligen Strings per `cat <<EOF > datei` schreibt, bekommt kaputte Strings, ohne dass ein Fehler erscheint. Solche Änderungen mit den Werkzeugen Edit/Write machen.

---
title: "Mitgeliefertes Python (NuGet-Paket, pip.ini user, PATH vor WindowsApps, runtimeKey _python)"
summary: "Warum FORGE Python als NuGet-Paket mitliefert, wie pip ohne Schreiben in den Installationsordner auskommt, welche Kopie Vorrang hat und welche Stolperfallen es gibt (PIP_USER, --target, Store-Platzhalter, Schlüssel)."
tags: ["python","runtime","release","windows","sidecar","stolperfalle"]
updated: "2026-10-17T11:35:36.635Z"
---

Stand 2026-10-17. Ausführlich mit Begründung: ADR 0006, „Nachtrag 2026-10-17: Python“.

## Wo
- `scripts/prepare-runtime.mjs`: `WINDOWS.python` (NuGet `python` 3.14.8, `sha512` base64), `preparePython()` legt `python3.exe`, `pip.ini`, `pip`/`pip3` (.cmd und sh) an und prüft `python3 -I -B -m pip --version`.
- Sidecar `util/tools.ts`: `resolveTool("python")`, `isStorePythonStub`, `pythonUserScripts`, `bundledPathEntries` (git/cmd, gh/bin, python, User-Scripts). `claude/environment.ts` setzt `PYTHONUTF8=1`, wenn die mitgelieferte Kopie da ist.
- Terminal: `runtime_path_entries` in `apps/desktop/src-tauri/src/terminal.rs` (gleiche Reihenfolge, liest die Python-Version aus VERSIONS.json).
- Diagnose `python: ToolCheck` (protocol `Diagnostics`), Einstellungen → Diagnose, Telefon `forgeSystem diagnostics`.

## Entscheidungen
- NuGet statt embeddable: embeddable hat kein pip, `python._pth` schaltet User-Site und Umgebungsvariablen ab, venv geht nicht. NuGet ist komplett (pip, venv, ensurepip, include/libs), aber ohne Tests/tkinter/IDLE, also nichts zu entfernen. 3.14 statt frischem 3.15 wegen Wheels.
- Prüfsumme: nuget.org veröffentlicht nur SHA-512 als base64, im Katalogeintrag (`packageHash`): `https://api.nuget.org/v3/registration5-gz-semver2/python/<v>.json` → `catalogEntry` → `packageHash`. Neue Version: Datei laden, `sha512sum | xxd -r -p | base64 -w0` mit dem Katalogwert vergleichen.
- Mitgelieferte Kopie hat Vorrang (wie git/gh): sonst fehlen bei python.org-Installationen `python3` und der Store-Platzhalter in WindowsApps gewinnt. Eigenes Python: `py` oder Projekt-venv.

## Stolperfallen
- `PIP_USER=1` als Umgebungsvariable bricht pip in jedem venv ab („User site-packages are not visible in this virtualenv“). Darum `pip.ini` in `sys.prefix`: gilt nur für den Basis-Interpreter, venvs lesen sie nicht.
- `user = true` unter `[install]`, nicht `[global]`: sonst zeigen `pip list`/`freeze` nur die User-Site.
- Mit `user = true` scheitert `pip install --target/--prefix` mit „Can not combine '--user' and '--target'“; Lösung `--no-user`.
- pips exe-Starter (Scripts/pip.exe) enthalten einen absoluten Pfad: darum eigene Shims. Git Bash findet `.cmd` nicht ohne Endung, darum zusätzlich ein Shell-Skript `pip` ohne Endung.
- WindowsApps\python.exe ist nur dann ein echtes Python, wenn daneben ein Ordner `PythonSoftwareFoundation.Python.*` liegt (`isStorePythonStub`).
- `runtimeKey` heißt jetzt `node-…_git-…_gh-…_python-…`; `installedRuntimeKey` (app-update.ts) hängt `_python-` nur an, wenn VERSIONS.json es hat. Alte Installationen passen so zu keinem neuen Update-Zip und bekommen den vollen Installer. `test/runtime-key.test.ts` vergleicht beide über `prepare-runtime.mjs --versions` und `--key`.
- Lokal testen: `node scripts/prepare-runtime.mjs`; Python nur neu bauen: `runtime/python` löschen und `python` aus `runtime/VERSIONS.json` entfernen.

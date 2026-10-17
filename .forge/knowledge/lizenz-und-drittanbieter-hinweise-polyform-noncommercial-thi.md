---
title: "Lizenz und Drittanbieter-Hinweise (PolyForm Noncommercial, THIRD_PARTY_NOTICES, pnpm notices)"
summary: "Wie Lizenz, NOTICE und die Liste gebündelter npm-Pakete aufgebaut sind, wann man sie neu erzeugt und wie sie in den Installer kommen."
tags: ["release","installer","tauri","konvention"]
updated: "2026-10-17T19:50:05.282Z"
---

## Lizenz
- FORGE steht unter PolyForm Noncommercial 1.0.0. `LICENSE.md` ist der unveränderte Originaltext (von github.com/polyformproject/polyform-licenses, Tag 1.0.0), nicht von Hand ändern.
- Die Pflichtzeile `Required Notice: ...` steht separat in `NOTICE` (die Lizenz verlangt, sie mit jeder Kopie weiterzugeben).
- Lizenzfelder: `"license": "PolyForm-Noncommercial-1.0.0"` in allen package.json, `license = ...` in `apps/desktop/src-tauri/Cargo.toml`. Neue Pakete im Monorepo bekommen dasselbe Feld.

## Drittanbieter
- `THIRD_PARTY_LICENSES.md` (von Hand): mitgelieferte Programme in `runtime/` (Node, Git, gh, Python) und PostgreSQL.
- `THIRD_PARTY_NOTICES.md` (erzeugt, eingecheckt): `pnpm notices` = `node scripts/third-party-notices.mjs`. Nach jeder Änderung an Produktions-Abhängigkeiten neu erzeugen; `--check` meldet eine veraltete Datei.
  - Sidecar: genau die Pakete, die esbuild in `sidecar.mjs` packt (Metafile mit demselben Einstiegspunkt wie `packages/sidecar/build.mjs`). Stand 2026-10: nur `@anthropic-ai/claude-agent-sdk` und `zod`.
  - Oberfläche: `pnpm --filter "@forge/desktop..." licenses list --prod` (mit `...`, sonst fehlen die Abhängigkeiten von `@forge/protocol`, etwa zod). Obermenge des Vite-Bundles, rechtlich unschädlich.
  - Die Datei enthält keine absoluten Pfade (Datenschutz), nur Name, Version, Lizenz, Copyright-Zeilen und Lizenztexte.

## In den Installer
- `tauri.conf.json` > `bundle.resources` ist eine Zuordnung (Objekt), nicht mehr ein Array: `"runtime/": "runtime/"` plus `"../../../LICENSE.md": "LICENSE.md"` usw. Grund: in der Array-Form landen Dateien außerhalb von `src-tauri` unter `_up_/_up_/_up_/`. In der Objekt-Form würde ein Glob wie `runtime/**/*` die Ordnerstruktur flachklopfen, deshalb steht `runtime/` als Ordner (WalkDir behält die Struktur). Geprüft mit `cargo check`: `target/debug/` bekommt die vier Dateien und `runtime/` unverändert.
- Die kleinen Update-Zips aus `release.yml` enthalten nur exe und Sidecar; die Lizenzdateien aktualisieren sich erst mit dem nächsten vollen Installer.

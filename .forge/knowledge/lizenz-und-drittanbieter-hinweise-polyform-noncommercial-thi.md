---
title: "Lizenz und Drittanbieter-Hinweise (FSL-1.1-ALv2, CONTRIBUTING, THIRD_PARTY_NOTICES, pnpm notices)"
summary: "Warum FORGE unter FSL-1.1-ALv2 steht, wie Lizenz, NOTICE, Beitragsregeln und die Liste gebündelter npm-Pakete aufgebaut sind, wann man sie neu erzeugt und wie sie in den Installer kommen."
tags: ["release","installer","tauri","konvention"]
updated: "2026-10-17T20:52:15.600Z"
---

## Lizenz (Entscheidung 2026-10-17)
- FORGE steht unter **FSL-1.1-ALv2** (Functional Source License 1.1, Apache 2.0 als spätere Lizenz). Erst war es PolyForm Noncommercial; gewechselt, weil die auch berufliche Nutzung verbietet. Ziel des Besitzers: jeder darf FORGE nutzen, auch in Firmen, aber niemand darf es ohne Erlaubnis als konkurrierendes Produkt oder Dienst anbieten. Jede Version wird zwei Jahre nach Veröffentlichung zusätzlich Apache 2.0.
- `LICENSE.md` ist der offizielle Text (github.com/getsentry/fsl.software, `FSL-1.1-ALv2.template.md`), nur `${year}` = 2026 und `${licensor name}` = Tjorven Hüther eingesetzt. Nicht von Hand ändern.
- `NOTICE`: Copyright-Zeile und Lizenzhinweis. Liegt mit `LICENSE.md` im Installer.
- Lizenzfelder: `"license": "FSL-1.1-ALv2"` in allen package.json (auch `services/stats`), `license = "FSL-1.1-ALv2"` in `apps/desktop/src-tauri/Cargo.toml`. Neue Pakete bekommen dasselbe Feld.
- `CONTRIBUTING.md` regelt die Rechte an Beiträgen: Beitragende erlauben, ihren Code auch unter anderen Lizenzen und kommerziell zu nutzen. Ohne diese Zusage ließe sich fremder Code nicht weiterlizenzieren.

## Drittanbieter
- `THIRD_PARTY_LICENSES.md` (von Hand): mitgelieferte Programme in `runtime/` (Node, Git, gh, Python) und PostgreSQL.
- `THIRD_PARTY_NOTICES.md` (erzeugt, eingecheckt): `pnpm notices` = `node scripts/third-party-notices.mjs`. Nach jeder Änderung an Produktions-Abhängigkeiten neu erzeugen; `--check` meldet eine veraltete Datei.
  - Sidecar: genau die Pakete, die esbuild in `sidecar.mjs` packt (Metafile mit demselben Einstiegspunkt wie `packages/sidecar/build.mjs`). Stand 2026-10: nur `@anthropic-ai/claude-agent-sdk` und `zod`.
  - Oberfläche: `pnpm --filter "@forge/desktop..." licenses list --prod` (mit `...`, sonst fehlen die Abhängigkeiten von `@forge/protocol`, etwa zod). Obermenge des Vite-Bundles, rechtlich unschädlich.
  - Die Datei enthält keine absoluten Pfade (Datenschutz), nur Name, Version, Lizenz, Copyright-Zeilen und Lizenztexte.

## In den Installer
- `tauri.conf.json` > `bundle.resources` ist eine Zuordnung (Objekt), nicht ein Array: `"runtime/": "runtime/"` plus `"../../../LICENSE.md": "LICENSE.md"` usw. Grund: in der Array-Form landen Dateien außerhalb von `src-tauri` unter `_up_/_up_/_up_/`. Ein Glob wie `runtime/**/*` würde in der Objekt-Form die Ordnerstruktur flachklopfen, deshalb steht `runtime/` als Ordner (WalkDir behält die Struktur).
- Die kleinen Update-Zips aus `release.yml` enthalten nur exe und Sidecar; die Lizenzdateien aktualisieren sich erst mit dem nächsten vollen Installer.

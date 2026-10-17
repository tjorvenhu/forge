---
title: "Lizenz AGPL-3.0, Herausgeber Vanturis, Drittanbieter-Hinweise (NOTICE, CONTRIBUTING)"
summary: "Warum FORGE unter AGPL-3.0-only mit Zusatzerlaubnis steht und Vanturis herausgibt, wo Herausgeber und Lizenz eingetragen sind, und wie Lizenzdateien und Drittanbieter-Hinweise in den Installer kommen."
tags: ["release","installer","tauri","konvention","stolperfalle"]
updated: "2026-10-17T21:14:41.652Z"
---

## Herausgeber (Entscheidung 2026-10-17)
- FORGE ist ein Open-Source-Produkt der **Vanturis UG (haftungsbeschränkt)**. Repo: `github.com/vanturis/forge` (übertragen von `tjorvenhu/forge`; GitHub leitet alte Adressen inkl. API weiter, alte Installationen finden Updates also weiter). Konstanten: `PUBLISHER` in `packages/protocol/src/support.ts`, `UPDATE_REPO` in app-update.ts.
- `tauri.conf.json`: `publisher` ist bewusst nur **"Vanturis"**: Der NSIS-Installer merkt sich den Installationsordner unter `HKCU\Software\<publisher>\FORGE`; vorher galt der aus der App-ID abgeleitete Standard „vanturis“, und die Registry unterscheidet keine Groß-/Kleinschreibung. Der volle Firmenname steht in `copyright`. Nicht auf den Langnamen ändern, sonst findet ein neuer Installer den alten Ordner nicht.
- Sichtbar in der App: Einstellungen > Über FORGE > Herausgeber (Impressum, Datenschutz, Quellcode), Unterstützen-Dialog, Statistikseite (Fußzeile).

## Lizenz
- **AGPL-3.0-only**. Vorher kurz PolyForm Noncommercial, dann FSL-1.1; gewechselt, weil Vanturis FORGE ehrlich „Open Source“ nennen will. Vanturis kann daneben kommerzielle Lizenzen vergeben.
- `LICENSE.md` ist der unveränderte Text von gnu.org/licenses/agpl-3.0.txt. Nicht von Hand ändern.
- `NOTICE`: Copyright, AGPL-Hinweis und eine **Zusatzerlaubnis nach Abschnitt 7** für die Kombination mit der Claude-Agent-SDK und Claude Code. Grund: `@anthropic-ai/claude-agent-sdk` ist proprietär („SEE LICENSE IN README.md“) und wird in `sidecar.mjs` gebündelt; ohne die Ausnahme wäre die Weitergabe unter reiner AGPL nicht sauber. Neue proprietäre Abhängigkeiten im Bundle brauchen dieselbe Prüfung.
- Lizenzfelder: `"license": "AGPL-3.0-only"` plus `author`/`homepage`/`repository` (Vanturis) in allen package.json, `license`/`authors`/`homepage`/`repository` in `apps/desktop/src-tauri/Cargo.toml`.
- `CONTRIBUTING.md`: Beitragende erlauben Vanturis, ihren Code auch unter anderen Lizenzen und kommerziell zu nutzen (nötig für kommerzielle Lizenzen neben der AGPL).

## Unterstützen
- Freiwillige Zahlung an die UG, nicht gemeinnützig: In der App heißt es „freiwilliger Beitrag“ mit dem Hinweis „keine Spendenquittung“, nicht „Spende“. Zahlungsanbieter soll Stripe werden (Payment Link mit frei wählbarem Betrag); bis der Link da ist, steht in `SUPPORT_LINKS.donate` noch der PayPal-Link. Texte sind anbieterneutral, beim Wechsel nur die URL tauschen (App, `services/stats/src/app/layout.tsx`, README, Telefon-Test).

## Drittanbieter
- `THIRD_PARTY_LICENSES.md` (von Hand): mitgelieferte Programme in `runtime/` (Node, Git, gh, Python) und PostgreSQL.
- `THIRD_PARTY_NOTICES.md` (erzeugt, eingecheckt): `pnpm notices` = `node scripts/third-party-notices.mjs`. Nach jeder Änderung an Produktions-Abhängigkeiten neu erzeugen; `--check` meldet eine veraltete Datei. Sidecar: genau die Pakete im esbuild-Bundle; Oberfläche: `pnpm --filter "@forge/desktop..." licenses list --prod`. Keine absoluten Pfade in der Datei.

## In den Installer
- `tauri.conf.json` > `bundle.resources` ist eine Zuordnung (Objekt): `"runtime/": "runtime/"` plus `"../../../LICENSE.md": "LICENSE.md"` usw. In der Array-Form landen Dateien außerhalb von `src-tauri` unter `_up_/…`; ein Glob wie `runtime/**/*` würde in der Objekt-Form die Ordnerstruktur flachklopfen.
- Die kleinen Update-Zips enthalten nur exe und Sidecar; Lizenzdateien aktualisieren sich erst mit dem nächsten vollen Installer.

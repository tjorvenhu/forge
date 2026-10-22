---
title: "Entwicklungsversion (Branch dev): Version 0.1.N-dev, Kanalwechsel, Dev nach Main (DevChannelService, versionChannel)"
summary: "Dev-Releases mit -dev-Version, jeder Kanal nimmt nur eigene Builds, Kanalwechsel installiert den Build des anderen Kanals (auch niedrigere Nummer), Rechteprüfung, Dev nach Main, Stolperfallen im Release-Workflow."
tags: ["release","update","github-actions","einstellungen","stolperfalle"]
updated: "2026-10-22T09:10:28.338Z"
---

# Entwicklungsversion (Branch dev)

Gebaut 2026-10-20 (Wunsch des Besitzers: auf dev pushen, Apps auf dev aktualisieren sich daraus, später nach main übernehmen; dev schnell und ohne Zertifikat; nur Repo-Mitglieder dürfen umschalten; Dev muss in der App klar sichtbar sein). Versionsschema und Kanalwechsel neu seit 2026-10-22.

## Versionsschema (seit 2026-10-22, Entscheidung des Besitzers)
- main: `0.1.<run>`, Tag `v0.1.<run>`. dev: `0.1.<run>-dev`, Tag `v0.1.<run>-dev`, Pre-release. Run-Nummern teilen sich beide Branches, Versionen kollidieren nie.
- **Warum:** Vorher hatten beide Kanäle dieselbe Form und der Dev-Kanal nahm einfach die höchste Nummer aus beiden. Ein nächtlicher main-Build (0.1.131), der kurz nach einem Dev-Build (0.1.130) fertig wurde, hat Dev-Nutzer auf den älteren main-Stand gebracht: Funktionen aus dev fehlten plötzlich.
- `versionChannel()` und `DEV_VERSION_SUFFIX` in `packages/protocol/src/models.ts`, `releaseChannel()` / `channelReleases()` in `packages/sidecar/src/update/app-update.ts`. Dev-Builds bis 0.1.130 (plain Version, Pre-release) gehören zu keinem Kanal und werden ignoriert; ein installiertes 0.1.127–0.1.130 zählt als stable.
- Windows-Patch: `update.json` hat `version` (nur Ziffern/Punkte, weil der Apply-Schritt bis 0.1.131 nichts anderes nimmt) und `fullVersion` mit Suffix; neues `read_version` in `apps/desktop/src-tauri/src/update.rs` liest `fullVersion` zuerst.
- Pre-release-Flag bleibt für Dev-Builds: FORGE Setup (`releases.rs`), Download-Zähler, `scripts/install.sh` und Download-Seite überspringen Pre-releases.

## Kanäle in der App (AppUpdateService.check)
- Jeder Kanal sieht nur seine eigenen Builds. Ausnahme Windows: der Dev-Kanal nimmt volle Installer auch von main (`pickRelease(..., installers)`), main nie einen Dev-Installer (ohne Authenticode).
- **Kanalwechsel:** passt `versionChannel(currentVersion)` nicht zum Kanal, wird der neueste Build des gewählten Kanals angeboten, auch mit niedrigerer Nummer (`latest.channelSwitch`, Range nur dieser Build, `switchRange`). Dev nach Stabil: Dialog „Zurück zur stabilen Version“ mit Hinweis statt Notizen, kein Claude-Changelog.
- Kein Wechsel, wenn dev gewählt ist, aber der Zugriff gerade nicht bestätigt werden konnte (`chosenChannel` aus den Einstellungen ≠ effektiver Kanal), sonst würde ein GitHub-Aussetzer zurück auf main führen.

## Rechte (Entscheidung des Besitzers 2026-10-20: „Option 1“, wie Firefox Nightly)
- Dev-Code und Dev-Releases sind öffentlich. Lesen darf jeder, handeln nur Mitglieder.
- Pushen auf dev und „Dev nach Main übernehmen“ prüft GitHub selbst (gh-Token des Nutzers). Die Prüfung in FORGE ist nur Bedienkomfort.
- Rulesets „main schützen“ und „dev schützen“: kein Force-Push, kein Löschen. Würde main später PRs verlangen, müsste `promote()` auf PR anlegen + mergen umgestellt werden.
- **Stolperfalle:** Commits, die `.github/workflows/*` ändern, lehnt GitHub ohne Token-Scope `workflow` ab. Einmal `gh auth refresh -h github.com -s workflow`; das Token des Besitzers hat ihn seit 2026-10-21.

## Release-Seite (.github/workflows/release.yml)
- Push auf `dev` startet den Workflow (paths-ignore wie der Nacht-Check, u. a. `**.md`, `.forge/**`). **Stolperfalle:** Das Anlegen von dev als Kopie von main löst nichts aus; dann `gh workflow run release.yml -R vanturis/forge --ref dev`. Ein Dev-Lauf nutzt die `release.yml` des Branches dev.
- Main baut nur nachts oder per `gh workflow run release.yml -R vanturis/forge --ref main`. Main-Läufe machen Lint und Typecheck, Dev-Läufe nicht: Lint-Fehler auf dev fallen erst beim main-Release auf, vor dem Übernehmen `pnpm lint` laufen lassen.
- Kanal aus `github.ref_name` (Job `changes`, Output `channel`); Plan-Schritt gibt `version` (mit -dev) und `core` (ohne) aus.
- Dev schneller: kein Lint/Typecheck, keine Authenticode-Signatur, keine Alt-Signaturen, kein Linux-Job. macOS-Job läuft auch für dev (Besitzer nutzt die Entwicklungsversion auf dem Mac). Ed25519-Update-Signatur bleibt Pflicht.
- Voller Installer im Dev-Lauf nur, wenn es für den Laufzeit-Schlüssel in keinem Release (auch main) einen gibt.
- Release-Notes seit dem letzten Release desselben Kanals (per API: dev = Tags `^v[0-9].*-dev$`).
- Aufräumen im Dev-Lauf: die 3 neuesten `-dev`-Releases plus das neueste mit setup.exe bleiben, Rest mit `--cleanup-tag` gelöscht.
- concurrency-Gruppe je Branch (`release-<ref>`).

## App-Seite
- Einstellung `updateChannel` ("stable" | "dev") in `LOCAL_SETTINGS` von sync.ts.
- `packages/sidecar/src/update/dev-channel.ts` (`DevChannelService`): Zugriff = `gh api repos/vanturis/forge --jq .permissions.push` == true; nur erlaubter Zustand 10 Min. gecacht; `forget()` bei GitHub-Login/-Logout.
- `settings.update` mit `updateChannel: "dev"` ruft `requireAccess()`; Kanalwechsel startet sofort eine Update-Prüfung, die den Wechsel anbietet.
- Übernehmen (`app.promoteDev`): Fast-Forward über `PATCH git/refs/heads/main` (force=false), sonst Merge-Commit über `POST /merges` (409 = Konflikt). Optional danach `workflow_dispatch` auf main.

## UI (Wünsche des Besitzers)
- Schalter heißt **„Entwicklungsversion“** (EN „Development build“); intern `updateChannel`/`devChannel`. Gilt auch für Palette, Suche, Telefon.
- Einstellungen > Über FORGE > Updates (`DevChannelSettings.tsx`): Switch, nur sichtbar mit bestätigtem Push-Recht, kein „Erneut prüfen“-Knopf. Ausnahme: Kanal schon dev und Zugriff weg, dann bleibt die Zeile zum Ausschalten.
- „Dev nach Main übernehmen“ nur mit Zugriff und eingeschalteter Entwicklungsversion; ebenso Palette und Telefon `dev_promote`.
- Kennzeichnung `DevChannelBadge.tsx`: Karte unten links unter der Claude-Code-Karte, `FlaskConical`, Tokens `--color-dev*` (dunkles Blutrot). Klick: Einstellungen, Rechtsklick: ausschalten.
- Telefon: `forge_settings update_channel`, `forge_system dev_status` / `dev_promote`; Update-Text nennt Dev-Build bzw. Wechsel zurück (`stableSwitch`).

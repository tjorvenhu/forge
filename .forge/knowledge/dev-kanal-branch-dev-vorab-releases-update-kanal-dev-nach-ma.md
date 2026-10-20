---
title: "Dev-Branch: Branch dev, Vorab-Releases, Update-Kanal, Dev nach Main übernehmen (DevChannelService, updateChannel)"
summary: "Wie der Dev-Branch eigene Releases bekommt, wie die App per updateChannel darauf umschaltet (nur für Konten mit Push-Recht), wie dev nach main übernommen wird, welche Rechte wo geprüft werden und was man beim Release-Workflow beachten muss."
tags: ["release","update","github-actions","einstellungen","stolperfalle"]
updated: "2026-10-20T18:03:40.493Z"
---

Gebaut 2026-10-20 (Wunsch des Besitzers: auf dev pushen, Apps auf dev aktualisieren sich daraus, später nach main übernehmen; dev schnell und ohne Zertifikat; nur Repo-Mitglieder dürfen umschalten; Dev muss in der App klar sichtbar sein). Branch `dev` auf GitHub seit 2026-10-20, lokal als Tracking-Branch `dev`.

## Rechte (Entscheidung des Besitzers 2026-10-20: „Option 1“, wie Firefox Nightly)
- Dev-Code und Dev-Releases sind öffentlich (ein Branch kann in einem öffentlichen Repo nicht privat sein). Gewollt: lesen darf jeder, handeln nur Mitglieder.
- Pushen auf dev und „Dev nach Main übernehmen“ prüft GitHub selbst: FORGE nutzt das gh-Token des Nutzers, ohne Schreibrecht lehnt GitHub ab. Die Prüfung in FORGE ist nur Bedienkomfort.
- Rulesets: „main schützen“ (Default-Branch) und „dev schützen“ (`refs/heads/dev`): je kein Force-Push, kein Löschen. Fast-Forward und Merge-Commit des Übernehmens sind damit erlaubt. Würde main später PRs verlangen, müsste `promote()` auf PR anlegen + mergen umgestellt werden.
- Abgelehnt: eigene Postgres-Testerliste im Statistik-Dienst (zweite Liste neben GitHub, keine zusätzliche Sicherheit). Nur sinnvoll, falls Tester ohne Schreibrecht Dev-Builds bekommen sollen. Alternative, falls Builds nicht öffentlich sein sollen: Dev-Releases in ein privates Repo hochladen (braucht PAT als Secret; GitHubReleases nimmt bei privaten Repos schon das gh-Token).

## Release-Seite (.github/workflows/release.yml)
- Push auf `dev` startet den Workflow (paths-ignore wie der Nacht-Check, u. a. `**.md`: reine Wissens-Commits bauen nichts). **Stolperfalle:** Das Anlegen von dev als Kopie von main löst nichts aus (keine geänderten Pfade); dann von Hand `gh workflow run release.yml -R vanturis/forge --ref dev`.
- Main baut nur nachts oder per `gh workflow run release.yml -R vanturis/forge --ref main`.
- Kanal kommt aus `github.ref_name` (Job `changes`, Output `channel`).
- Dev-Release = **Pre-release** mit normalem Tag `v0.1.<run>` und Titel „FORGE <v> (dev)“, `--latest=false`. Run-Nummern teilen sich beide Branches, darum kollidieren Versionen nie.
- Schneller: kein Lint/Typecheck, keine Authenticode-Signatur (Azure), keine Alt-Signaturen `<asset>.sig`, keine macOS/Linux-Jobs. Die Ed25519-Update-Signatur (`FORGE_<v>.sig`) bleibt Pflicht.
- Voller Installer im Dev-Lauf nur, wenn es für den Laufzeit-Schlüssel in irgendeinem Release (auch main) keinen gibt. Main zählt nur Nicht-Pre-releases (Dev-Installer ohne Authenticode).
- Release-Notes seit dem letzten Release desselben Kanals (per API, nicht `git describe`, das fände nach einem Merge Dev-Tags auf main). Nacht-Check (`changes`) vergleicht nur mit dem letzten Nicht-Pre-release.
- Aufräumen im Dev-Lauf: die 3 neuesten Dev-Releases plus das neueste mit setup.exe bleiben, der Rest wird mit `--cleanup-tag` gelöscht.
- concurrency-Gruppe je Branch (`release-<ref>`), sonst bricht ein Dev-Push den Main-Lauf ab.
- Pre-releases ignorieren: App auf Stabil (`published()`), FORGE Setup (`releases.rs`), Download-Zähler (`services/stats/src/lib/downloads.ts`).

## App-Seite
- Einstellung `updateChannel` ("stable" | "dev"), in `LOCAL_SETTINGS` von sync.ts (hängt am GitHub-Login dieses Rechners).
- `packages/sidecar/src/update/dev-channel.ts` (`DevChannelService`): Zugriff = `gh api repos/vanturis/forge --jq .permissions.push` == true. Nur ein erlaubter Zustand wird 10 Min. gecacht.
- `settings.update` mit `updateChannel: "dev"` ruft `requireAccess()` (POLICY_DENIED sonst); Kanalwechsel startet sofort eine Update-Prüfung.
- `AppUpdateService` fragt `channel()` = `DevChannelService.effective()`: Dev nur solange erlaubt, sonst stable. `channelReleases()` macht Dev-Pre-releases (Tag `v…`) für die Auswahl zu normalen Releases. `AppUpdateState.channel` zeigt den benutzten Kanal.
- Zurück auf Stabil: kein Downgrade, das nächste Update kommt, sobald main eine höhere Version hat.
- Übernehmen (`app.promoteDev`): ist main nicht voraus, Fast-Forward über `PATCH git/refs/heads/main` (force=false), sonst Merge-Commit über `POST /merges` (409 = Konflikt, lokal lösen). Optional danach `workflow_dispatch` von release.yml auf main.

## UI (Wünsche des Besitzers)
- In der UI heißt es **„Dev-Branch“**, nicht „Dev-Kanal“ (EN „Dev branch“). Intern bleiben `updateChannel`/`devChannel`.
- Einstellungen > Über FORGE > Updates (`DevChannelSettings.tsx`): ein **Schalter** (Switch) „Dev-Branch“, keine Radio-Auswahl. „Dev nach Main übernehmen“ erscheint nur, solange der Dev-Branch an ist; ebenso der Palette-Eintrag und Telefon `dev_promote` (sonst `devPromoteOff`).
- Badge „Dev-Branch“ unter dem Logo (`DevChannelBadge.tsx`, Rechtsklick: ausschalten). Eigene Tokens `--color-dev`, `--color-dev-border`, `--color-dev-fg` in styles.css: dunkles Blutrot, bewusst nicht das helle `danger`-Rot des Support-Herzens. Keine rote Oberkante an der Seitenleiste.
- Palette: „Dev-Branch für Updates einschalten/ausschalten“, „Dev nach Main übernehmen“. Telefon: `forge_settings update_channel`, `forge_system dev_status` / `dev_promote` (Tastatur-Code).

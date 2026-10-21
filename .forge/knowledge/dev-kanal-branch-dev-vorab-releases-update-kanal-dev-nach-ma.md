---
title: "Entwicklungsversion (Branch dev): Vorab-Releases, Update-Kanal, Dev nach Main (DevChannelService, updateChannel)"
summary: "Wie der Branch dev eigene Releases bekommt (Windows und macOS), wie die App per updateChannel darauf umschaltet (in der UI „Entwicklungsversion“, nur für Konten mit Push-Recht), wie dev nach main übernommen wird, welche Rechte wo geprüft werden und was man beim Release-Workflow beachten muss."
tags: ["release","update","github-actions","einstellungen","stolperfalle"]
updated: "2026-10-21T07:12:31.173Z"
---

Gebaut 2026-10-20 (Wunsch des Besitzers: auf dev pushen, Apps auf dev aktualisieren sich daraus, später nach main übernehmen; dev schnell und ohne Zertifikat; nur Repo-Mitglieder dürfen umschalten; Dev muss in der App klar sichtbar sein). Branch `dev` auf GitHub seit 2026-10-20, lokal als Tracking-Branch `dev`.

## Rechte (Entscheidung des Besitzers 2026-10-20: „Option 1“, wie Firefox Nightly)
- Dev-Code und Dev-Releases sind öffentlich (ein Branch kann in einem öffentlichen Repo nicht privat sein). Gewollt: lesen darf jeder, handeln nur Mitglieder.
- Pushen auf dev und „Dev nach Main übernehmen“ prüft GitHub selbst: FORGE nutzt das gh-Token des Nutzers, ohne Schreibrecht lehnt GitHub ab. Die Prüfung in FORGE ist nur Bedienkomfort.
- Rulesets: „main schützen“ (Default-Branch) und „dev schützen“ (`refs/heads/dev`): je kein Force-Push, kein Löschen. Fast-Forward und Merge-Commit des Übernehmens sind damit erlaubt. Würde main später PRs verlangen, müsste `promote()` auf PR anlegen + mergen umgestellt werden.
- **Stolperfalle:** Commits, die `.github/workflows/*` ändern, lehnt GitHub ohne Token-Scope `workflow` ab („refusing to allow an OAuth App to create or update workflow“). Der Nutzer muss einmal selbst `gh auth refresh -h github.com -s workflow` ausführen (Browser-Bestätigung); seit 2026-10-21 hat das Token des Besitzers den Scope.
- Abgelehnt: eigene Postgres-Testerliste im Statistik-Dienst (zweite Liste neben GitHub, keine zusätzliche Sicherheit). Nur sinnvoll, falls Tester ohne Schreibrecht Dev-Builds bekommen sollen. Alternative, falls Builds nicht öffentlich sein sollen: Dev-Releases in ein privates Repo hochladen (braucht PAT als Secret; GitHubReleases nimmt bei privaten Repos schon das gh-Token).

## Release-Seite (.github/workflows/release.yml)
- Push auf `dev` startet den Workflow (paths-ignore wie der Nacht-Check, u. a. `**.md`: reine Wissens-Commits bauen nichts). **Stolperfalle:** Das Anlegen von dev als Kopie von main löst nichts aus (keine geänderten Pfade); dann von Hand `gh workflow run release.yml -R vanturis/forge --ref dev`. Ein Dev-Lauf nutzt die `release.yml` des Branches dev: Workflow-Änderungen erst nach main, dann dev vorspulen (`git push origin origin/main:refs/heads/dev`, wenn dev Vorfahre von main ist).
- Main baut nur nachts oder per `gh workflow run release.yml -R vanturis/forge --ref main`.
- Kanal kommt aus `github.ref_name` (Job `changes`, Output `channel`).
- Dev-Release = **Pre-release** mit normalem Tag `v0.1.<run>` und Titel „FORGE <v> (dev)“, `--latest=false`. Run-Nummern teilen sich beide Branches, darum kollidieren Versionen nie.
- Schneller: kein Lint/Typecheck, keine Authenticode-Signatur (Azure), keine Alt-Signaturen `<asset>.sig`, **kein Linux-Job**. Der macOS-Job läuft seit 2026-10-21 auch für dev (Wunsch des Besitzers, er nutzt die Entwicklungsversion auf dem Mac). Die Ed25519-Update-Signatur (`FORGE_<v>.sig`) bleibt Pflicht.
- Voller Installer im Dev-Lauf nur, wenn es für den Laufzeit-Schlüssel in irgendeinem Release (auch main) keinen gibt. Main zählt nur Nicht-Pre-releases (Dev-Installer ohne Authenticode).
- Release-Notes seit dem letzten Release desselben Kanals (per API, nicht `git describe`, das fände nach einem Merge Dev-Tags auf main). Nacht-Check (`changes`) vergleicht nur mit dem letzten Nicht-Pre-release.
- Aufräumen im Dev-Lauf: die 3 neuesten Dev-Releases plus das neueste mit setup.exe bleiben, der Rest wird mit `--cleanup-tag` gelöscht.
- concurrency-Gruppe je Branch (`release-<ref>`), sonst bricht ein Dev-Push den Main-Lauf ab.
- Pre-releases ignorieren: App auf Stabil (`published()`), FORGE Setup (`releases.rs`), Download-Zähler (`services/stats/src/lib/downloads.ts`), seit 2026-10-21 auch `scripts/install.sh` (awk merkt sich `"prerelease"` je Release; mit `FORGE_VERSION` wird auch ein Pre-release genommen) und die Download-Seite (`services/stats/src/lib/builds.ts`). Wer neue Mac/Linux-Dateien sucht, muss Pre-releases überspringen, sonst bekommen Neuinstallationen die Entwicklungsversion.

## App-Seite
- Einstellung `updateChannel` ("stable" | "dev"), in `LOCAL_SETTINGS` von sync.ts (hängt am GitHub-Login dieses Rechners).
- `packages/sidecar/src/update/dev-channel.ts` (`DevChannelService`): Zugriff = `gh api repos/vanturis/forge --jq .permissions.push` == true. Nur ein erlaubter Zustand wird 10 Min. gecacht.
- `settings.update` mit `updateChannel: "dev"` ruft `requireAccess()` (POLICY_DENIED sonst); Kanalwechsel startet sofort eine Update-Prüfung.
- `AppUpdateService` fragt `channel()` = `DevChannelService.effective()`: Dev nur solange erlaubt, sonst stable. `channelReleases()` macht Dev-Pre-releases (Tag `v…`) für die Auswahl zu normalen Releases. `AppUpdateState.channel` zeigt den benutzten Kanal.
- Zurück auf Stabil: kein Downgrade, das nächste Update kommt, sobald main eine höhere Version hat.
- Übernehmen (`app.promoteDev`): ist main nicht voraus, Fast-Forward über `PATCH git/refs/heads/main` (force=false), sonst Merge-Commit über `POST /merges` (409 = Konflikt, lokal lösen). Optional danach `workflow_dispatch` von release.yml auf main.

## UI (Wünsche des Besitzers)
- In der UI heißt der Schalter **„Entwicklungsversion“** (EN „Development build“); vorher „Dev-Kanal“, dann „Dev-Branch“, beides vom Besitzer verworfen. Intern bleiben `updateChannel`/`devChannel`. Gilt auch für Palette, Suche, Telefon-Texte und Fehlermeldungen.
- Einstellungen > Über FORGE > Updates (`DevChannelSettings.tsx`): ein **Schalter** (Switch), keine Radio-Auswahl. „Dev nach Main übernehmen“ erscheint nur, solange die Entwicklungsversion an ist; ebenso der Palette-Eintrag und Telefon `dev_promote` (sonst `devPromoteOff`).
- Kennzeichnung (`DevChannelBadge.tsx`): Karte **unten links unter der Claude-Code-Karte**, im Stil der Sidebar-Karten (rounded-xl, text-body, kein Uppercase/Mono), Icon Reagenzglas `FlaskConical`, rechts klein „dev“. Klick: Einstellungen, Rechtsklick: ausschalten. Farben über eigene Tokens `--color-dev`, `--color-dev-border`, `--color-dev-fg` in styles.css (dunkles Blutrot, gedämpft per Opazität), bewusst nicht das helle `danger`-Rot des Support-Herzens. Nicht mehr oben unter dem Logo, keine rote Oberkante an der Seitenleiste.
- Telefon: `forge_settings update_channel`, `forge_system dev_status` / `dev_promote` (Tastatur-Code).

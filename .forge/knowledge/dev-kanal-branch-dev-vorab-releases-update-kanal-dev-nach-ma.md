---
title: "Dev-Kanal: Branch dev, Vorab-Releases, Update-Kanal, Dev nach Main übernehmen (DevChannelService, updateChannel)"
summary: "Wie der Dev-Branch eigene Releases bekommt, wie die App per updateChannel darauf umschaltet (nur für Konten mit Push-Recht), wie dev nach main übernommen wird und was man beim Release-Workflow beachten muss."
tags: ["release","update","github-actions","einstellungen","stolperfalle"]
updated: "2026-10-20T16:49:26.041Z"
---

Gebaut 2026-10-20 (Wunsch des Besitzers: auf dev pushen, Apps auf dev aktualisieren sich daraus, später nach main übernehmen; dev schnell und ohne Zertifikat; nur Repo-Mitglieder dürfen umschalten; Dev muss in der App klar sichtbar sein).

## Release-Seite (.github/workflows/release.yml)
- Push auf `dev` startet den Workflow (paths-ignore wie der Nacht-Check). Kanal kommt aus `github.ref_name` (Job `changes`, Output `channel`).
- Dev-Release = **Pre-release** mit normalem Tag `v0.1.<run>` und Titel „FORGE <v> (dev)“, `--latest=false`. Run-Nummern teilen sich beide Branches, darum kollidieren Versionen nie und dev ist meist neuer als main.
- Schneller: kein Lint/Typecheck, keine Authenticode-Signatur (Azure), keine Alt-Signaturen `<asset>.sig`, keine macOS/Linux-Jobs. Die Ed25519-Update-Signatur (`FORGE_<v>.sig`) bleibt Pflicht, sonst nimmt die App nichts.
- Voller Installer im Dev-Lauf nur, wenn es für den Laufzeit-Schlüssel in **irgendeinem** Release (auch main) keinen gibt. Main zählt dabei nur Nicht-Pre-releases (Dev-Installer haben keine Authenticode-Signatur).
- Release-Notes: seit dem letzten Release desselben Kanals (per API, nicht `git describe`, das fände nach einem Merge Dev-Tags auf main).
- Nacht-Check (`changes`) vergleicht nur mit dem letzten Nicht-Pre-release.
- Aufräumen im Dev-Lauf: behalten werden die 3 neuesten Dev-Releases plus das neueste mit setup.exe, der Rest wird mit `--cleanup-tag` gelöscht.
- concurrency-Gruppe je Branch (`release-<ref>`), sonst bricht ein Dev-Push den Main-Lauf ab.
- Pre-releases ignorieren: App auf Stabil (`published()`), FORGE Setup (`releases.rs`), Download-Zähler (`services/stats/src/lib/downloads.ts`).

## App-Seite
- Einstellung `updateChannel` ("stable" | "dev"), in `LOCAL_SETTINGS` von sync.ts (hängt am GitHub-Login dieses Rechners).
- `packages/sidecar/src/update/dev-channel.ts` (`DevChannelService`): Zugriff = `gh api repos/vanturis/forge --jq .permissions.push` == true (bei öffentlichem Repo hat jeder `pull`, nur Mitglieder `push`). Nur ein erlaubter Zustand wird 10 Min. gecacht.
- `settings.update` mit `updateChannel: "dev"` ruft `requireAccess()` (POLICY_DENIED sonst); Kanalwechsel startet sofort eine Update-Prüfung.
- `AppUpdateService` fragt `channel()` = `DevChannelService.effective()`: Dev nur solange erlaubt, sonst stable. `channelReleases()` macht Dev-Pre-releases (Tag `v…`) für die Auswahl zu normalen Releases. `AppUpdateState.channel` zeigt den benutzten Kanal.
- Zurück auf Stabil: kein Downgrade, das nächste Update kommt, sobald main eine höhere Version hat.
- Übernehmen (`app.promoteDev`): ist main nicht voraus, Fast-Forward über `PATCH git/refs/heads/main` (force=false), sonst Merge-Commit über `POST /merges` (409 = Konflikt, lokal lösen). Optional danach `workflow_dispatch` von release.yml auf main.
- UI: Einstellungen > Über FORGE > Updates (`DevChannelSettings.tsx`), rote Leiste „Dev-Kanal“ unter dem Logo plus rote Oberkante der Seitenleiste (`DevChannelBadge.tsx`, Rechtsklick: zurück auf Stabil). Palette: „Update-Kanal … einschalten“, „Dev nach Main übernehmen“. Telefon: `forge_settings update_channel`, `forge_system dev_status` / `dev_promote` (Tastatur-Code).
- Die Dev-Releases sind öffentlich herunterladbar; die Prüfung beschränkt nur das Umschalten in der App.

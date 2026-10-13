---
title: "GitHub-Repositorys in Organisationen anlegen"
summary: "Wie FORGE neue GitHub-Repositorys im persönlichen Konto oder in einer Organisation anlegt (Anlegen, Import, Veröffentlichen, Telefon) und woher die Organisationsliste kommt."
tags: ["github","projekte","import","telefon","gh"]
updated: "2026-10-13T16:53:10.788Z"
---

Eingebaut 2026-10-13 auf Wunsch des Nutzers.

## Ablauf
- Ziel-Konto heißt überall `owner` (Schema `GitHubOwner` in `packages/protocol/src/models.ts`); ohne owner bzw. `null` das persönliche Konto.
- `GitHubService.createRepo(dir, name, private, owner)` ruft `gh repo create owner/name --source --remote origin --push` auf.
- `github.orgs` (RPC) = `gh api user/orgs?per_page=100`. Braucht den Scope read:org; den fragt `gh auth login` standardmäßig mit ab. Liefert nur Organisationen, in denen das Konto Mitglied ist. Ob das Konto dort Repositorys anlegen darf, entscheidet erst GitHub beim Anlegen (Fehlertext kommt durch).
- Neu anlegen: `projects.create` mit `github: { private, owner }`.
- Import: bewusst kein neuer Parameter an `projects.import` (Ergebnistyp bleibt `Project`); UI und Telefon rufen danach `github.publish` mit `owner`. Schlägt GitHub fehl (z. B. Ordner hat schon origin, CONFLICT), bleibt der Import bestehen und es gibt nur eine Fehlermeldung.
- Git-Bereich, Dialog "Auf GitHub veröffentlichen" (`components/git/Sync.tsx`): ebenfalls owner.

## UI
- `components/github/GitHubOwnerSelect.tsx`: Auswahl persönliches Konto oder Organisation, Skeleton beim Laden; `repoNameOf` spiegelt `toRepoName` aus dem Sidecar für die Vorschau "als owner/name".
- `NewProjectDialog.tsx`: `GitHubRepoChoice` für Anlegen und Import.
- Cache `keys.githubOrgs` wird bei Login (server-events) und Logout (GitHubPanel) mit geleert.

## Telefon
- Werkzeuge `project` (create/import) und `git` (publish) nehmen `owner` als gesprochenen Namen; `resolveOwner` in `phone-service.ts` gleicht ihn mit `github.orgs` ab (Login des Kontos selbst = persönlich). `git` mit `account` nennt die Organisationen.

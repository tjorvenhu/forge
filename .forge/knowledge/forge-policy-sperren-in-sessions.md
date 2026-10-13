---
title: "FORGE-Policy-Sperren in Sessions"
summary: "Welche FORGE-Policy-Regeln Claude-Sessions hier blockieren, welche standardmäßig aus sind und wie Standardänderungen bei Updates migriert werden."
tags: ["policy","git","stolperfalle"]
updated: "2026-10-13T11:43:37.737Z"
---

Regeln: `PolicyRuleId` in `packages/protocol/src/models.ts`, Prüfung in `packages/sidecar/src/policy/guard.ts`, Schalter unter Einstellungen (`PolicySettings.tsx`). Sie greifen per PreToolUse-Hook, auch im Autonomous-Profil. Die vollständige Liste steht in `docs/SECURITY.md`.

Standardmäßig aus (`DEFAULT_DISABLED_POLICY_RULES`): `git-push-protected` und `git-branch-delete`. Branch-Löschen ist aus, damit Claude die Branches fertiger Agenten löschen kann.

Einen Standard ändern: Regel in `DEFAULT_DISABLED_POLICY_RULES` aufnehmen und zusätzlich eine Migration in `MIGRATIONS` (`packages/sidecar/src/persistence/db.ts`) anhängen, die die Regel per `json_insert` einmalig in die gespeicherte Liste `disabledPolicyRules` schreibt. Ohne Migration behalten bestehende Installationen ihre alte Liste. Wer die Regel danach wieder einschaltet, behält das. Test-Muster: `packages/sidecar/test/db-settings.test.ts`. `docs/SECURITY.md` mitziehen.

Weiter aktiv: Schreiben außerhalb des Projektordners (`write-outside-project`). Hilfsskripte deshalb im Projekt anlegen und danach löschen, nicht in %TEMP%.

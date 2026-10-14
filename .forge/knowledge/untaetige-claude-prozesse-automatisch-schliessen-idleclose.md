---
title: "Untätige Claude-Prozesse automatisch schließen (IdleClose)"
summary: "Wie FORGE die CLI-Prozesse untätiger Sessions nach der eingestellten Zeit beendet, was als Nutzung zählt und wie der Wettlauf mit gleichzeitig gesendeten Nachrichten gelöst ist; wichtig bei neuen Zuständen, die einen Prozess offen halten müssen."
tags: ["sessions","sidecar","einstellungen","telefon","stolperfalle"]
updated: "2026-10-14T18:02:58.873Z"
---

Stand: 2026-10-14.

## Was passiert
- Einstellung `idleCloseMinutes` (protocol `Settings`, Standard 60, 0 = aus, Auswahl `IDLE_CLOSE_CHOICES` = 0/15/30/60/120/240). Wird automatisch per GitHub-Sync abgeglichen (nicht in `LOCAL_SETTINGS`).
- `packages/sidecar/src/sessions/idle-close.ts` (`IdleClose`): prüft jede Minute (`IDLE_CHECK_MS`) gegen die Wanduhr, nicht mit einem Timer pro Session (Standby). Gestartet in `SessionService.startBackgroundChecks()`, gestoppt in `shutdown()`. Für Tests: `svc.checkIdle()` mit injizierter Uhr.
- Geschlossen wird nur der Prozess: `lifecycle.close(id, IDLE_CLOSED_DETAIL)` setzt `live.endDetail`, `onEnd` schreibt dann `status: stopped` mit diesem Detail. Session, Verlauf, `claudeSessionId` und Agenten-Worktree bleiben; die nächste Nachricht macht Resume. Die Seitenleiste blendet Sessions ohne Prozess ohnehin aus „Geöffnet“ aus (außer der offenen).
- Chat: `chat-items.ts` zeigt `status`-Events mit genau `IDLE_CLOSED_DETAIL` als schlichte Info-Zeile (notice ohne Karte). Andere Prozess-Enden zeigen nichts.

## Was als Aktivität / Nutzung zählt
- Aktivität: jedes gespeicherte Event (`core.onRecord` ruft `idle.touch`), also auch Statuswechsel. Deltas laufen nicht über onRecord, dann ist aber `turnActive` gesetzt.
- `SessionService.inUse(id)` hält den Prozess offen: `turnActive`, offene Freigabe/Rückfrage (`pending`), Hintergrund-Aufgaben, Subagenten, Status BUSY oder stopping, Post-Turn-Automatik (`automation.isBusy`), laufender Start/Resume (`lifecycle.isAttaching`), Nachricht unterwegs (`turns.isSending`), geplantes Auto-Continue (`dueAt`), Telefongespräch über die Session (`useCallFocus` → `PhoneService.callFocus()`, also `active.focus`), arbeitende parallele Agenten (Kinder über `db.listSessionChildren`).
- Wird eine Session bei einer Prüfung als genutzt erkannt, beginnt die Wartezeit neu (`last = now`). Neue Zustände, die einen Prozess brauchen, gehören in `inUse`.

## Wettlauf mit einer gleichzeitigen Nachricht
- `IdleClose.check()` läuft komplett synchron. `TurnDispatch.send` zählt `sending` schon im ersten synchronen Schritt hoch (vor `await build`). Dadurch gilt: Entweder die Nachricht war schon unterwegs (Prozess bleibt), oder sie findet `live.closing` vor, wartet per `endLive` auf das Ende und setzt per Resume fort. Ohne den Zähler würde `deliver` nach dem `await` mit SESSION_BUSY abbrechen.
- Tests: describe „closing idle sessions“ in `packages/sidecar/test/session-service.test.ts` (Ausnahmen, beide Wettlauf-Fälle, Minutentakt).

## Telefon, Palette, UI
- Telefon: `forge_settings` mit `idle_close_minutes` (gerundet, 0..1440), Stand in `settingText`. Manuell schließen war schon `close_session` (`sessions.close`).
- Palette: `option-idle-close` öffnet Einstellungen → Claude Code; `idle-close-<min>` setzt direkt jede andere Wahl. Manuell: `session-close`.
- Einstellungen → Claude Code → Karte „Verhalten“, `idleCloseOptions()` in `components/settings/idle-close.ts` nimmt auch einen am Telefon gesetzten Wert außerhalb der Liste auf.

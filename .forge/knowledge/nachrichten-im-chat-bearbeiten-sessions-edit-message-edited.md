---
title: "Nachrichten im Chat bearbeiten (sessions.edit, message.edited)"
summary: "Wie das Bearbeiten gesendeter Prompts funktioniert (Abbruch, resumeSessionAt, ausgeblendeter Verlauf) und was Code beachten muss, der Chat-Events auswertet."
tags: ["chat","sessions","sdk","telefon","stolperfalle"]
updated: "2026-10-14T17:13:46.706Z"
---

Gesendete Prompts lassen sich im Chat bearbeiten (Stift an der Nachricht, Palette „Letzte Nachricht bearbeiten“, Telefon `sessions` mit action `edit`). RPC `sessions.edit { sessionId, seq, text }` → `SessionService.edit` → `SessionLifecycle.restartAt`.

Ablauf:
1. In Claudes Transkript (`runtime.sessionHistory`) wird der Prompt über seine `uuid` gesucht; der Eintrag davor ist der Fortsetzungspunkt. Nicht gefunden (nach /clear, Komprimierung) → Fehler.
2. Laufender Turn wird per `stop()` unterbrochen, dann endet der Prozess mit `endLive(live, 1_500)`. Kurze Frist, weil der CLI-Prozess unter Windows sonst ~7 s zum Schließen braucht; nach dem Interrupt ist das Transkript geschrieben.
3. Neuer Prozess mit `resume` + `resumeAt` (SDK-Option `resumeSessionAt`): Claude sieht nur den Verlauf bis vor dem Prompt, dann den neuen Text. Gleiche FORGE-Session, gleiche Claude-Session-ID, Datei-Checkpoints bleiben. War es der erste Prompt, startet die Unterhaltung neu (`claudeSessionId` null).
4. Dateien werden NICHT zurückgesetzt (dafür gibt es den eigenen Rückspul-Knopf).

Timeline: Die alten Events bleiben in der DB. FORGE schreibt `message.edited { fromSeq }` vor den neuen Prompt. `chat-items.ts` schneidet beim Falten alle Items ab dem Event mit `seq >= fromSeq` ab (`startSeq`, `truncate`) und markiert den nächsten Prompt mit `edited: true` („bearbeitet“).

**Wer Events selbst auswertet** (z. B. Liste der Prompts im Telefon, `prompts()` in `phone-service.ts`), muss `message.edited` beachten und Einträge ab `fromSeq` verwerfen, sonst zählen ersetzte Nachrichten mit.

Nachrichten aus der Claude-App (`source: "remote"`) sind im Chat deutlich markiert („Vom Handy“, Akzent-Blase, Handy-Abzeichen am Avatar) und lassen sich ebenfalls bearbeiten; automatische (`source: "auto"`) nicht.

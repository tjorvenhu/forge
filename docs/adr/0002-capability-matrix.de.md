<a href="0002-capability-matrix.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0002: Capability-Matrix (Stand Claude Code 2.1.296 / Agent SDK 0.3.296)

Datum: 2026-10-10 · Status: angenommen

Die Matrix wird zur Laufzeit aus `system/init` und `initializationResult()` neu berechnet und in
**Einstellungen → Diagnose** angezeigt. Diese Tabelle ist der Stand beim Spike.

| Fähigkeit | Status | Weg / Einschränkung |
|---|---|---|
| Session starten | supported | `query()` mit Streaming-Input |
| Prompt senden | supported | weitere `user`-Nachrichten in den Input-Stream |
| Token-Streaming | supported | `includePartialMessages` → `stream_event` `content_block_delta` |
| Tool-Events | supported | `assistant.tool_use` + `user.tool_result` |
| Freigabeanfragen | supported | `canUseTool`-Callback |
| Stop/Cancel | supported | `Query.interrupt()` (CLI meldet `interrupt_receipt_v1`) |
| Resume | supported | `options.resume = <sessionId>` |
| Sessions auflisten | supported | `listSessions({ dir })`, auch im Terminal gestartete |
| Verlauf lesen | supported | `getSessionMessages()` |
| Modell wechseln | supported | `setModel()`; Modellliste aus `initializationResult().models` |
| Permission-Modus | supported | `default`, `acceptEdits`, `plan`, `bypassPermissions` (letzterer nur mit `allowDangerouslySkipPermissions`) |
| Harte Sperrliste | supported | `PreToolUse`-Hook, greift auch im Bypass |
| Slash-Commands | partial | Liste aus `initializationResult().commands`; Skills/eigene Commands als Text sendbar, interaktive Built-ins (`/config`, `/login` …) nicht |
| Bilder/Dateien im Prompt | supported | Bilder, PDFs und Textdateien als Content-Blöcke (seit Phase 2) |
| Dateien zurücksetzen | supported | `enableFileCheckpointing` + `rewindFiles()` |
| Remote Control | supported | `enableRemoteControl()` der laufenden Query; nicht in den SDK-Typen (ADR 0008) |
| Token-Usage | supported | aus `result.usage` (verlässlich) |
| Kosten | partial | `total_cost_usd` ist bei Abo ein API-Äquivalent, wird nicht als Kosten angezeigt |
| Rate-Limit-Status | supported | `rate_limit_event` (5-Stunden-Fenster) |
| Eingebettetes Terminal (PTY) | supported | xterm.js + portable-pty in der Tauri-Hülle |
| GitHub PR | supported | mitgeliefertes `gh`, Anmeldung in der App |

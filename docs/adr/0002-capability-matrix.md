<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0002-capability-matrix.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0002: Capability matrix (as of Claude Code 2.1.296 / Agent SDK 0.3.296)

Date: 2026-10-10 · Status: accepted

The matrix is recomputed at runtime from `system/init` and `initializationResult()` and shown in
**Settings → Diagnostics**. This table reflects the state at the time of the spike.

| Capability | Status | Method / limitation |
|---|---|---|
| Start Session | supported | `query()` with streaming input |
| Send prompt | supported | further `user` messages into the input stream |
| Token streaming | supported | `includePartialMessages` → `stream_event` `content_block_delta` |
| Tool events | supported | `assistant.tool_use` + `user.tool_result` |
| Approval requests | supported | `canUseTool` callback |
| Stop/Cancel | supported | `Query.interrupt()` (CLI reports `interrupt_receipt_v1`) |
| Resume | supported | `options.resume = <sessionId>` |
| List Sessions | supported | `listSessions({ dir })`, including those started in the terminal |
| Read history | supported | `getSessionMessages()` |
| Switch model | supported | `setModel()`; model list from `initializationResult().models` |
| Permission mode | supported | `default`, `acceptEdits`, `plan`, `bypassPermissions` (the latter only with `allowDangerouslySkipPermissions`) |
| Hard blocklist | supported | `PreToolUse` hook, also applies in bypass |
| Slash commands | partial | list from `initializationResult().commands`; skills/custom commands can be sent as text, interactive built-ins (`/config`, `/login` …) cannot |
| Images/files in prompt | supported | images, PDFs and text files as content blocks (since phase 2) |
| Rewind files | supported | `enableFileCheckpointing` + `rewindFiles()` |
| Remote Control | supported | `enableRemoteControl()` of the running query; not in the SDK types (ADR 0008) |
| Token usage | supported | from `result.usage` (reliable) |
| Cost | partial | `total_cost_usd` is an API equivalent with a subscription, not shown as cost |
| Rate limit status | supported | `rate_limit_event` (5-hour window) |
| Embedded terminal (PTY) | supported | xterm.js + portable-pty in the Tauri shell |
| GitHub PR | supported | bundled `gh`, login in the app |

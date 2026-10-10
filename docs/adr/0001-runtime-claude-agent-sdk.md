# ADR 0001: Claude-Anbindung über den Agent SDK mit der installierten CLI

Datum: 2026-10-10 · Status: angenommen

## Kontext

FORGE soll die bestehende Claude-Code-Anmeldung (Max-Abo) nutzen. Kein Pflicht-API-Key, kein Auslesen
von OAuth-Tokens. Zur Wahl standen der TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`) und ein
eigener CLI-Adapter über `claude -p --output-format stream-json`.

## Geprüft (Spike, 2026-10-10)

- `claude --version` → 2.1.296; `claude auth status` → `authMethod: claude.ai`, `subscriptionType: max`.
- CLI-Spike: `claude -p … --output-format stream-json --verbose --include-partial-messages` liefert
  `system/init`, `stream_event` (Token-Deltas), `assistant`, `user` (tool_result), `rate_limit_event`, `result`.
- SDK-Spike (0.3.296): `query()` mit Streaming-Input, `canUseTool` wird für `Write` aufgerufen, Ablehnung kommt
  bei Claude an, `listSessions({dir})` findet die Session. `system/init.apiKeySource = "none"`,
  `initializationResult().account.subscriptionType = "Claude Max"`.
- Der vom SDK mitgelieferte Windows-Binary (`@anthropic-ai/claude-agent-sdk-win32-x64`) startete in der
  pnpm-Installation nicht (ENOENT). Mit `pathToClaudeCodeExecutable` auf die installierte CLI funktioniert alles.

## Entscheidung

- Primärer Adapter: **Agent SDK** (`query()` im Streaming-Input-Modus). Er bietet als dokumentierte API:
  Freigaben (`canUseTool`), `interrupt()`, `setPermissionMode()`, `setModel()`, `resume`, `listSessions()`,
  `getSessionMessages()`, Hooks (`PreToolUse`).
- Ausgeführt wird die **installierte CLI** (`pathToClaudeCodeExecutable`), automatisch über PATH gefunden
  oder in den Einstellungen gesetzt. Dadurch gelten dieselbe Version, derselbe Login und dieselbe
  `~/.claude`-Konfiguration wie im Terminal.
- Die Anmeldung macht ausschließlich die CLI selbst. FORGE liest keine Credentials.
- `settingSources: ["user", "project", "local"]`: CLAUDE.md, Skills und Projekt-Settings bleiben wirksam.
  Der Permission-Modus wird immer explizit übergeben, damit ein `defaultMode` aus einer Repo-Datei
  keinen Bypass freischalten kann.
- `ANTHROPIC_API_KEY` im Umfeld wird erkannt und standardmäßig aus der Session-Umgebung entfernt
  (abschaltbar), weil er sonst die Abo-Anmeldung überschreibt und API-Kosten auslöst.

## Abrechnung / Transparenz

Laut Anthropic-Hilfeartikel „Use the Claude Agent SDK with your Claude plan" (Stand 07.10.2026, Link im
Master-Prompt) ist die Nutzung des Agent SDK mit Abo vorgesehen; die Bedingungen können sich ändern.
FORGE zeigt pro Session die von der CLI gemeldete `apiKeySource` an. `total_cost_usd` aus dem
`result`-Event ist ein API-Äquivalent und wird bei Abo-Anmeldung **nicht** als Kosten angezeigt.

## Konsequenzen

- Node.js ≥ 22.13 wird zur Laufzeit gebraucht (Sidecar).
- CLI-Updates können Event-Formate erweitern. Der Normalizer ignoriert unbekannte Events und
  protokolliert sie im Debug-Log.

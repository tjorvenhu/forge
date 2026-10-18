<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0001-runtime-claude-agent-sdk.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0001: Claude integration via the Agent SDK with the installed CLI

Date: 2026-10-10 · Status: accepted

## Context

FORGE should use the existing Claude Code login (Max subscription). No mandatory API key, no reading
of OAuth tokens. The options were the TypeScript Agent SDK (`@anthropic-ai/claude-agent-sdk`) and a
custom CLI adapter via `claude -p --output-format stream-json`.

## Verified (spike, 2026-10-10)

- `claude --version` → 2.1.296; `claude auth status` → `authMethod: claude.ai`, `subscriptionType: max`.
- CLI spike: `claude -p … --output-format stream-json --verbose --include-partial-messages` delivers
  `system/init`, `stream_event` (token deltas), `assistant`, `user` (tool_result), `rate_limit_event`, `result`.
- SDK spike (0.3.296): `query()` with streaming input, `canUseTool` is called for `Write`, a denial reaches
  Claude, `listSessions({dir})` finds the Session. `system/init.apiKeySource = "none"`,
  `initializationResult().account.subscriptionType = "Claude Max"`.
- The Windows binary shipped with the SDK (`@anthropic-ai/claude-agent-sdk-win32-x64`) did not start in the
  pnpm installation (ENOENT). With `pathToClaudeCodeExecutable` pointing to the installed CLI, everything works.

## Decision

- Primary adapter: **Agent SDK** (`query()` in streaming input mode). It offers as documented API:
  approvals (`canUseTool`), `interrupt()`, `setPermissionMode()`, `setModel()`, `resume`, `listSessions()`,
  `getSessionMessages()`, hooks (`PreToolUse`).
- The **installed CLI** is executed (`pathToClaudeCodeExecutable`), found automatically via PATH
  or set in the settings. This way the same version, the same login and the same
  `~/.claude` configuration apply as in the terminal.
- Login is handled exclusively by the CLI itself. FORGE does not read any credentials.
- `settingSources: ["user", "project", "local"]`: CLAUDE.md, skills and project settings stay in effect.
  The permission mode is always passed explicitly, so that a `defaultMode` from a repo file
  cannot unlock bypass.
- `ANTHROPIC_API_KEY` in the environment is detected and removed from the Session environment by default
  (can be turned off), because otherwise it overrides the subscription login and causes API costs.

## Billing / transparency

According to the Anthropic help article "Use the Claude Agent SDK with your Claude plan" (as of 2026-10-07, link in the
master prompt), using the Agent SDK with a subscription is intended; the terms may change.
FORGE shows the `apiKeySource` reported by the CLI for each Session. `total_cost_usd` from the
`result` event is an API equivalent and is **not** shown as cost when logged in with a subscription.

## Consequences

- Node.js ≥ 22.13 is required at runtime (sidecar).
- CLI updates may extend event formats. The normalizer ignores unknown events and
  logs them in the debug log.

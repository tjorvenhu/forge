<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0003-architektur-prozesse.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0003: Process model, IPC and persistence

Date: 2026-10-10 · Status: accepted

## Decision

- **Tauri 2** (Rust) is only the desktop shell: window, folder dialog, starting/stopping the sidecar.
  No shell, FS or HTTP plugins for the webview.
- **Node sidecar** (`packages/sidecar`) contains the logic: Claude runtime, projects, Git, policy, persistence.
- **IPC without a network port:** The webview calls `invoke("sidecar_send")`, Rust writes the line to
  the sidecar's stdin. stdout lines are sent back as the Tauri event `sidecar://message`. There is no
  localhost server, so there is no attack surface for other processes or websites.
- Protocol: JSON Lines, request `{id, method, params}`, response `{id, ok, result|error}`,
  event `{event, payload}`. All params are validated in the sidecar with Zod (`packages/protocol`).
- Processes are always started with argument arrays (`spawn(cmd, args, {shell:false})`), `cwd` explicit.
- **Persistence: `node:sqlite`** (no flag needed in Node ≥ 22.13) instead of Drizzle/better-sqlite3. Reason: no
  native build, no ABI problems when packaging. Schema via numbered SQL migrations.
  Deliberate deviation from the proposal (Drizzle); the repository layer encapsulates SQL.
- Data is stored in `%APPDATA%/forge`. FORGE runs on Windows only.

## Deviations from the preferred stack

- **Monaco** only arrives with the CLAUDE.md editor (phase 2). For diffs, phase 1 uses its own
  virtualized renderer based on the parsed `git diff` (unit-tested). Saves about 4 MB of bundle size.
- **shadcn/ui**: components following the shadcn pattern (Radix + Tailwind + cva) directly in
  `apps/desktop/src/components/ui/`, without the CLI generator.
- **Native window frames** instead of a custom title bar (accessibility, snap layouts on Windows).
- **xterm.js + PTY**: phase 2. In phase 1 the bottom panel shows the real Claude event output.

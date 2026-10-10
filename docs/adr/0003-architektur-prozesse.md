# ADR 0003: Prozessmodell, IPC und Persistenz

Datum: 2026-10-10 · Status: angenommen

## Entscheidung

- **Tauri 2** (Rust) ist nur die Desktop-Hülle: Fenster, Ordnerdialog, Start/Stopp des Sidecars.
  Keine Shell-, FS- oder HTTP-Plugins für die Webview.
- **Node-Sidecar** (`packages/sidecar`) enthält die Logik: Claude-Runtime, Projekte, Git, Policy, Persistenz.
- **IPC ohne Netzwerkport:** Die Webview ruft `invoke("sidecar_send")`, Rust schreibt die Zeile in
  stdin des Sidecars. stdout-Zeilen gehen als Tauri-Event `sidecar://message` zurück. Es gibt keinen
  localhost-Server, also keine Angriffsfläche für andere Prozesse oder Webseiten.
- Protokoll: JSON-Lines, Request `{id, method, params}`, Response `{id, ok, result|error}`,
  Event `{event, payload}`. Alle Params werden im Sidecar mit Zod validiert (`packages/protocol`).
- Prozessstart immer mit Argument-Arrays (`spawn(cmd, args, {shell:false})`), `cwd` explizit.
- **Persistenz: `node:sqlite`** (in Node ≥ 22.13 ohne Flag) statt Drizzle/better-sqlite3. Grund: kein
  nativer Build, keine ABI-Probleme beim Paketieren. Schema über nummerierte SQL-Migrationen.
  Abweichung vom Vorschlag (Drizzle) bewusst; die Repository-Schicht kapselt SQL.
- Daten liegen in `%APPDATA%/forge` (Windows) bzw. `$XDG_DATA_HOME/forge` (Linux).

## Abweichungen vom bevorzugten Stack

- **Monaco** kommt erst mit dem CLAUDE.md-Editor (Phase 2). Für Diffs nutzt Phase 1 einen eigenen,
  virtualisierten Renderer auf Basis des geparsten `git diff` (unit-getestet). Spart ca. 4 MB Bundle.
- **shadcn/ui**: Komponenten nach shadcn-Muster (Radix + Tailwind + cva) direkt in
  `apps/desktop/src/components/ui/`, ohne CLI-Generator.
- **Native Fensterrahmen** statt eigener Titelleiste (Barrierefreiheit, Snap-Layouts unter Windows).
- **xterm.js + PTY**: Phase 2. Das untere Panel zeigt in Phase 1 die echte Claude-Event-Ausgabe.

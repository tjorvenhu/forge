---
title: "MCP-Server verwalten: Scopes, Bearer-Token, Header, OAuth, Bearbeiten, Freigabe (McpService, mcp.add/get/approve)"
summary: "Wie FORGE MCP-Server über die claude-CLI anlegt, den Bereich je Server aus den Konfigurationsdateien liest, Header/Token/OAuth-Client übergibt, Bearbeiten als Entfernen plus Neuanlage umsetzt und Server aus .mcp.json freigibt."
tags: ["sidecar","ui","telefon","stolperfalle","einstellungen"]
updated: "2026-10-24T12:07:07.433Z"
---

Stand 2026-10-24. Code: `packages/sidecar/src/config/mcp.ts` (McpService), Desktop `apps/desktop/src/components/extensions/` (McpTab, McpServerDialog, mcp.ts, env.ts), Telefon-Werkzeug `extensions` kind mcp.

## Grundsatz
FORGE schreibt MCP-Server nicht selbst in Dateien, sondern ruft `claude mcp add/remove/add-json` (ohne Shell). Gelesen wird direkt aus den Dateien, weil `claude mcp list` den Bereich nicht nennt.

## Bereich (Scope) je Server
- user: `mcpServers` oben in `~/.claude.json` (bzw. `$CLAUDE_CONFIG_DIR/.claude.json`, `claudeJsonPath()`).
- local: `projects[<Ordner>].mcpServers` in `~/.claude.json`. Claude schreibt den Ordner mit Vorwärts-Slashes (`C:/Users/...`), Vergleich darum über `pathKey()`.
- project: `<Ordner>/.mcp.json`.
- Vorrang wie Claude Code: local vor project vor user (`configuredServers`).
- Server aus Plugins oder claude.ai haben keinen Bereich: nicht bearbeitbar, Entfernen fragt nach dem Bereich.
- Ohne offenes Projekt (cwd = Home) wählt der Dialog für project/local ein Projekt aus `projects.list` (nur Hauptprojekte).

## Stolperfallen der CLI (claude 2.1.x)
- `-e` und `-H` sind variadisch: Sie fressen auch den Namen, wenn der danach kommt. Darum Reihenfolge `mcp add <name> --scope … -e … -H "K: V" --client-id … -- <url|cmd> args`.
- `--client-secret` ist ein Schalter: ohne Wert fragt die CLI interaktiv (hängt bis Timeout). FORGE setzt den Schalter nur mit Secret und gibt den Wert über die Umgebungsvariable `MCP_CLIENT_SECRET`, nie auf der Kommandozeile. Das Secret landet im System-Schlüsselbund, in der Datei steht nur `oauth: { clientId, callbackPort }`.
- Server aus `.mcp.json` zeigt `claude mcp list` als `Pending approval`, bis sie freigegeben sind. FORGE: Status `pending`, Knopf „Freigeben“ = `mcp.approve` schreibt den Namen in `enabledMcpjsonServers` der `.claude/settings.local.json` (`updateSettings` in claude-config.ts). Beim Anlegen mit Bereich project gibt FORGE gleich frei.
- Es gibt kein `mcp edit`. `mcp.add` mit `replaces: {name, scope}` entfernt den alten Eintrag und legt neu an; scheitert das, stellt `claude mcp add-json` den alten Roheintrag wieder her. Ein OAuth-Client-Secret geht dabei verloren (UI-Hinweis: neu eingeben).

## Geheimnisse
- `mcp.list` liefert nur Namen (`headerNames`, `envNames`, `oauthClientId`), Werte nur `mcp.get` für den Bearbeiten-Dialog. Das Telefon sagt bei read nur Namen an.
- Bereich project: Token und Header landen in `.mcp.json` im Repo. Dialog warnt und empfiehlt `${VARIABLE}` (Claude Code expandiert das in .mcp.json).
- Dialog-Prefill: `Authorization: Bearer …` wird zum Token-Feld, alle anderen Header kommen ins Feld „Weitere Header“.

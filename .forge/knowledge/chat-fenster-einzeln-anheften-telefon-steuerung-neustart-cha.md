---
title: "Chat-Fenster: einzeln anheften, Telefon-Steuerung, Neustart (chat_window_on_top, app.chatWindows, chatWindow.request)"
summary: "Wie ausgekoppelte Chat-Fenster einzeln im Vordergrund bleiben, wie Telefon und Befehlspalette sie öffnen, zurückholen und anheften und wie die Nadel ein Update übersteht."
tags: ["chat-fenster","tauri","telefon","ui","update"]
updated: "2026-10-18T12:29:12.892Z"
---

Stand: 2026-10-18.

## Anheften
- Einstellung `alwaysOnTop` („Im Vordergrund bleiben“, Nadel im Hauptfenster-Kopf, Palette, Telefon `always_on_top`) gilt **nur fürs Hauptfenster** (`set_always_on_top` in `chat_windows.rs`). Bewusst so: der Nutzer wollte nicht immer ganz FORGE anpinnen.
- Jedes Chat-Fenster wird einzeln angeheftet: Nadel in der Kopfzeile (`ChatWindowPinButton`), Rechtsklick auf die Kopfzeile (`SessionBar`, detached), Palette im Hauptfenster („Chat-Fenster im Vordergrund halten“ für die gezeigte Session).
- Shell-Befehl `chat_window_on_top(sessionId?, on?)`: ohne sessionId meint ein Chat-Fenster sich selbst, das Hauptfenster nennt die Session. Die Shell merkt sich angeheftete Fenster (`ChatWindows.pinned`, Labels) und sendet `chat-windows://changed` mit `{ sessions, pinned }` (Session-IDs) an alle Fenster; Chat-Fenster lesen danach ihren eigenen Stand neu (`loadChatWindowPin`).
- `open_chat_window(..., pinned)` öffnet ein Fenster gleich angeheftet bzw. heftet ein schon offenes an.

## Telefon
Nur die Shell kann Fenster bedienen, der Sidecar weiß nichts davon. Darum:
- Das Hauptfenster meldet jede Änderung der Liste per RPC `app.chatWindows { sessions, pinned }` (und nach Sidecar-Neustart über `rpc.onStatus`). Sidecar hält sie in `util/chat-windows.ts` `ChatWindowState`.
- Telefon-Werkzeug `chat_window` (status, open, close = zurückholen, pin, unpin) liest diesen Stand und schickt Event `chatWindow.request`; das Hauptfenster führt es aus (`handleChatWindowRequest` in `lib/chat-windows.ts`). pin ohne offenes Fenster öffnet eines angeheftet.

## Update-Neustart
`rememberChatWindows` (app-install.ts) speichert `sessions` und `pinned` in localStorage `forge.reopenChatWindows`; `reopenChatWindows` öffnet angeheftete Fenster wieder angeheftet.

---
title: "Anthropic-Bedingungen: Claude-Abo-Login in FORGE (Agent SDK, unverändertes Claude-Code-Binary, Branding)"
summary: "Was Anthropics Bedingungen (Stand 2026-10-20) zum Abo-Login in Drittanbieter-Apps sagen, warum FORGE darunter fällt und was man nicht ändern darf (Login-Flow, Binary, Tokens, Name/Logo)."
tags: ["sdk","release","konvention","stolperfalle","sessions"]
updated: "2026-10-20T10:29:46.648Z"
---

Recherche 2026-10-20 vor dem öffentlichen Launch. Quellen: https://code.claude.com/docs/en/legal-and-compliance (Abschnitte "Authentication and credential use", "Can customers offer Claude Code in their products?"), https://code.claude.com/docs/en/agent-sdk/overview (Note und Branding), https://support.claude.com/en/articles/15036540 (Update 2026-10-07).

## Wie FORGE technisch dasteht
- Sidecar nutzt `@anthropic-ai/claude-agent-sdk` mit `pathToClaudeCodeExecutable` = offizielles, unverändertes `claude`-Binary (eigene Installation über Anthropics Installer).
- Login über `claude auth login` (`packages/sidecar/src/claude/setup.ts`): FORGE zeigt nur die Anmelde-URL, die Anmeldung läuft durch Anthropics eigenen Flow. FORGE liest/speichert keine OAuth-Tokens; Sync fasst Claude-Zugangsdaten nicht an.

## Was die Bedingungen sagen
- Dafür (Legal-Seite): ausdrücklich erlaubt, dass "an end user [signs] in to the unmodified Claude Code binary with their own Claude subscription". Bedingungen: Binary unverändert, keine Auth-Methode entfernen/einschränken, jeder Nutzer zahlt selbst, keine Credentials sammeln/speichern/durchreichen.
- Dagegen (Agent-SDK-Doku): "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." FORGE nutzt das Agent SDK, daher Graubereich. Enforcement 2026 traf v. a. Tools, die OAuth-Tokens selbst nutzten (OpenClaw), nicht Tools, die das echte Binary starten.
- Hilfeartikel 2026-10-07: Agent SDK, `claude -p` und "third-party apps" laufen weiter über die Abo-Limits.
- Branding: "runs Claude Code" in Text ist erlaubt; Claude-Code-/Anthropic-Name oder -Logo nicht im Produktnamen/Logo und nicht so, dass es nach offiziellem Produkt oder Partnerschaft aussieht. Agent-SDK-Doku verbietet "Claude Code"-Optik/ASCII-Art.

## Konsequenzen für Änderungen
- Nie: Claude-Code-Binary patchen, Tokens aus `~/.claude`/Schlüsselbund lesen oder synchronisieren, eigenen OAuth-Flow bauen, Nutzung über ein gemeinsames Konto laufen lassen.
- Texte: "a desktop app for Claude Code" statt "the desktop app", Hinweis "nicht mit Anthropic verbunden".
- Rechtssicherheit nur per schriftlicher Bestätigung von Anthropic (Kontakt laut Legal-Seite: contact-sales).

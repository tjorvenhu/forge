<a href="0010-telefon-sip.md"><img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English</a> · <img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch

# ADR 0010: Telefon über SIP

Datum: 2026-10-11 · Status: angenommen

## Ziel

FORGE anrufen und nach dem Stand fragen oder Sessions steuern; FORGE ruft an, wenn eine Session fertig ist, eine
Entscheidung braucht oder ein Fehler auftritt. Verbindung über die SIP-Zugangsdaten der eigenen Telefonanlage des
Nutzers, eingetragen in den Einstellungen unter Telefon.

## Entscheidungen

**Eigener SIP-Client im Sidecar** (`packages/sidecar/src/phone/`). Für Node gibt es keine gepflegte Bibliothek, die
ohne zusätzlichen Server (drachtio, Asterisk) oder WebRTC-Gateway (SIP.js) registriert und RTP spricht. Der Umfang
ist überschaubar und testbar:

- `sip-message.ts`, `digest.ts`, `sdp.ts`: Parser und Builder (RFC 3261, 2617/8760, 4566; MD5, SHA-256 und
  `-sess`, qop `auth`/`auth-int`, Wiederholung bei `stale=true`; die stärkste Challenge wird gewählt).
- `sip-ua.ts`: UDP auf der lokalen Schnittstelle zur Anlage, nur Pakete von der Anlage. REGISTER mit Digest und
  Erneuerung, NAT-Erkennung über `received`/`rport` (dann neue Anmeldung mit der öffentlichen Adresse; bei jeder
  Erneuerung neu geprüft, bei Fehlschlag neue lokale Adresse), Keepalive, Client-/Server-Transaktionen mit
  Wiederholungen, INVITE ein und aus, 401/407, CANCEL, BYE, Re-INVITE und UPDATE (neue Medienadresse, Halten mit
  `recvonly` beantwortet, sonst 488), INFO (DTMF), OPTIONS. Finale Antworten auf INVITE werden bis zum ACK
  wiederholt; abgehende INVITEs enden spätestens 77 s nach dem ersten Klingeln. Anfragen im Gespräch brauchen das
  Tag von FORGE. Alle Anfragen gehen an die Anlage (sie wirkt als Outbound-Proxy), Antworten dorthin, woher die
  Anfrage kam.
- `rtp.ts`: G.711 PCMA/PCMU, 20-ms-Takt mit Stille, wenn nichts zu sagen ist (Anlagen beenden sonst Gespräche),
  DTMF nach RFC 4733, symmetrisches RTP: Die Antwortadresse übernimmt die erste Quelle mit der IP aus dem SDP oder
  der Anlage; danach gilt nur noch diese Adresse. Audio vor dem Gesprächsbeginn wird verworfen.
- Nicht unterstützt: TCP/TLS, SRTP, andere Codecs. Verschlüsselte Angebote werden mit 488 abgelehnt.

**Sprache:** OpenAI. Erkennung `gpt-4o-transcribe` (`language=de`, Vokabelhinweise), Ausgabe `gpt-4o-mini-tts` mit
Stimme `marin`, PCM 24 kHz gestreamt und mit Tiefpass auf 8 kHz gebracht. Beide Modelle sind in den Einstellungen
änderbar, weil OpenAI Modelle austauscht (Stand der Doku am 2026-10-11: TTS empfiehlt `gpt-4o-mini-tts`, STT
empfiehlt `gpt-transcribe` mit neuem Sprachparameter). Zeitlimits 20 s (Erkennung) und 45 s (Ausgabe);
Äußerungen werden der Reihe nach erkannt.

**Gesprächspartner:** Claude Haiku über das Claude-Code-Abo (Agent SDK), eigener System-Prompt für gesprochene
Sprache, keine eingebauten Werkzeuge (`tools: []`), nur FORGE-Werkzeuge über `createSdkMcpServer` (Liste in
`phone/tools.ts`, `PHONE_TOOLS`; siehe Nachtrag 2026-10-13). Text wird satzweise vorgelesen, sobald ein Satz fertig
ist. Sessions heißen im Gespräch S1, S2 (Zuordnung pro Anruf). Steuernde Werkzeuge laufen nach der PIN sofort.
Session-Texte gehen markiert als Daten an Claude, nicht als Anweisung. Der Prompt verlangt ein bis zwei Sätze,
keine Einleitung, keine Zeitangaben oder Kürzel ohne Not.

Nachtrag 2026-10-11: Die Bestätigung per Taste 1 ist entfernt. Im Gespräch war sie zu umständlich; der Nutzer will
FORGE am Telefon vollständig und direkt steuern (auch Remote Control, Git, Einstellungen einer Session).

Nachtrag 2026-10-13: Projektregel „Das Telefon kann alles, was FORGE kann“. `phone/coverage.ts` ordnet jede
RPC-Methode aus `protocol/src/rpc.ts` einem Telefon-Werkzeug zu (`PHONE_TOOL_FOR`) oder führt sie mit Grund als
Ausnahme (`NOT_ON_PHONE`: Browser-Anmeldungen, Diktat, Dateidialoge, reine Anzeige-Methoden, Telefon-Einrichtung).
`test/phone-coverage.test.ts` schlägt fehl, sobald eine Methode in keiner Liste steht oder ein genanntes Werkzeug
fehlt. Neu dazu: `project` (anlegen, importieren, klonen, entfernen, umbenennen, Favorit, Profil, Standardmodell,
Test- und Dev-Befehl), `files`, `claude_md`, `sessions` (Liste aller Sessions, löschen, verzweigen, zurückspulen),
`extensions` (MCP, Skills, Subagenten, Commands, Hooks lesen, Plugins), `forge_settings`, `forge_system` (Diagnose,
Updates von FORGE und Claude Code, Backups); `git` kann zusätzlich fetch, branches, delete_branch, diff, restore,
init, publish, account, identity; `finish_agent` hat review; `dev_settings` setzt Variablen der Test-Umgebung und
nennt nur ihre Namen. Wenige Werkzeuge mit `action` statt vieler einzelner, weil Gemini Live lange Werkzeuglisten
schlecht verträgt. Die neuen Werkzeuge rufen die RPC-Handler über `invokeHandler` (`rpc/handlers.ts`) auf, mit
denselben Prüfungen und Nebenwirkungen wie die Oberfläche. Alle brauchen die PIN; Telefon-Einstellungen lassen sich
am Telefon nicht aus einem Backup wiederherstellen, weil das die Leitung neu verbindet und das Gespräch beendet.

**Ablauf eines Anrufs** (`call-controller.ts`): Energie-VAD mit adaptivem Rauschpegel und Vorlauf; während FORGE
spricht, gilt eine höhere Schwelle (Echo) und Sprache muss 240 ms anhalten, bevor sie FORGE unterbricht.
Sprecherwechsel: Eine Äußerung endet nach 700 ms Stille, der Redebeitrag des Anrufers aber erst nach weiteren
400 ms, wenn der letzte Satz abgeschlossen klingt, sonst nach 2 s (kein Satzzeichen, „…“, endet auf „und“, „weil“
usw.). Bis dahin wird gesammelt und als eine Nachricht an Claude gegeben. Claude bekommt nie eine Nachricht, während
es noch schreibt; Hinweise von FORGE warten ebenso. Spricht der Anrufer, während FORGE redet, hält FORGE sofort an.
War es nur ein Geräusch oder ein „Mhm“, redet FORGE weiter (den angefangenen Satz von vorn). Sonst verwirft FORGE den
Rest der Antwort, bricht Claudes laufende Antwort ab (`interrupt`) und gibt die neuen Worte danach weiter. Ankommend: feste
Begrüßung sofort, Claude antwortet auf das erste Anliegen. Abgehend: Claude bereitet die ersten Sätze vor, während es
klingelt; gesprochen wird erst nach dem Abnehmen. Auflegen nach 90 s Stille oder 30 min.

**Sicherheit:** siehe docs/SECURITY.md, Abschnitt Telefon. Kurz: Freigabeliste für Anrufer, PIN per DTMF für alles
Steuernde (nicht über das Sprachmodell), scrypt-Hash, drei Versuche pro Anruf, Sperre nach 5 Fehlversuchen je
Nummer oder 10 insgesamt pro Stunde; Geheimnisse mit DPAPI.

**Rückrufe:** aus den Session-Ereignissen (`turn.result`, `approval.request`, `error`). Wartezeit 5 s (fertig, Fehler)
bzw. 15 s (Entscheidung), danach erneute Prüfung, ob der Anlass noch gilt (neuer Durchlauf läuft, Freigabe am
Rechner beantwortet). Höchstens ein Anruf pro Minute, keiner während eines Gesprächs.

## Tests

Gegen eine Test-Anlage über echtes UDP (Digest, NAT, Anrufe in beide Richtungen, Audio, DTMF, CANCEL, BYE) und mit
echtem Claude für den Gesprächspartner. Mit Fakes zusätzlich: Absenderprüfung, CANCEL während der Vorbereitung,
Fehlerpfade, Halten, stale-Nonce, PIN-Sperre, Sprecherwechsel und Unterbrechen, Steuerwerkzeuge, Zeitlimits der
Sprachdienste. Nicht getestet: die echte Anlage des Nutzers und die echten
OpenAI-Sprachdienste.

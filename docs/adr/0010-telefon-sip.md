# ADR 0010: Telefon über SIP

Datum: 2026-10-11 · Status: angenommen

## Ziel

FORGE anrufen und nach dem Stand fragen oder Sessions steuern; FORGE ruft an, wenn eine Session fertig ist, eine
Entscheidung braucht oder ein Fehler auftritt. Verbindung über die SIP-Zugangsdaten der eigenen Telefonanlage des
Nutzers, eingetragen unter Einstellungen → Telefon.

## Entscheidungen

**Eigener SIP-Client im Sidecar** (`packages/sidecar/src/phone/`). Für Node gibt es keine gepflegte Bibliothek, die
ohne zusätzlichen Server (drachtio, Asterisk) oder WebRTC-Gateway (SIP.js) registriert und RTP spricht. Der Umfang
ist überschaubar und testbar:

- `sip-message.ts`, `digest.ts`, `sdp.ts`: Parser und Builder (RFC 3261, 2617/8760, 4566).
- `sip-ua.ts`: UDP, REGISTER mit Digest und Erneuerung, NAT-Erkennung über `received`/`rport` (dann neue Anmeldung
  mit der öffentlichen Adresse), Keepalive, Client-/Server-Transaktionen mit Wiederholungen, INVITE ein und aus,
  401/407, CANCEL, BYE, Re-INVITE und UPDATE (Medien bleiben), INFO (DTMF), OPTIONS. Alle Anfragen gehen an die
  Anlage (sie wirkt als Outbound-Proxy), Antworten dorthin, woher die Anfrage kam.
- `rtp.ts`: G.711 PCMA/PCMU, 20-ms-Takt mit Stille, wenn nichts zu sagen ist (Anlagen beenden sonst Gespräche),
  DTMF nach RFC 4733, symmetrisches RTP (Antwortadresse übernimmt die erste echte Quelle).
- Nicht unterstützt: TCP/TLS, SRTP, andere Codecs. Verschlüsselte Angebote werden mit 488 abgelehnt.

**Sprache:** OpenAI. Erkennung `gpt-4o-transcribe` (`language=de`, Vokabelhinweise), Ausgabe `gpt-4o-mini-tts` mit
Stimme `marin`, PCM 24 kHz gestreamt und mit Tiefpass auf 8 kHz gebracht. Beide Modelle sind in den Einstellungen
änderbar, weil OpenAI Modelle austauscht (Stand der Doku am 2026-10-11: TTS empfiehlt `gpt-4o-mini-tts`, STT
empfiehlt `gpt-transcribe` mit neuem Sprachparameter).

**Gesprächspartner:** Claude Haiku über das Claude-Code-Abo (Agent SDK), eigener System-Prompt für gesprochene
Sprache, keine eingebauten Werkzeuge (`tools: []`), nur FORGE-Werkzeuge über `createSdkMcpServer`: status, details,
send_message, start_session, respond, stop_session, dev_server, hang_up. Text wird satzweise vorgelesen, sobald ein
Satz fertig ist. Sessions heißen im Gespräch S1, S2 (Zuordnung pro Anruf).

**Ablauf eines Anrufs** (`call-controller.ts`): Energie-VAD mit adaptivem Rauschpegel und Vorlauf; während FORGE
spricht, gilt eine höhere Schwelle (Echo). Spricht der Anrufer dazwischen, bricht die Ausgabe ab. Ankommend: feste
Begrüßung sofort, Claude antwortet auf das erste Anliegen. Abgehend: Claude bereitet die ersten Sätze vor, während es
klingelt; gesprochen wird erst nach dem Abnehmen. Auflegen nach 90 s Stille oder 30 min.

**Sicherheit:** siehe docs/SECURITY.md, Abschnitt Telefon. Kurz: Freigabeliste für Anrufer, PIN per DTMF für alles
Steuernde (nicht über das Sprachmodell), scrypt-Hash, drei Versuche; Geheimnisse mit DPAPI.

**Rückrufe:** aus den Session-Ereignissen (`turn.result`, `approval.request`, `error`). Wartezeit 5 s (fertig, Fehler)
bzw. 15 s (Entscheidung), danach erneute Prüfung, ob der Anlass noch gilt (neuer Durchlauf läuft, Freigabe am
Rechner beantwortet). Höchstens ein Anruf pro Minute, keiner während eines Gesprächs.

## Tests

Gegen eine Test-Anlage über echtes UDP (Digest, NAT, Anrufe in beide Richtungen, Audio, DTMF, CANCEL, BYE) und mit
echtem Claude für den Gesprächspartner. Nicht getestet: die echte Anlage des Nutzers und die echten
OpenAI-Sprachdienste.

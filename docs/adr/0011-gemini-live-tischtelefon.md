# ADR 0011: Gemini Live am Telefon, Tischtelefon, Telefon als optionale Funktion

Datum: 2026-10-12 · Status: angenommen

## Ziel

FORGE als Zentrale anrufen und frei mit ihr reden: Stand abfragen, Sessions und parallele Agenten starten, Freigaben
geben. Das Gespräch soll sich wie ein Telefonat anfühlen, nicht wie Diktieren. Dazu kommt das Yealink-Tischtelefon,
das bisher das Skript `klaus_telefon` bedient hat (Tasten pro Session, LEDs, Display, Rückruf). FORGE ersetzt
`klaus_telefon`. Wer die Telefon-Funktion nicht braucht, soll sie gar nicht sehen.

## Entscheidungen

**Zwei Gesprächspartner, wählbar** (`PhoneConfig.engine`):

- `gemini-live` (Standard): Gemini 3.8 Live (`gemini-3.8-live`, laut Google-Doku am 2026-10-12 stabil) über die Live API
  (WebSocket `BidiGenerateContent`). Gemini hört, entscheidet selbst, wann der Anrufer fertig ist, spricht und ruft
  FORGE-Werkzeuge als Function Calls auf. Unterbrechen erledigt Gemini: Meldet es `interrupted`, verwirft FORGE die
  wartende Sprachausgabe sofort. Audio: Telefon 8 kHz → 16 kHz (linear) hinein, 24 kHz → 8 kHz (gefiltert) heraus.
  Verbindungen der Live API sind zeitlich begrenzt. FORGE merkt sich den Resumption-Handle und wechselt bei `goAway`
  oder einem Abbruch auf eine neue Verbindung mit demselben Kontext (höchstens dreimal hintereinander). Dazu
  Kontextkompression (Sliding Window). Für eingehende Anrufe verbindet FORGE Gemini schon beim Annehmen; die
  Begrüßung spricht Gemini selbst.
- `claude`: wie bisher (ADR 0010), Claude Haiku über das Abo. Hören und Sprechen wahlweise über OpenAI oder Gemini
  (`speechProvider`). Gemini-Erkennung: `generateContent` mit Audio (Standard `gemini-3.5-flash-lite`).
  Gemini-Ausgabe: `streamGenerateContent` (SSE) mit `gemini-3.8-flash-tts`, erstes Audio nach etwa 0,7 s.

**Ein Werkzeugsatz für beide** (`phone/tools.ts`): Name, Beschreibung, Parameter und Ausführung stehen einmal da.
Daraus entstehen die MCP-Werkzeuge für Claude (zod) und die Function Declarations für Gemini (Schema-Typen der
Gemini API). Aufrufe von Gemini kommen als JSON und werden vor der Ausführung mit zod geprüft; Fehler gehen als Text
zurück. Rückfrage-Antworten sind deshalb eine Liste `{question, answer}` statt eines freien Objekts. Der
System-Prompt ist derselbe, nur die Zeile zum Medium unterscheidet sich.

**Neue Agenten per Telefon:** `start_session` hat `agent: true`. FORGE legt dann wie im Tab „Agenten“ einen Worktree
mit eigenem Branch `agent/<auftrag>-<kürzel>` an (beim Hauptprojekt, auch wenn ein Worktree genannt wurde) und
startet die Session dort.

**PIN** (`phone/pin-pad.ts`): Die Tastatur-Logik ist aus dem Claude-Ablauf herausgelöst und gilt für beide
Gesprächspartner gleich. Gemini erfährt nur, dass Steuern frei ist; die Ziffern laufen nie durch ein Modell.

**Tischtelefon** (`phone/desk-phone.ts`), getestet bisher nur gegen Fakes, Vorlage war `klaus_telefon` am T53W:

- Das Telefon hängt wie bisher an der Anlage. FORGE ist eine eigene Nebenstelle; Abheben wählt sie nach einer
  Sekunde (Hotline). Kein direkter IP-Anruf, keine MicroSIP, keine virtuellen Audiokabel, kein Tastendruck ins
  Terminal mehr.
- FORGE startet einen kleinen HTTP-Server (Standard-Port 8766) auf der Schnittstelle zum Telefon. Er liefert die
  Provisioning-Datei (Leitungstasten Typ 27 mit Session-Namen, Hotline, Push- und Action-URI-Rechte nur für die
  FORGE-Adresse) und nimmt Tastendrücke und Menüantworten an. Nur Anfragen von der IP des Telefons, jede URL trägt
  ein zufälliges, gespeichertes Token.
- FORGE pusht über die Weboberfläche des Telefons (`/servlet?push=xml`, Basic oder Digest, wie es das Telefon
  verlangt): LEDs (orange blinkend = arbeitet, rot schnell = wartet, grün blinkend = neues Ergebnis, grün = bereit,
  orange = im Gespräch), Statuszeilen auf dem Startbildschirm, Freigaben als Menü (1 erlauben, 2 ablehnen). Neue
  Session-Namen lädt das Telefon per Action URI `AutoP` nach, nie während eines Gesprächs.
- Taste ohne Gespräch: FORGE merkt sich die Session (45 s) und lässt das Telefon die FORGE-Nebenstelle wählen
  (`key=number=…`). Das Gespräch beginnt dann mit dieser Session. Taste im Gespräch: Gemini oder Claude erfährt,
  dass es jetzt um diese Session geht.
- Rückrufe kommen wie bisher über die Anlage (`notifyNumber`), die Session wird auf dem Telefon ausgewählt.

**Optional:** `Settings.phoneFeature`. Aus (Standard bei neuen Installationen): kein Telefon-Knopf, keine
Telefon-Einstellungen, das Telefon und das Tischtelefon gehen aus. Wer vor dieser Version einen SIP-Server
eingetragen hatte, behält die Funktion sichtbar.

## Verworfen

- Konfiguration über GitHub (ein Repository pro Nutzer) für mehrere Nutzer: FORGE ist pro Windows-Konto getrennt
  (Daten unter `%APPDATA%\forge`, Claude-Login, gh-Login). Für den Kollegen reicht eine eigene Installation.
- Direkter SIP-Anruf vom Tischtelefon an die PC-IP (wie `klaus_telefon` mit MicroSIP): FORGE nimmt SIP nur von der
  Anlage an (ADR 0010). Über die Anlage geht es auch unterwegs vom Handy.

## Tests

`phone-live.test.ts`: Werkzeug-Schemas und Prüfung der Argumente, Live-Client mit Fake-WebSocket (Setup, Audio-
Umrechnung, Function Calls, goAway mit Resumption, abgelehnter Key), Gesprächsablauf mit Gemini (Begrüßung, Audio vor
dem Abnehmen, Werkzeuge, zurückgezogene Aufrufe, Unterbrechen, Auflegen, PIN, Ausfall), Gemini-Sprache (SSE),
Tischtelefon (Provisioning, LEDs, Digest am Telefon, Token und IP-Prüfung, Taste → Anruf, Freigabe-Menü, Taste im
Gespräch). `phone-call.test.ts`: Agent per Telefon im eigenen Worktree.

Gegen die echten Dienste am 2026-10-12 (`packages/sidecar/scripts/gemini-live-smoke.ts`, `gemini-voice-smoke.ts`):
Gemini Live verbindet in 0,4 bis 0,8 s, ruft `status` auf und antwortet auf Deutsch mit Sprache. Gemini-Ausgabe und
-Erkennung im Durchlauf: Satz gesprochen und wörtlich wiedererkannt.

Nicht getestet: Gemini Live über eine echte Telefonleitung (Echo, Pausen-Erkennung bei 8 kHz), das T53W mit FORGE
(Push, LEDs, AutoP, `key=number=`), Verbindungswechsel nach `goAway` gegen den echten Dienst.

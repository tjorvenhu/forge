---
title: "Telefon: mehrere Nummern, paralleles Klingeln (ForkedCall)"
summary: "Wie FORGE mehrere Benachrichtigungsnummern gleichzeitig anruft, wie die Nummernlisten gespeichert und migriert werden und worauf man bei ausgehenden Anrufen achten muss."
tags: ["telefon","sip","rtp","einstellungen","stolperfalle"]
updated: "2026-10-13T14:37:49.872Z"
---

## Datenmodell
`PhoneConfig.notifyNumbers` und `PhoneConfig.allowedCallers` sind Listen von `PhoneNumberEntry` (`id`, `number`, `label`, `enabled`; `packages/protocol/src/models.ts`). Es zählen nur eingeschaltete, nicht leere Einträge: `activeNumbers()` in `phone/phone-service.ts`. Das alte Feld `notifyNumber` (ein String) und `allowedCallers` als String-Liste wandelt `loadConfig()` beim Laden (Start, `reload()` nach Backup-Restore) in eingeschaltete Einträge um; `saveConfig` säubert per `cleanNumbers()` (trimmen, leere raus, doppelte IDs neu).

## Paralleles Klingeln
- `dial(numbers[])`: Bei einer Nummer ein normaler `SipCall`, bei mehreren ein `ForkedCall` (`phone/forked-call.ts`). Der verhält sich nach außen wie ein Anruf (`PhoneCall`-Interface in `sip-ua.ts`, abgeleitet von `EventEmitter<CallEvents>`, sonst passt der typisierte `on` nicht). Der erste Zweig mit `answered` gewinnt; alle anderen bekommen `hangup()` (klingelnd = CANCEL, gleichzeitig abgenommen = BYE). Ohne Gewinner endet der Anruf erst, wenn kein Zweig mehr klingelt; der Grund nennt dann je Nummer, warum.
- `remoteNumber` ist vor dem Abheben die Liste („0172…, 0151…“), danach die abhebende Nummer. `attach()` schreibt sie beim `answered` in `info.number` und den Anruf-Eintrag. Der PIN-Schutz liest die Nummer erst bei der Eingabe.
- Alle Zweige bieten dieselbe SDP mit **einem** RTP-Port an, weil der Controller (Gemini-Verbindung, Begrüßung) schon beim Klingeln vorbereitet wird und an `a.rtp` hängt.
- **Stolperfalle Early Media:** Mobilfunk schickt Klingelton per 183 von der Anlage, von einem anderen Port je Zweig. `RtpSession` würde nach `configure` den ersten Absender von einer erlaubten IP übernehmen (Symmetric RTP). Darum bekommt `configure` bei mehreren Nummern `exactMs` (`FORKED_EXACT_LATCH_MS` = 400): Bis dahin zählt nur die exakte SDP-Adresse des Abhebenden. Bei einer Nummer bleibt das Verhalten wie vorher.

## Bedienung
- UI: `components/settings/PhoneNumberList.tsx` (Schalter, Bezeichnung, Nummer, Löschen). Zeilen ohne Nummer schickt `toPatch` nicht mit; Schalter und Löschen speichern sofort, Textfelder beim Verlassen.
- Telefon: `call_settings` mit `number_action` (on/off/add/remove), `list` (notify/allowed), `number` (Nummer oder Bezeichnung), `label`. Nummern nennt es erst nach der PIN.
- Rückruf („ruf mich in 5 Minuten an“) an eine unbekannte Nummer speichert `number: ""` und lässt dann alle Benachrichtigungsnummern klingeln.

Tests: `test/forked-call.test.ts` (Zweige, Gründe, RTP-Fenster), `phone-call.test.ts` „rings all switched-on numbers at once …“ mit FakePbx (zwei INVITEs, CANCEL an den anderen, BYE an den Gewinner), Migration alter Einstellungen.

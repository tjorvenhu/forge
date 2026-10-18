<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0011-gemini-live-tischtelefon.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0011: Gemini Live on the phone, desk phone, phone as an optional feature

Date: 2026-10-12 · Status: accepted

## Goal

Call FORGE as a central hub and talk to it freely: ask about the state, start Sessions and parallel agents, give
approvals. The conversation should feel like a phone call, not like dictation. In addition, the Yealink desk phone,
which until now was operated by a separate script (keys per Session, LEDs, display, callback). FORGE replaces
this script. Anyone who does not need the phone feature should not see it at all.

## Decisions

**Two conversation partners, selectable** (`PhoneConfig.engine`):

- `gemini-live` (default): Gemini 3.8 Live (`gemini-3.8-live`, stable according to the Google docs on 2026-10-12) via the Live API
  (WebSocket `BidiGenerateContent`). Gemini listens, decides itself when the caller is finished, speaks and calls
  FORGE tools as function calls. Gemini handles interruptions: when it reports `interrupted`, FORGE immediately discards the
  pending speech output. Audio: phone 8 kHz → 16 kHz (linear) in, 24 kHz → 8 kHz (filtered) out.
  Live API connections are time-limited. FORGE remembers the resumption handle and, on `goAway`
  or a disconnect, switches to a new connection with the same context (at most three times in a row). In addition,
  context compression (sliding window). For incoming calls, FORGE connects Gemini as soon as the call is answered; Gemini
  speaks the greeting itself.
- `claude`: as before (ADR 0010), Claude Haiku via the subscription. Listening and speaking via either OpenAI or Gemini
  (`speechProvider`). Gemini recognition: `generateContent` with audio (default `gemini-3.5-flash-lite`).
  Gemini output: `streamGenerateContent` (SSE) with `gemini-3.8-flash-tts`, first audio after about 0.7 s.

**One tool set for both** (`phone/tools.ts`): name, description, parameters and execution are defined once.
From this, the MCP tools for Claude (zod) and the function declarations for Gemini (schema types of the
Gemini API) are generated. Calls from Gemini arrive as JSON and are validated with zod before execution; errors are
returned as text. Answers to questions are therefore a list `{question, answer}` instead of a free-form object. The
system prompt is the same; only the line about the medium differs.

**New agents by phone:** `start_session` has `agent: true`. FORGE then creates a worktree, as in the "Agenten" tab,
with its own branch `agent/<auftrag>-<kürzel>` (on the main project, even if a worktree was named) and
starts the Session there.

**PIN** (`phone/pin-pad.ts`): the keypad logic has been extracted from the Claude flow and applies equally to both
conversation partners. Gemini is only told that control is unlocked; the digits never pass through a model.

**Desk phone** (`phone/desk-phone.ts`), so far tested only against fakes, modeled on the previous script on the T53W:

- The phone stays connected to the phone system as before. FORGE is its own extension; picking up dials it after one
  second (hotline). No direct IP call, no MicroSIP, no virtual audio cables, no more keystrokes into the
  terminal.
- FORGE starts a small HTTP server (default port 8766) on the interface facing the phone. It serves the
  provisioning file (line keys type 27 with Session names, hotline, push and Action URI permissions only for the
  FORGE address) and accepts key presses and menu responses. Only requests from the phone's IP; every URL carries
  a random, stored token.
- FORGE pushes via the phone's web interface (`/servlet?push=xml`, Basic or Digest, as the phone
  requires): LEDs (orange blinking = working, red fast = waiting, green blinking = new result, green = ready,
  orange = in a call), status lines on the home screen, approvals as a menu (1 allow, 2 deny). The phone loads new
  Session names via Action URI `AutoP`, never during a call.
- Key without a call: FORGE remembers the Session (45 s) and has the phone dial the FORGE extension
  (`key=number=…`). The call then starts with this Session. Key during a call: Gemini or Claude is told
  that the topic is now this Session.
- Callbacks come via the phone system as before (`notifyNumber`); the Session is selected on the phone.

**Optional (replaced on 2026-10-12):** the switch `Settings.phoneFeature` has been dropped; the phone button appears as soon as a phone system is configured or the phone is on. Originally: `Settings.phoneFeature`. Off (default for new installations): no phone button, no
phone settings, the phone and the desk phone are turned off. Anyone who had entered a SIP server before this version
keeps the feature visible.

**Callback on request** (addendum 2026-10-12): tool `call_back(minutes, about)` for both conversation partners. The
appointment is stored in the phone settings (`callbacks`); a tick every 15 s checks for due appointments (no long timer
that would stall in standby). The number of the call is dialed if it is allowed, otherwise the callback number.
On the callback, the conversation partner receives the request as marked data and checks afresh with the tools. Busy
line or missing registration: new attempt on the next tick; after 15 minutes the appointment expires.

**Noise and echo** (addendum 2026-10-13): on the real phone, Gemini broke off mid-sentence and started over,
because its speech detection treated background noise and the echo of its own voice as the caller. Three
countermeasures: (1) `realtimeInputConfig.automaticActivityDetection` with `START_SENSITIVITY_LOW`, 300 ms
`prefixPaddingMs`, 700 ms `silenceDurationMs`. (2) A noise gate in front of Gemini (`NoiseGate` in `phone/vad.ts`, same
thresholds as the VAD in the Claude flow): when closed, digital silence of the same length is sent out; it opens after 60 ms
of clear speech, and while FORGE is speaking (and 300 ms afterwards, echo) only after 240 ms at 2.5 times the threshold. When opening,
the held-back frames are sent first, so the first syllable is preserved. (3) 200 ms pre-buffer before every
(re)start of playback, so that a short stall in the data stream is not audible as stuttering.

## Rejected

- Configuration via GitHub (one repository per user) for multiple users: FORGE is separated per Windows account
  (data under `%APPDATA%\forge`, Claude login, gh login). For the colleague, a separate installation is enough.
- Direct SIP call from the desk phone to the PC's IP (like the previous script with MicroSIP): FORGE only accepts SIP from the
  phone system (ADR 0010). Going through the phone system also works on the go from a mobile phone.

## Tests

`phone-live.test.ts`: tool schemas and argument validation, Live client with fake WebSocket (setup, audio
conversion, function calls, goAway with resumption, rejected key), call flow with Gemini (greeting, audio before
pickup, tools, withdrawn calls, interruption, hang-up, PIN, outage), Gemini speech (SSE),
desk phone (provisioning, LEDs, digest on the phone, token and IP check, key → call, approval menu, key during a
call). `phone-call.test.ts`: agent by phone in its own worktree.

Against the real services on 2026-10-12 (`packages/sidecar/scripts/gemini-live-smoke.ts`, `gemini-voice-smoke.ts`):
Gemini Live connects in 0.4 to 0.8 s, calls `status` and answers in German with speech. Gemini output and
recognition in a round trip: sentence spoken and recognized verbatim.

Not tested: Gemini Live over a real phone line (echo, pause detection at 8 kHz), the T53W with FORGE
(push, LEDs, AutoP, `key=number=`), connection switch after `goAway` against the real service.

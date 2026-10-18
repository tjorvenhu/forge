<img src="../../.github/assets/flags/gb.svg" height="14" alt=""> English · <a href="0010-telefon-sip.de.md"><img src="../../.github/assets/flags/de.svg" height="14" alt=""> Deutsch</a>

# ADR 0010: Phone via SIP

Date: 2026-10-11 · Status: accepted

## Goal

Call FORGE and ask about the current state or control Sessions; FORGE calls when a Session is finished, needs a
decision or an error occurs. Connection via the SIP credentials of the user's own phone system, entered in the
settings under Phone.

## Decisions

**Custom SIP client in the sidecar** (`packages/sidecar/src/phone/`). For Node there is no maintained library that
registers and speaks RTP without an additional server (drachtio, Asterisk) or WebRTC gateway (SIP.js). The scope
is manageable and testable:

- `sip-message.ts`, `digest.ts`, `sdp.ts`: parsers and builders (RFC 3261, 2617/8760, 4566; MD5, SHA-256 and
  `-sess`, qop `auth`/`auth-int`, retry on `stale=true`; the strongest challenge is chosen).
- `sip-ua.ts`: UDP on the local interface facing the phone system, only packets from the phone system. REGISTER with
  digest and renewal, NAT detection via `received`/`rport` (then a new registration with the public address; checked
  again on every renewal, new local address on failure), keepalive, client/server transactions with
  retransmissions, INVITE in and out, 401/407, CANCEL, BYE, re-INVITE and UPDATE (new media address, hold answered
  with `recvonly`, otherwise 488), INFO (DTMF), OPTIONS. Final responses to INVITE are retransmitted until the ACK;
  outgoing INVITEs end at the latest 77 s after the first ring. Requests within a call need FORGE's
  tag. All requests go to the phone system (it acts as outbound proxy), responses go to where the
  request came from.
- `rtp.ts`: G.711 PCMA/PCMU, 20 ms clock with silence when there is nothing to say (phone systems otherwise end calls),
  DTMF per RFC 4733, symmetric RTP: the response address is taken from the first source with the IP from the SDP or
  the phone system; after that only this address counts. Audio before the call starts is discarded.
- Not supported: TCP/TLS, SRTP, other codecs. Encrypted offers are rejected with 488.

**Speech:** OpenAI. Recognition `gpt-4o-transcribe` (`language=de`, vocabulary hints), output `gpt-4o-mini-tts` with
voice `marin`, PCM 24 kHz streamed and brought down to 8 kHz with a low-pass filter. Both models can be changed in the
settings because OpenAI replaces models (state of the docs on 2026-10-11: TTS recommends `gpt-4o-mini-tts`, STT
recommends `gpt-transcribe` with a new language parameter). Timeouts 20 s (recognition) and 45 s (output);
utterances are recognized in order.

**Conversation partner:** Claude Haiku via the Claude Code subscription (Agent SDK), its own system prompt for spoken
language, no built-in tools (`tools: []`), only FORGE tools via `createSdkMcpServer` (list in
`phone/tools.ts`, `PHONE_TOOLS`; see addendum 2026-10-13). Text is read aloud sentence by sentence as soon as a
sentence is complete. In the call, Sessions are called S1, S2 (assignment per call). Controlling tools run immediately
after the PIN. Session texts go to Claude marked as data, not as instructions. The prompt asks for one or two sentences,
no introduction, no times or abbreviations unless necessary.

Addendum 2026-10-11: confirmation via key 1 has been removed. In conversation it was too cumbersome; the user wants
to control FORGE fully and directly by phone (including Remote Control, Git, settings of a Session).

Addendum 2026-10-13: project rule "The phone can do everything FORGE can do". `phone/coverage.ts` maps every
RPC method from `protocol/src/rpc.ts` to a phone tool (`PHONE_TOOL_FOR`) or lists it with a reason as an
exception (`NOT_ON_PHONE`: browser logins, dictation, file dialogs, pure display methods, phone setup).
`test/phone-coverage.test.ts` fails as soon as a method is in neither list or a named tool is
missing. New: `project` (create, import, clone, remove, rename, favorite, profile, default model,
test and dev command), `files`, `claude_md`, `sessions` (list of all Sessions, delete, fork, rewind),
`extensions` (read MCP, skills, subagents, commands, hooks; plugins), `forge_settings`, `forge_system` (diagnostics,
updates of FORGE and Claude Code, backups); `git` can additionally do fetch, branches, delete_branch, diff, restore,
init, publish, account, identity; `finish_agent` has review; `dev_settings` sets variables of the test environment and
only names them. A few tools with `action` instead of many individual ones, because Gemini Live handles long tool lists
poorly. The new tools call the RPC handlers via `invokeHandler` (`rpc/handlers.ts`), with
the same checks and side effects as the UI. All need the PIN; phone settings cannot be restored from a backup
by phone, because that reconnects the line and ends the call.

**Call flow** (`call-controller.ts`): energy VAD with adaptive noise floor and pre-roll; while FORGE
speaks, a higher threshold applies (echo) and speech must last 240 ms before it interrupts FORGE.
Turn-taking: an utterance ends after 700 ms of silence, but the caller's turn only after another
400 ms if the last sentence sounds complete, otherwise after 2 s (no punctuation, "…", ends with "und", "weil"
etc.). Until then, input is collected and passed to Claude as one message. Claude never receives a message while
it is still writing; notices from FORGE wait as well. If the caller speaks while FORGE is talking, FORGE stops immediately.
If it was only a noise or an "Mhm", FORGE continues (restarting the sentence it had begun). Otherwise FORGE discards the
rest of the response, aborts Claude's running response (`interrupt`) and then passes on the new words. Incoming: fixed
greeting immediately, Claude answers the first request. Outgoing: Claude prepares the first sentences while it
rings; speaking only starts after pickup. Hang up after 90 s of silence or 30 min.

**Security:** see docs/SECURITY.md, section Phone. In short: allowlist for callers, PIN via DTMF for everything
controlling (not via the speech model), scrypt hash, three attempts per call, lockout after 5 failed attempts per
number or 10 in total per hour; secrets with DPAPI.

**Callbacks:** from the Session events (`turn.result`, `approval.request`, `error`). Waiting time 5 s (finished, error)
or 15 s (decision), then a renewed check whether the reason still applies (new run in progress, approval answered at
the computer). At most one call per minute, none during a call.

## Tests

Against a test phone system over real UDP (digest, NAT, calls in both directions, audio, DTMF, CANCEL, BYE) and with
real Claude as the conversation partner. Additionally with fakes: sender check, CANCEL during preparation,
error paths, hold, stale nonce, PIN lockout, turn-taking and interruption, control tools, timeouts of the
speech services. Not tested: the user's real phone system and the real
OpenAI speech services.

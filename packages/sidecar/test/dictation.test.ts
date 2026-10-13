import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "@forge/protocol";
import { DictationService, keytermHeader, type VoiceSocket } from "../src/dictation/dictation.js";

/** Plays the speech service: records what FORGE sends, `say` answers like the service does. */
class FakeSocket implements VoiceSocket {
  readyState = 0;
  sent: Array<string | Uint8Array> = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  /** answer to CloseStream; null: the service stays silent */
  onCloseStream: (() => void) | null = () => this.say({ type: "TranscriptEndpoint" });
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
    if (data === '{"type":"CloseStream"}') setTimeout(() => this.onCloseStream?.(), 0);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  say(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let credentials: string;
let sockets: FakeSocket[];
let events: ServerEvent[];
let refreshed: number;

function service(opts: { open?: boolean; refreshFails?: boolean; idleMs?: number; maxRecordingMs?: number } = {}) {
  return new DictationService({
    emit: (e) => events.push(e),
    cliVersion: async () => "2.1.296",
    refreshLogin: async () => {
      refreshed++;
      if (opts.refreshFails) throw new Error("claude exited with 1");
      writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "fresh-token", expiresAt: Date.now() + 3_600_000 } }));
    },
    idleMs: opts.idleMs,
    maxRecordingMs: opts.maxRecordingMs,
    credentialsFile: credentials,
    connect: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      if (opts.open !== false) setTimeout(() => s.open(), 0);
      return s;
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "forge-voice-"));
  credentials = path.join(dir, ".credentials.json");
  writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "token-1", expiresAt: Date.now() + 3_600_000 } }));
  sockets = [];
  events = [];
  refreshed = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("dictation over Claude's speech service", () => {
  it("streams the audio with the Claude login and returns the finished text", async () => {
    const svc = service();
    const { id } = await svc.start({ language: "de", keyterms: ["FORGE", "pnpm"] });
    const ws = sockets[0]!;
    const url = new URL(ws.url);
    expect(url.origin + url.pathname).toBe("wss://api.anthropic.com/api/ws/speech_to_text/voice_stream");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ encoding: "linear16", sample_rate: "16000", channels: "1", language: "de" });
    expect(ws.headers).toMatchObject({ Authorization: "Bearer token-1", "x-app": "cli", "x-config-keyterms": "FORGE,pnpm", "User-Agent": "claude-cli/2.1.296 (external, sdk-ts, client-app/forge)" });
    expect(ws.sent[0]).toBe('{"type":"KeepAlive"}');

    svc.audio(id, Buffer.from([1, 2, 3, 4]).toString("base64"));
    expect(ws.sent[1]).toEqual(Buffer.from([1, 2, 3, 4]));

    ws.say({ type: "TranscriptInterim", data: "Bitte die" });
    ws.say({ type: "TranscriptText", data: "Bitte die Tests ausführen." });
    ws.say({ type: "TranscriptEndpoint" });
    ws.say({ type: "TranscriptInterim", data: "Danach" });
    expect(events.at(-1)).toEqual({ event: "voice.transcript", payload: { id, text: "Bitte die Tests ausführen. Danach" } });
    ws.onCloseStream = () => {
      ws.say({ type: "TranscriptText", data: "Danach committen." });
      ws.say({ type: "TranscriptEndpoint" });
    };

    expect(await svc.stop(id)).toEqual({ text: "Bitte die Tests ausführen. Danach committen." });
    expect(ws.sent).toContain('{"type":"CloseStream"}');
    expect(ws.closed).toBe(true);
    expect(() => svc.audio(id, "AAAA")).toThrow(/schon beendet/);
  });

  it("keeps the last interim text when the service ends without an endpoint", async () => {
    const svc = service();
    const { id } = await svc.start({ language: "de", keyterms: [] });
    sockets[0]!.onCloseStream = null;
    sockets[0]!.say({ type: "TranscriptInterim", data: "Nur ein Satz" });
    expect(await svc.stop(id)).toEqual({ text: "Nur ein Satz" });
  });

  it("lets Claude Code refresh an expiring login first", async () => {
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: Date.now() + 10_000 } }));
    await service().start({ language: "de", keyterms: [] });
    expect(refreshed).toBe(1);
    expect(sockets[0]!.headers.Authorization).toBe("Bearer fresh-token");
  });

  it("refreshes the login only for a recording, not ahead of one, and does not retry a failed refresh at once", async () => {
    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: Date.now() + 10_000 } }));
    const svc = service({ refreshFails: true });
    svc.prewarm({ language: "de", keyterms: [] });
    await sleep(20);
    expect(refreshed).toBe(0);
    expect(sockets).toHaveLength(0);

    // The token still works for a few seconds; the failed refresh is not repeated on the next start.
    await svc.start({ language: "de", keyterms: [] });
    await svc.start({ language: "de", keyterms: [] });
    expect(refreshed).toBe(1);
    expect(sockets.map((s) => s.headers.Authorization)).toEqual(["Bearer old", "Bearer old"]);
    svc.shutdown();
  });

  it("drops a recording that gets no audio or runs too long", async () => {
    const svc = service({ idleMs: 60 });
    const { id } = await svc.start({ language: "de", keyterms: [] });
    for (let i = 0; i < 5; i++) {
      await sleep(25);
      svc.audio(id, "AAAA");
    }
    // Audio kept it going past the idle time; without any it goes.
    await sleep(120);
    expect(() => svc.audio(id, "AAAA")).toThrow(/schon beendet/);
    expect(sockets[0]!.closed).toBe(true);

    const long = service({ idleMs: 1_000, maxRecordingMs: 80 });
    const second = await long.start({ language: "de", keyterms: [] });
    for (let i = 0; i < 6; i++) {
      await sleep(25);
      if (i < 2) long.audio(second.id, "AAAA");
    }
    expect(() => long.audio(second.id, "AAAA")).toThrow(/schon beendet/);
    expect(sockets[1]!.closed).toBe(true);
  });

  it("explains a missing login and a refused connection", async () => {
    rmSync(credentials);
    await expect(service().start({ language: "de", keyterms: [] })).rejects.toThrow(/Anmeldung bei Claude/);

    writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: Date.now() + 3_600_000 } }));
    const svc = service({ open: false });
    const started = svc.start({ language: "de", keyterms: [] });
    // start reads the login and the CLI version before it connects.
    while (!sockets[0]?.onerror) await new Promise((r) => setTimeout(r, 1));
    sockets[0].onerror(new Error("401"));
    await expect(started).rejects.toThrow(/Keine Verbindung zum Sprachdienst/);
    expect(sockets[0]!.closed).toBe(true);
  });

  it("reports an error of the service when nothing was recognized", async () => {
    const svc = service();
    const { id } = await svc.start({ language: "de", keyterms: [] });
    sockets[0]!.say({ type: "TranscriptError", description: "audio format" });
    await expect(svc.stop(id)).rejects.toThrow(/Spracherkennung: audio format/);
  });

  it("asks for live text while the user speaks, not only at pauses", async () => {
    await service().start({ language: "de", keyterms: [] });
    expect(new URL(sockets[0]!.url).searchParams.get("forward_interims")).toBe("typed");
  });

  it("takes a prewarmed connection for the next recording with the same words", async () => {
    const svc = service();
    svc.prewarm({ language: "de", keyterms: ["FORGE"] });
    svc.prewarm({ language: "de", keyterms: ["FORGE"] });
    while (sockets[0]?.readyState !== 1) await new Promise((r) => setTimeout(r, 1));
    const { id } = await svc.start({ language: "de", keyterms: ["FORGE"] });
    expect(sockets).toHaveLength(1);
    sockets[0]!.say({ type: "TranscriptInterim", data: "Hallo" });
    expect(events.at(-1)).toEqual({ event: "voice.transcript", payload: { id, text: "Hallo" } });
    expect(await svc.stop(id)).toEqual({ text: "Hallo" });

    // Used up: the next recording connects again.
    await svc.start({ language: "de", keyterms: ["FORGE"] });
    expect(sockets).toHaveLength(2);
    svc.shutdown();
  });

  it("drops a prewarmed connection the service closed or that does not fit", async () => {
    const svc = service();
    svc.prewarm({ language: "de", keyterms: [] });
    while (sockets[0]?.readyState !== 1) await new Promise((r) => setTimeout(r, 1));
    sockets[0]!.onclose?.({ code: 1011, reason: "idle" });
    await svc.start({ language: "de", keyterms: [] });
    expect(sockets).toHaveLength(2);

    svc.prewarm({ language: "de", keyterms: [] });
    while (!sockets[2]) await new Promise((r) => setTimeout(r, 1));
    await svc.start({ language: "en", keyterms: [] });
    expect(sockets).toHaveLength(4);
    expect(sockets[2]!.closed).toBe(true);
    svc.shutdown();
  });

  it("builds the hint header like Claude Code: ASCII, no commas inside, at most 1 KB", () => {
    expect(keytermHeader(["Next.js", "Größe", "a,b", "Next.js", "  "])).toBe("Next.js,Gre,a b");
    expect(keytermHeader(Array.from({ length: 300 }, (_, i) => `term${i}`)).length).toBeLessThanOrEqual(1024);
  });
});

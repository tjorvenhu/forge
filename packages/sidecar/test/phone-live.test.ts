import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeskPhone, ledItems, provisioningText, wrapText, type DeskConfig, type DeskDeps, type DeskSession } from "../src/phone/desk-phone.js";
import { GeminiLive, Upsampler, type LiveConversation, type LiveHandlers, type SocketLike } from "../src/phone/gemini-live.js";
import { GeminiVoice } from "../src/phone/gemini-voice.js";
import { LiveCallController } from "../src/phone/live-controller.js";
import type { PinResult } from "../src/phone/pin-guard.js";
import type { RtpSession } from "../src/phone/rtp.js";
import type { ApprovalRequest } from "../src/phone/session-info.js";
import type { SipCall } from "../src/phone/sip-ua.js";
import { geminiFunctionDeclarations, runPhoneTool, type PhoneToolset } from "../src/phone/tools.js";
import { NoiseGate } from "../src/phone/vad.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T | undefined | null | false, ms = 2000, label = "condition"): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(5);
  }
}

function toolset(calls: string[] = []): PhoneToolset {
  const rec = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}:${JSON.stringify(args)}`);
    return `${name} ok`;
  };
  return {
    status: rec("status"),
    details: rec("details"),
    sendMessage: rec("sendMessage"),
    startSession: rec("startSession"),
    respond: rec("respond"),
    stop: rec("stop"),
    close: rec("close"),
    sessionSettings: rec("sessionSettings"),
    cancelAutoContinue: rec("cancelAutoContinue"),
    remote: rec("remote"),
    alwaysOnTop: rec("alwaysOnTop"),
    chatWindow: rec("chatWindow"),
    devServer: rec("devServer"),
    testDatabase: rec("testDatabase"),
    knowledge: rec("knowledge"),
    rememberNote: rec("rememberNote"),
    git: rec("git"),
    projects: rec("projects"),
    usage: rec("usage"),
    callBack: rec("callBack"),
    backgroundTask: rec("backgroundTask"),
    devSettings: rec("devSettings"),
    projectAutomation: rec("projectAutomation"),
    pullRequest: rec("pullRequest"),
    removeAgent: rec("removeAgent"),
    finishAgent: rec("finishAgent"),
    agentTeam: rec("agentTeam"),
    crew: rec("crew"),
    search: rec("search"),
    ask: rec("ask"),
    callSettings: rec("callSettings"),
    project: rec("project"),
    files: rec("files"),
    claudeMd: rec("claudeMd"),
    sessions: rec("sessions"),
    extensions: rec("extensions"),
    forgeSettings: rec("forgeSettings"),
    forgeSystem: rec("forgeSystem"),
  };
}

describe("phone tools for Gemini", () => {
  it("declares every tool with Gemini schema types", () => {
    const decls = geminiFunctionDeclarations();
    const byName = new Map(decls.map((d) => [d.name, d]));
    expect(byName.get("status")).toEqual({ name: "status", description: expect.any(String) });
    const start = byName.get("start_session")!.parameters!;
    expect(start.required).toEqual(["project", "prompt"]);
    expect(start.properties!.agent).toMatchObject({ type: "BOOLEAN" });
    const respond = byName.get("respond")!.parameters!;
    expect(respond.properties!.decision).toEqual({ type: "STRING", enum: ["allow", "deny"] });
    expect(respond.properties!.answers).toMatchObject({ type: "ARRAY", items: { type: "OBJECT", required: ["question", "answer"] } });
    expect(byName.get("hang_up")).toBeDefined();
  });

  it("runs calls from JSON, maps answers and rejects bad arguments as text", async () => {
    const calls: string[] = [];
    const t = toolset(calls);
    const ctx = { hangup: vi.fn() };
    expect(await runPhoneTool("start_session", { project: "shop", prompt: "Baue X", agent: true }, t, ctx)).toBe("startSession ok");
    expect(calls.at(-1)).toBe(`startSession:["shop","Baue X",{"agent":true}]`);
    await runPhoneTool("respond", { session: "S1", decision: "allow", answers: [{ question: "Welche DB?", answer: "SQLite" }] }, t, ctx);
    expect(calls.at(-1)).toBe(`respond:["S1","allow",{"Welche DB?":"SQLite"},null,"once"]`);
    await runPhoneTool("respond", { session: "S1", decision: "allow", for_session: true }, t, ctx);
    expect(calls.at(-1)).toBe(`respond:["S1","allow",null,null,"session"]`);
    // Project tools take a session instead of a project.
    await runPhoneTool("git", { session: "S2", action: "pull" }, t, ctx);
    expect(calls.at(-1)).toBe(`git:["","pull",{"session":"S2"}]`);
    await runPhoneTool("test_database", { project: "shop", action: "restart" }, t, ctx);
    expect(calls.at(-1)).toBe(`testDatabase:["shop","restart",{}]`);
    await runPhoneTool("background_task", { session: "S1", action: "to_background" }, t, ctx);
    expect(calls.at(-1)).toBe(`backgroundTask:["S1","to_background",null,null]`);
    await runPhoneTool("background_task", { session: "S1", action: "message", task: "auth", text: "Prüf auch Logout" }, t, ctx);
    expect(calls.at(-1)).toBe(`backgroundTask:["S1","message","auth","Prüf auch Logout"]`);
    await runPhoneTool("dev_settings", { project: "shop", port: 54400, env_var: "" }, t, ctx);
    expect(calls.at(-1)).toBe(`devSettings:["shop",{"port":54400,"envVar":""},{}]`);
    await runPhoneTool("project_automation", { session: "S2", tag: "auto-merge", on: true }, t, ctx);
    expect(calls.at(-1)).toBe(`projectAutomation:["",{"tag":"auto-merge","on":true},{"session":"S2"}]`);
    await runPhoneTool("call_settings", { done: false }, t, ctx);
    expect(calls.at(-1)).toBe(`callSettings:[{"done":false}]`);
    expect(await runPhoneTool("dev_settings", { project: "shop", port: 80 }, t, ctx)).toMatch(/^Fehler: ungültige Angaben für dev_settings/);
    await runPhoneTool("start_session", { project: "shop", prompt: "Baue Y", effort: "high" }, t, ctx);
    expect(calls.at(-1)).toBe(`startSession:["shop","Baue Y",{"effort":"high"}]`);
    expect(await runPhoneTool("respond", { session: "S1", decision: "vielleicht" }, t, ctx)).toMatch(/^Fehler: ungültige Angaben für respond/);
    expect(await runPhoneTool("rm_rf", {}, t, ctx)).toMatch(/gibt es nicht/);
    expect(await runPhoneTool("hang_up", {}, t, ctx)).toMatch(/beendet/);
    expect(ctx.hangup).toHaveBeenCalledOnce();
  });
});

class FakeSocket implements SocketLike {
  binaryType?: string;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(readonly url: string) {
    setTimeout(() => this.onopen?.({}), 0);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  serve(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function handlers(): LiveHandlers & { audio: Int16Array[]; events: string[] } {
  const h = {
    audio: [] as Int16Array[],
    events: [] as string[],
    onAudio: (pcm: Int16Array) => h.audio.push(pcm),
    onInterrupted: () => h.events.push("interrupted"),
    onTurnComplete: () => h.events.push("turnComplete"),
    onInputText: (t: string) => h.events.push(`in:${t}`),
    onOutputText: (t: string) => h.events.push(`out:${t}`),
    onToolCall: (c: unknown) => h.events.push(`tool:${JSON.stringify(c)}`),
    onToolCancel: (ids: string[]) => h.events.push(`cancel:${ids.join(",")}`),
    onError: (m: string) => h.events.push(`error:${m}`),
    log: () => {},
  };
  return h;
}

function pcmBase64(samples: number, value = 1000): string {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(value, i * 2);
  return b.toString("base64");
}

describe("Gemini Live client", () => {
  it("sets up the session, sends 16 kHz audio in chunks and turns 24 kHz speech into 8 kHz", async () => {
    const sockets: FakeSocket[] = [];
    const h = handlers();
    const live = new GeminiLive({
      apiKey: "k",
      model: "gemini-3.8-live",
      voice: "Kore",
      systemInstruction: "Du bist FORGE.",
      functionDeclarations: geminiFunctionDeclarations(),
      handlers: h,
      socket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    live.sendText("[FORGE: Begrüße]");
    const connected = live.connect();
    const ws = await until(() => sockets[0]?.sent[0] && sockets[0]);
    expect(ws.url).toContain("BidiGenerateContent?key=k");
    const setup = ws.sent[0]!.setup as Record<string, unknown>;
    expect(setup.model).toBe("models/gemini-3.8-live");
    expect(JSON.stringify(setup.generationConfig)).toContain('"voiceName":"Kore"');
    expect((setup.tools as Array<{ functionDeclarations: unknown[] }>)[0]!.functionDeclarations.length).toBeGreaterThan(10);
    expect(JSON.stringify(setup.realtimeInputConfig)).toContain('"startOfSpeechSensitivity":"START_SENSITIVITY_LOW"');
    ws.serve({ setupComplete: {} });
    await connected;
    // Text queued before the connection was ready goes out now.
    expect(ws.sent[1]).toEqual({ realtimeInput: { text: "[FORGE: Begrüße]" } });

    for (let i = 0; i < 3; i++) live.sendAudio(new Int16Array(160).fill(500));
    const audio = ws.sent.filter((m) => m.realtimeInput && (m.realtimeInput as Record<string, unknown>).audio);
    expect(audio).toHaveLength(1);
    const blob = (audio[0]!.realtimeInput as { audio: { mimeType: string; data: string } }).audio;
    expect(blob.mimeType).toBe("audio/pcm;rate=16000");
    expect(Buffer.from(blob.data, "base64").length).toBe(3 * 160 * 2 * 2);

    ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: pcmBase64(2400) } }] } } });
    await until(() => h.audio.length);
    expect(h.audio[0]!.length).toBe(800);
    ws.serve({ serverContent: { inputTranscription: { text: "Wie" } } });
    ws.serve({ toolCall: { functionCalls: [{ id: "c1", name: "status", args: {} }] } });
    ws.serve({ serverContent: { interrupted: true } });
    ws.serve({ serverContent: { turnComplete: true } });
    await until(() => h.events.includes("turnComplete"));
    expect(h.events).toEqual(["in:Wie", `tool:[{"id":"c1","name":"status","args":{}}]`, "interrupted", "turnComplete"]);

    live.sendToolResponses([{ id: "c1", name: "status", result: "Alles ruhig." }]);
    expect(ws.sent.at(-1)).toEqual({ toolResponse: { functionResponses: [{ id: "c1", name: "status", response: { result: "Alles ruhig." } }] } });
    live.close();
    expect(ws.closed).toBe(true);
  });

  it("moves to a new connection with the resumption handle when the server says goAway", async () => {
    const sockets: FakeSocket[] = [];
    const h = handlers();
    const live = new GeminiLive({
      apiKey: "k",
      model: "m",
      voice: "Kore",
      systemInstruction: "x",
      functionDeclarations: [],
      handlers: h,
      socket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const connected = live.connect();
    await until(() => sockets[0]?.sent.length);
    sockets[0]!.serve({ setupComplete: {} });
    await connected;
    sockets[0]!.serve({ sessionResumptionUpdate: { resumable: true, newHandle: "h-1" } });
    sockets[0]!.serve({ goAway: { timeLeft: "10s" } });
    const next = await until(() => sockets[1]?.sent[0] && sockets[1]);
    expect(sockets[0]!.closed).toBe(true);
    expect((next.sent[0]!.setup as Record<string, unknown>).sessionResumption).toEqual({ handle: "h-1" });
    next.serve({ setupComplete: {} });
    live.sendText("weiter");
    await until(() => next.sent.length === 2);
    expect(next.sent[1]).toEqual({ realtimeInput: { text: "weiter" } });
    expect(h.events.filter((e) => e.startsWith("error"))).toEqual([]);
    live.close();
  });

  it("reports a refused setup as an error", async () => {
    const live = new GeminiLive({
      apiKey: "bad",
      model: "m",
      voice: "Kore",
      systemInstruction: "x",
      functionDeclarations: [],
      handlers: handlers(),
      socket: (url) => {
        const s = new FakeSocket(url);
        setTimeout(() => s.onclose?.({ code: 1007, reason: "API key not valid" }), 5);
        return s;
      },
    });
    await expect(live.connect()).rejects.toThrow(/API-Key ungültig/);
  });

  it("gates noise and echo, passes clear speech with its first syllable", () => {
    const frame = (level: number) => new Int16Array(160).fill(level);
    const audible = (out: Int16Array[]) => out.filter((f) => f.some((s) => s !== 0)).length;
    const gate = new NoiseGate();
    for (let i = 0; i < 50; i++) expect(audible(gate.push(frame(150)))).toBe(0);
    // A knock: two loud frames are not speech.
    expect(audible([...gate.push(frame(3000)), ...gate.push(frame(3000)), ...gate.push(frame(150))])).toBe(0);
    // While FORGE talks, its echo and a short noise stay out.
    gate.outputActive = true;
    for (let i = 0; i < 10; i++) expect(audible(gate.push(frame(3000)))).toBe(0);
    gate.push(frame(150));
    // Talking over FORGE opens the gate; the frames held back go out first.
    let sent = 0;
    for (let i = 0; i < 12; i++) sent += audible(gate.push(frame(3000)));
    expect(sent).toBeGreaterThanOrEqual(12);
    expect(gate.passing).toBe(true);
    // Pauses between words pass, a long quiet closes the gate.
    gate.outputActive = false;
    for (let i = 0; i < 10; i++) expect(audible(gate.push(frame(150)))).toBe(1);
    for (let i = 0; i < 30; i++) gate.push(frame(150));
    expect(gate.passing).toBe(false);
    expect(audible(gate.push(frame(150)))).toBe(0);
  });

  it("upsamples 8 kHz smoothly across chunks", () => {
    const up = new Upsampler();
    expect([...up.push(Int16Array.from([100, 200]))]).toEqual([50, 100, 150, 200]);
    expect([...up.push(Int16Array.from([400]))]).toEqual([300, 400]);
  });
});

class FakeCall extends EventEmitter {
  hungUp: string | null = null;
  state = "active";
  direction = "in";
  async hangup(reason: string) {
    if (this.hungUp) return;
    this.hungUp = reason;
    this.state = "ended";
    this.emit("ended", reason);
  }
}

class FakeRtp extends EventEmitter {
  played = 0;
  cleared = 0;
  closed = false;
  playing = false;
  start() {}
  play(pcm: Int16Array) {
    this.played += pcm.length;
  }
  flush() {
    setTimeout(() => this.emit("drained"), 0);
  }
  clearPlayback() {
    this.cleared++;
  }
  close() {
    this.closed = true;
  }
}

class FakeLive implements LiveConversation {
  texts: string[] = [];
  audioIn = 0;
  /** samples that were not silence */
  audibleIn = 0;
  responses: Array<{ id: string; name: string; result: string }> = [];
  closed = false;
  constructor(readonly h: LiveHandlers) {}
  async connect() {}
  sendAudio(pcm: Int16Array) {
    this.audioIn += pcm.length;
    this.audibleIn += pcm.filter((v) => v !== 0).length;
  }
  sendText(text: string) {
    this.texts.push(text);
  }
  sendToolResponses(r: Array<{ id: string; name: string; result: string }>) {
    this.responses.push(...r);
  }
  close() {
    this.closed = true;
  }
}

function liveSetup(o: { checkPin?: ((pin: string) => Promise<PinResult>) | null; greeting?: string | null; opening?: string | null } = {}) {
  const call = new FakeCall();
  const rtp = new FakeRtp();
  const transcript: string[] = [];
  const calls: string[] = [];
  let live: FakeLive | null = null;
  let unlocked = 0;
  const ctl = new LiveCallController(call as unknown as SipCall, rtp as unknown as RtpSession, {
    createLive: (h) => (live = new FakeLive(h)),
    tools: toolset(calls),
    checkPin: o.checkPin ?? null,
    greeting: o.greeting === undefined ? "Hallo, hier ist FORGE." : o.greeting,
    opening: o.opening ?? null,
    onTranscript: (role, text) => transcript.push(`${role}:${text}`),
    onUnlock: () => (unlocked++, ""),
    log: () => {},
    timing: { hangupGraceMs: 300 },
  });
  return { call, rtp, ctl, transcript, calls, live: () => live!, unlocked: () => unlocked };
}

describe("call with Gemini Live", () => {
  it("greets, holds early speech until the call is up and passes caller audio", async () => {
    const s = liveSetup();
    s.ctl.prepare();
    expect(s.live().texts[0]).toContain("Hallo, hier ist FORGE.");
    s.live().h.onAudio(new Int16Array(160));
    expect(s.rtp.played).toBe(0);
    s.ctl.begin();
    expect(s.rtp.played).toBe(160);
    s.rtp.emit("audio", new Int16Array(160));
    expect(s.live().audioIn).toBe(160);
    s.ctl.dispose();
  });

  it("runs tool calls and answers with their results; withdrawn calls get no answer", async () => {
    const s = liveSetup();
    s.ctl.begin();
    s.live().h.onToolCall([
      { id: "a", name: "status", args: {} },
      { id: "b", name: "git", args: { project: "shop", action: "status" } },
    ]);
    await until(() => s.live().responses.length === 2);
    expect(s.live().responses).toEqual([
      { id: "a", name: "status", result: "status ok" },
      { id: "b", name: "git", result: "git ok" },
    ]);
    s.live().h.onToolCancel(["c"]);
    s.live().h.onToolCall([{ id: "c", name: "status", args: {} }]);
    await sleep(20);
    expect(s.live().responses).toHaveLength(2);
    s.ctl.dispose();
  });

  it("collects speech before playing it, so the line does not run dry", async () => {
    const s = liveSetup();
    s.ctl.begin();
    s.live().h.onAudio(new Int16Array(800));
    expect(s.rtp.played).toBe(0);
    s.live().h.onAudio(new Int16Array(800));
    expect(s.rtp.played).toBe(1600);
    s.live().h.onAudio(new Int16Array(400));
    s.live().h.onTurnComplete();
    expect(s.rtp.played).toBe(2000);
    s.live().h.onAudio(new Int16Array(400));
    s.live().h.onInterrupted();
    s.live().h.onTurnComplete();
    expect(s.rtp.played).toBe(2000);
    s.ctl.dispose();
  });

  it("keeps noise and echo on the line from Gemini while FORGE talks", async () => {
    const s = liveSetup();
    s.ctl.begin();
    const loud = () => new Int16Array(160).fill(3000);
    s.rtp.playing = true;
    for (let i = 0; i < 8; i++) s.rtp.emit("audio", loud());
    expect(s.live().audioIn).toBe(8 * 160);
    expect(s.live().audibleIn).toBe(0);
    for (let i = 0; i < 12; i++) s.rtp.emit("audio", loud());
    expect(s.live().audibleIn).toBeGreaterThan(0);
    s.ctl.dispose();
  });

  it("drops queued speech on barge-in and keeps a transcript per turn", async () => {
    const s = liveSetup();
    s.ctl.begin();
    s.live().h.onOutputText("Hallo, hier ");
    s.live().h.onOutputText("ist FORGE.");
    s.live().h.onInputText("Wie steht ");
    s.live().h.onInputText("der Shop?");
    s.live().h.onInterrupted();
    expect(s.rtp.cleared).toBe(1);
    s.live().h.onOutputText("Läuft.");
    s.live().h.onTurnComplete();
    expect(s.transcript).toEqual(["forge:Hallo, hier ist FORGE.", "caller:Wie steht der Shop?", "forge:Läuft."]);
    s.ctl.dispose();
  });

  it("hangs up after hang_up once the goodbye is spoken", async () => {
    const s = liveSetup();
    s.ctl.begin();
    s.live().h.onToolCall([{ id: "h", name: "hang_up", args: {} }]);
    await until(() => s.live().responses.length);
    s.live().h.onAudio(new Int16Array(160));
    s.live().h.onTurnComplete();
    await until(() => s.call.hungUp, 2000, "hung up");
    expect(s.live().closed).toBe(true);
  });

  it("unlocks steering with the PIN over the keypad and tells Gemini", async () => {
    const s = liveSetup({ checkPin: async (pin) => (pin === "4711" ? "ok" : "wrong") });
    s.ctl.begin();
    for (const d of "0000#") s.rtp.emit("dtmf", d);
    await until(() => s.live().texts.some((t) => t.includes("PIN ist falsch")));
    expect(s.ctl.unlocked).toBe(false);
    for (const d of "4711#") s.rtp.emit("dtmf", d);
    await until(() => s.ctl.unlocked);
    expect(s.unlocked()).toBe(1);
    expect(s.live().texts.at(-1)).toMatch(/PIN richtig/);
    s.ctl.dispose();
  });

  it("hangs up with a tone when Gemini is not reachable", async () => {
    const s = liveSetup();
    s.ctl.begin();
    s.live().h.onError("Gemini Live: API-Key ungültig.");
    await until(() => s.call.hungUp, 2000, "hung up");
    expect(s.call.hungUp).toMatch(/Gemini/);
  });
});

describe("Gemini speech for Claude calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("transcribes with generateContent and speaks 24 kHz audio at 8 kHz", async () => {
    const bodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push({ url, body });
      if (JSON.stringify(body).includes("AUDIO")) {
        // Server-sent events as Gemini sends them: CRLF, one audio piece per event; one piece ends on an odd byte.
        const odd = Buffer.from(pcmBase64(12_000), "base64");
        const event = (b: Buffer) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/l16; rate=24000", data: b.toString("base64") } }] } }] })}\r\n\r\n`;
        return new Response(event(odd.subarray(0, 12_001)) + event(odd.subarray(12_001)) + event(Buffer.from(pcmBase64(12_000), "base64")), { status: 200 });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: " Starte den  Build. " }] } }] }), { status: 200 });
    });
    const v = new GeminiVoice("key", { voice: "Kore", sttModel: "gemini-3.5-flash-lite", ttsModel: "gemini-3.8-flash-tts" });
    expect(await v.transcribe(new Int16Array(800))).toBe("Starte den Build.");
    expect(bodies[0]!.url).toContain("models/gemini-3.5-flash-lite:generateContent");
    let samples = 0;
    for await (const c of v.speak("Erledigt.", new AbortController().signal)) samples += c.length;
    expect(samples).toBe(8000);
    expect(bodies[1]!.url).toContain("models/gemini-3.8-flash-tts:streamGenerateContent?alt=sse");
    expect(JSON.stringify(bodies[1]!.body)).toContain('"voiceName":"Kore"');
  });

  it("names an invalid key", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 }));
    const v = new GeminiVoice("bad", { voice: "Kore", sttModel: "m", ttsModel: "t" });
    await expect(v.transcribe(new Int16Array(10))).rejects.toThrow(/Gemini-API-Key ungültig/);
  });
});

describe("desk phone (Yealink)", () => {
  const cfg = (o: Partial<DeskConfig> = {}): DeskConfig => ({
    phoneIp: "127.0.0.1",
    localIp: "127.0.0.1",
    httpPort: 0,
    webUser: "admin",
    webPassword: "secret",
    sessionKeys: [1, 2],
    clearKeys: [],
    leds: true,
    hotline: true,
    display: "lines",
    forgeNumber: "77",
    token: "tok",
    ...o,
  });

  it("writes provisioning with session keys, hotline and push rights", () => {
    const text = provisioningText(cfg({ httpPort: 8766 }), ["Warenkorb", "-"]);
    expect(text).toContain("push_xml.server = 127.0.0.1");
    expect(text).toContain("features.hotline_number = 77");
    expect(text).toContain("linekey.1.type = 27");
    expect(text).toContain("linekey.1.value = http://127.0.0.1:8766/desk/tok/key/1");
    expect(text).toContain("linekey.1.label = Warenkorb");
    expect(text).toContain("linekey.2.label = -");
    expect(text).toContain("action_url.call_established = \n");
    expect(provisioningText(cfg({ hotline: false }), [])).toContain("features.hotline_number = \n");
    // Leftover keys (an earlier setup had its own functions on 5 to 8) become "not used".
    const cleared = provisioningText(cfg({ clearKeys: [2, 5, 6] }), []);
    expect(cleared).toContain("linekey.5.type = 0\nlinekey.5.value = \nlinekey.5.label = ");
    expect(cleared).toContain("linekey.6.type = 0");
    expect(cleared).not.toContain("linekey.2.type = 0");
  });

  it("builds LED commands and wraps display text", () => {
    expect(ledItems(3, "red-fast")).toContain('Led:LINE3_RED=fastflash');
    expect(ledItems(3, "off")).not.toContain("=on");
    expect(wrapText("eins zwei drei vier fünf", 9, 2)).toEqual(["eins zwei", "drei…"]);
  });

  function desk(sessions: DeskSession[], o: Partial<DeskDeps> = {}) {
    const requests: Array<{ url: string; method: string; body: string; auth: string | null }> = [];
    const responded: string[] = [];
    const keys: string[] = [];
    let pending: ApprovalRequest | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      requests.push({ url, method: String(init.method), body: String(init.body ?? ""), auth });
      // The phone wants Digest, like the web login of a Yealink.
      if (!auth) return new Response("", { status: 401, headers: { "www-authenticate": 'Digest realm="yealink", nonce="n1", qop="auth"' } });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const d = new DeskPhone({
      listSessions: () => sessions,
      pending: () => pending,
      lastAnswer: () => "Der Build ist durch und alle Tests laufen.",
      respond: (id, r, decision) => responded.push(`${id}:${r}:${decision}`),
      call: () => ({ active: false, sessionId: null }),
      onKeyInCall: (id) => keys.push(id),
      onReachability: () => {},
      log: () => {},
      fetch: fetchFn,
      timing: { debounceMs: 0, labelsDelayMs: 0 },
      ...o,
    });
    return { d, requests, responded, keys, setPending: (p: ApprovalRequest | null) => (pending = p) };
  }

  const session = (id: string, status: DeskSession["status"], title: string): DeskSession => ({ id, title, status, projectName: "shop", updatedAt: new Date().toISOString() });

  it("pushes LEDs and display with Digest login and reloads labels when sessions change", async () => {
    const sessions = [session("s1", "running", "Warenkorb")];
    const t = desk(sessions);
    await t.d.start(cfg());
    await until(() => t.requests.some((r) => r.auth && r.body.includes("LINE1_ORANGE=slowflash")), 2000, "LEDs");
    const led = t.requests.find((r) => r.auth && r.body.includes("LINE1_ORANGE"))!;
    expect(led.url).toBe("http://127.0.0.1/servlet?push=xml");
    expect(led.auth).toMatch(/^Digest username="admin", realm="yealink"/);
    expect(t.requests.some((r) => r.body.includes("Warenkorb · arbeitet"))).toBe(true);
    // FORGE restarted: the phone reloads its keys once.
    await until(() => t.requests.some((r) => r.url.endsWith("key=AutoP")), 2000, "AutoP");
    expect(t.d.reachable).toBe(true);

    sessions[0] = { ...sessions[0]!, status: "idle" };
    t.d.markUnheard("s1");
    await until(() => t.requests.some((r) => r.body.includes("LINE1_GREEN=slowflash")), 2000, "unheard LED");
    expect(t.requests.some((r) => r.body.includes("Led:POWER=on"))).toBe(true);
    await t.d.stop();
  });

  it("answers only the phone, with the token; keys select a session and start a call", async () => {
    const t = desk([session("s1", "idle", "Warenkorb"), session("s2", "waiting_approval", "Login")]);
    await t.d.start(cfg());
    const base = t.d.provisioningUrl!.replace(/prov\/$/, "");
    expect((await fetch(`${base.replace("/tok/", "/falsch/")}key/1`)).status).toBe(404);
    const prov = await fetch(`${base}prov/y000000000095.cfg`);
    expect(await prov.text()).toContain("linekey.2.label = Login");
    expect((await fetch(`${base}prov/y000000000095.boot`)).status).toBe(404);

    const res = await fetch(`${base}key/2`);
    expect(await res.text()).toContain("YealinkIPPhoneTextScreen");
    expect(t.d.takePickup()).toBe("s2");
    expect(t.d.takePickup()).toBeNull();
    await until(() => t.requests.some((r) => r.url.endsWith("key=number=77")), 2000, "dial");
    await t.d.stop();
  });

  it("refuses requests from other addresses", async () => {
    const t = desk([]);
    await t.d.start(cfg({ phoneIp: "192.0.2.10" }));
    expect((await fetch(`${t.d.provisioningUrl!}y.cfg`)).status).toBe(403);
    await t.d.stop();
  });

  it("shows tool approvals as a menu and answers them from the phone", async () => {
    const t = desk([session("s1", "waiting_approval", "Deploy")]);
    t.setPending({ type: "approval.request", requestId: "r1", toolName: "Bash", input: { command: "npm publish" } } as unknown as ApprovalRequest);
    await t.d.start(cfg());
    const menu = await until(() => t.requests.find((r) => r.auth && r.body.includes("YealinkIPPhoneTextMenu")), 2000, "menu");
    expect(menu.body).toContain("Bash: npm publish");
    const base = t.d.provisioningUrl!.replace(/prov\/$/, "");
    await fetch(`${base}answer?s=s1&r=r1&d=allow`);
    expect(t.responded).toEqual(["s1:r1:allow"]);
    // A stale menu (already answered at the desk) does nothing.
    await fetch(`${base}answer?s=s1&r=old&d=deny`);
    expect(t.responded).toHaveLength(1);
    await t.d.stop();
  });

  it("passes a key pressed during a call to the conversation", async () => {
    const t = desk([session("s1", "idle", "Warenkorb")], { call: () => ({ active: true, sessionId: null }) });
    await t.d.start(cfg());
    const base = t.d.provisioningUrl!.replace(/prov\/$/, "");
    await fetch(`${base}key/1`);
    expect(t.keys).toEqual(["s1"]);
    expect(t.d.takePickup()).toBeNull();
    await t.d.stop();
  });
});

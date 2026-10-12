/**
 * Smoke test against the real Gemini Live API (needs GEMINI_API_KEY): connects with FORGE's setup,
 * asks for the status (expects a function call), answers it and waits for spoken audio.
 *
 *   pnpm tsx scripts/gemini-live-smoke.ts [model]
 */
import { GeminiLive } from "../src/phone/gemini-live.js";
import { geminiFunctionDeclarations, phoneSystemPrompt } from "../src/phone/tools.js";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY fehlt");
  process.exit(2);
}
const model = process.argv[2] ?? "gemini-3.8-live";
let audio = 0;
const said: string[] = [];
const tools: string[] = [];
let turns = 0;
let failed: string | null = null;

const live = new GeminiLive({
  apiKey: key,
  model,
  voice: "Kore",
  systemInstruction: `${phoneSystemPrompt("voice")}\n\nHeute ist ein Test.`,
  functionDeclarations: geminiFunctionDeclarations(),
  handlers: {
    onAudio: (pcm) => (audio += pcm.length),
    onInterrupted: () => console.log("· interrupted"),
    onTurnComplete: () => {
      turns++;
      console.log(`· turnComplete (${(audio / 8000).toFixed(1)} s Audio bisher)`);
    },
    onInputText: () => {},
    onOutputText: (t) => said.push(t),
    onToolCall: (calls) => {
      for (const c of calls) {
        tools.push(`${c.name}(${JSON.stringify(c.args)})`);
        console.log(`· toolCall ${c.name} ${JSON.stringify(c.args)}`);
      }
      live.sendToolResponses(calls.map((c) => ({ id: c.id, name: c.name, result: "S1: Warenkorb-Export im Projekt shop, fertig, wartet auf Anweisungen." })));
    },
    onToolCancel: () => {},
    onError: (m) => (failed = m),
    log: (m) => console.log(`· ${m}`),
  },
});

const started = Date.now();
await live.connect();
console.log(`verbunden mit ${model} nach ${Date.now() - started} ms`);
live.sendText("Wie ist der Stand meiner Sessions?");
const end = Date.now() + 30_000;
while (Date.now() < end && !failed && !(tools.length && turns >= 2 && audio > 0 && said.length)) await new Promise((r) => setTimeout(r, 100));
live.close();
console.log(`Werkzeuge: ${tools.join(", ") || "keine"}`);
console.log(`Gesagt: ${said.join("").trim() || "(keine Transkription)"}`);
console.log(`Audio: ${(audio / 8000).toFixed(1)} s bei 8 kHz`);
if (failed) {
  console.error(`FEHLER: ${failed}`);
  process.exit(1);
}
process.exit(tools.length && audio > 0 ? 0 : 1);

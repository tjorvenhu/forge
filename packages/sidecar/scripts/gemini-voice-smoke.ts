/**
 * Smoke test of Gemini speech for Claude calls (needs GEMINI_API_KEY): speaks a sentence at phone
 * quality and transcribes it again.
 *
 *   pnpm tsx scripts/gemini-voice-smoke.ts
 */
import { DEFAULT_GEMINI_STT_MODEL, DEFAULT_GEMINI_TTS_MODEL, GeminiVoice } from "../src/phone/gemini-voice.js";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("GEMINI_API_KEY fehlt");
  process.exit(2);
}
const v = new GeminiVoice(key, { voice: "Kore", sttModel: DEFAULT_GEMINI_STT_MODEL, ttsModel: DEFAULT_GEMINI_TTS_MODEL });
const text = "Der Build ist durch, die Session wartet auf deine Freigabe.";
let t = Date.now();
const chunks: Int16Array[] = [];
for await (const c of v.speak(text, new AbortController().signal)) chunks.push(c);
const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
let off = 0;
for (const c of chunks) {
  pcm.set(c, off);
  off += c.length;
}
console.log(`Sprachausgabe: ${(pcm.length / 8000).toFixed(1)} s Audio in ${Date.now() - t} ms`);
t = Date.now();
const heard = await v.transcribe(pcm);
console.log(`Erkannt in ${Date.now() - t} ms: ${heard}`);
process.exit(heard ? 0 : 1);

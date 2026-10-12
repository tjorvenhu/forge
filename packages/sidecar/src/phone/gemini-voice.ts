import { bytesToPcm, Downsampler, pcmToWav } from "./audio.js";
import { SPEAK_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS, type VoiceProvider } from "./voice.js";

export const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_STT_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
export const DEFAULT_GEMINI_VOICE = "Kore";

/** PCM from Gemini speech is 24 kHz; the phone line is 8 kHz. */
const TTS_RATE_FACTOR = 3;
const TTS_GAIN = 0.8;
const TRANSCRIBE_PROMPT =
  "Schreib wörtlich auf, was in dieser Telefonaufnahme gesagt wird, auf Deutsch. Nur den gesprochenen Text, ohne Anmerkungen. " +
  "Fachbegriffe: FORGE, Claude, Session, Build, Test, Commit, Branch, Pull Request, Deploy, Dev-Server, Freigabe, Plan, Projekt, Agent, Worktree. " +
  "Ist nichts Verständliches zu hören, antworte mit einer leeren Zeile.";

interface GenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> } }>;
}

/**
 * Speech recognition and speech output over the Gemini API, for calls where Claude leads the
 * conversation. The same key also serves Gemini Live.
 */
export class GeminiVoice implements VoiceProvider {
  constructor(
    private readonly apiKey: string,
    private readonly o: { voice: string; sttModel: string; ttsModel: string; timeouts?: { transcribeMs?: number; speakMs?: number } },
  ) {}

  async transcribe(pcm: Int16Array, signal?: AbortSignal): Promise<string> {
    const json = await this.generate(
      this.o.sttModel,
      {
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: pcmToWav(pcm).toString("base64") } }, { text: TRANSCRIBE_PROMPT }] }],
        generationConfig: { temperature: 0 },
      },
      withTimeout(signal, this.o.timeouts?.transcribeMs ?? TRANSCRIBE_TIMEOUT_MS),
      signal,
      "Spracherkennung",
    );
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * Streams speech (server-sent events): the first audio comes after well under a second instead of
   * after the whole sentence is synthesized.
   */
  async *speak(text: string, signal: AbortSignal): AsyncIterable<Int16Array> {
    const limit = withTimeout(signal, this.o.timeouts?.speakMs ?? SPEAK_TIMEOUT_MS);
    let got = false;
    try {
      const res = await fetch(`${GEMINI_API}/models/${encodeURIComponent(this.o.ttsModel)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          // Only the text: style instructions in the prompt are sometimes read out as well.
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voice } } } },
        }),
        signal: limit,
      });
      if (!res.ok || !res.body) throw new Error(await geminiError(res, "Sprachausgabe"));
      const down = new Downsampler(TTS_RATE_FACTOR);
      let pending = "";
      let rest: Uint8Array = new Uint8Array(0);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (limit.aborted) return;
        pending += Buffer.from(chunk).toString("utf8");
        const events = pending.split(/\r?\n\r?\n/);
        pending = events.pop() ?? "";
        for (const ev of events) {
          const data = audioOf(ev);
          if (!data) continue;
          const joined = Buffer.concat([rest, Buffer.from(data, "base64")]);
          const { samples, rest: r } = bytesToPcm(joined);
          rest = r;
          if (!samples.length) continue;
          got = true;
          yield down.push(samples.map((s) => Math.round(s * TTS_GAIN)));
        }
      }
      if (!got && !limit.aborted) throw new Error("Sprachausgabe: Gemini hat kein Audio geliefert.");
    } catch (e) {
      if (signal.aborted) return;
      if (limit.aborted) throw new Error("Sprachausgabe: Gemini antwortet nicht rechtzeitig.", { cause: e });
      throw e;
    }
  }

  private async generate(model: string, body: unknown, limit: AbortSignal, outer: AbortSignal | undefined, what: string): Promise<GenerateResponse> {
    try {
      const res = await fetch(`${GEMINI_API}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: limit,
      });
      if (!res.ok) throw new Error(await geminiError(res, what));
      return (await res.json()) as GenerateResponse;
    } catch (e) {
      if (limit.aborted && !outer?.aborted) throw new Error(`${what}: Gemini antwortet nicht rechtzeitig.`, { cause: e });
      throw e;
    }
  }
}

/** The base64 audio of one server-sent event, if it carries any. */
function audioOf(event: string): string | null {
  const line = event.split(/\r?\n/).find((l) => l.startsWith("data:"));
  if (!line) return null;
  try {
    const j = JSON.parse(line.slice(5)) as GenerateResponse & { error?: { message?: string } };
    if (j.error) throw new Error(`Sprachausgabe: ${j.error.message ?? "Fehler"}`);
    return j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data ?? null;
  } catch (e) {
    if (e instanceof SyntaxError) return null;
    throw e;
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function geminiError(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    detail = j.error?.message ?? "";
  } catch {
    /* no JSON body */
  }
  if (res.status === 400 && /api key/i.test(detail)) return `${what}: Gemini-API-Key ungültig.`;
  if (res.status === 401 || res.status === 403) return `${what}: Gemini-API-Key ungültig oder ohne Zugriff.`;
  if (res.status === 429) return `${what}: Gemini-Limit erreicht oder kein Guthaben.`;
  if (res.status === 404) return `${what}: Gemini-Modell nicht gefunden${detail ? ` (${detail})` : ""}.`;
  return `${what} fehlgeschlagen (${res.status})${detail ? `: ${detail}` : ""}`;
}

import { bytesToPcm, Downsampler, pcmToWav } from "./audio.js";

/** Speech recognition and speech output for calls. Audio is 8 kHz 16-bit mono PCM. */
export interface VoiceProvider {
  transcribe(pcm: Int16Array): Promise<string>;
  /** speaks text; yields audio as it arrives, stops when the signal aborts */
  speak(text: string, signal: AbortSignal): AsyncIterable<Int16Array>;
}

export const DEFAULT_STT_MODEL = "gpt-4o-transcribe";
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_VOICE = "marin";
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];

const API = "https://api.openai.com/v1";
/** PCM from the speech endpoint is 24 kHz; the phone line is 8 kHz. */
const TTS_RATE_FACTOR = 3;
/**
 * The speech endpoint delivers audio close to full scale; the low-pass filter overshoots a little on
 * top of that. Without headroom peaks are clipped, which is heard as crackling on loud syllables.
 */
const TTS_GAIN = 0.8;
/** Words Claude Code users say on the phone that a generic model tends to mishear. */
const VOCABULARY = "FORGE, Claude, Session, Commit, Branch, Pull Request, Deploy, Dev-Server, Freigabe, Plan, Projekt";

export class OpenAiVoice implements VoiceProvider {
  constructor(
    private readonly apiKey: string,
    private readonly o: { voice: string; sttModel: string; ttsModel: string },
  ) {}

  async transcribe(pcm: Int16Array): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pcmToWav(pcm))], { type: "audio/wav" }), "anruf.wav");
    form.append("model", this.o.sttModel);
    // gpt-transcribe takes a list of languages instead; without a hint it detects the language itself.
    if (!this.o.sttModel.startsWith("gpt-transcribe")) form.append("language", "de");
    form.append("prompt", VOCABULARY);
    form.append("response_format", "json");
    const res = await fetch(`${API}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form });
    if (!res.ok) throw new Error(await apiError(res, "Spracherkennung"));
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }

  async *speak(text: string, signal: AbortSignal): AsyncIterable<Int16Array> {
    const res = await fetch(`${API}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: this.o.ttsModel,
        voice: this.o.voice,
        input: text,
        response_format: "pcm",
        instructions: "Sprich natürliches Deutsch, freundlich, zügig und klar, wie am Telefon.",
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(await apiError(res, "Sprachausgabe"));
    const down = new Downsampler(TTS_RATE_FACTOR);
    let rest: Uint8Array = new Uint8Array(0);
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (signal.aborted) return;
      const joined = new Uint8Array(rest.length + chunk.length);
      joined.set(rest);
      joined.set(chunk, rest.length);
      const { samples, rest: r } = bytesToPcm(joined);
      rest = r;
      if (samples.length) yield down.push(samples.map((s) => Math.round(s * TTS_GAIN)));
    }
  }
}

async function apiError(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    detail = j.error?.message ?? "";
  } catch {
    /* no JSON body */
  }
  if (res.status === 401) return `${what}: OpenAI-API-Key ungültig.`;
  if (res.status === 429) return `${what}: OpenAI-Limit erreicht oder kein Guthaben.`;
  return `${what} fehlgeschlagen (${res.status})${detail ? `: ${detail}` : ""}`;
}

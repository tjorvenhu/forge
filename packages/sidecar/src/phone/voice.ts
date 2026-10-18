import { PHONE_VOICES } from "@forge/protocol";
import { tr } from "../i18n/index.js";
import { bytesToPcm, Downsampler, pcmToWav } from "./audio.js";

/** Speech recognition and speech output for calls. Audio is 8 kHz 16-bit mono PCM. */
export interface VoiceProvider {
  /** stops when the signal aborts (call ended) */
  transcribe(pcm: Int16Array, signal?: AbortSignal): Promise<string>;
  /** speaks text; yields audio as it arrives, stops when the signal aborts */
  speak(text: string, signal: AbortSignal): AsyncIterable<Int16Array>;
}

export const DEFAULT_STT_MODEL = "gpt-4o-transcribe";
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_VOICE: string = PHONE_VOICES[0];

/** Upper limits for one request; a stalled connection must not leave the caller in silence. */
export const TRANSCRIBE_TIMEOUT_MS = 20_000;
export const SPEAK_TIMEOUT_MS = 45_000;

const API = "https://api.openai.com/v1";
/** PCM from the speech endpoint is 24 kHz; the phone line is 8 kHz. */
const TTS_RATE_FACTOR = 3;
/**
 * The speech endpoint delivers audio close to full scale; the low-pass filter overshoots a little on
 * top of that. Without headroom peaks are clipped, which is heard as crackling on loud syllables.
 */
const TTS_GAIN = 0.8;

export class OpenAiVoice implements VoiceProvider {
  private readonly timeouts: { transcribeMs: number; speakMs: number };

  constructor(
    private readonly apiKey: string,
    private readonly o: { voice: string; sttModel: string; ttsModel: string; timeouts?: { transcribeMs?: number; speakMs?: number } },
  ) {
    this.timeouts = { transcribeMs: o.timeouts?.transcribeMs ?? TRANSCRIBE_TIMEOUT_MS, speakMs: o.timeouts?.speakMs ?? SPEAK_TIMEOUT_MS };
  }

  async transcribe(pcm: Int16Array, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pcmToWav(pcm))], { type: "audio/wav" }), "anruf.wav");
    form.append("model", this.o.sttModel);
    // gpt-transcribe takes a list of languages instead; without a hint it detects the language itself.
    if (!this.o.sttModel.startsWith("gpt-transcribe")) form.append("language", tr().phone.voice.sttLanguage);
    form.append("prompt", tr().phone.voice.vocabulary);
    form.append("response_format", "json");
    const limit = withTimeout(signal, this.timeouts.transcribeMs);
    try {
      const res = await fetch(`${API}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: limit });
      if (!res.ok) throw new Error(await apiError(res, tr().phone.voice.stt));
      const json = (await res.json()) as { text?: string };
      return (json.text ?? "").trim();
    } catch (e) {
      throw timeoutError(e, limit, signal, tr().phone.voice.stt);
    }
  }

  async *speak(text: string, signal: AbortSignal): AsyncIterable<Int16Array> {
    const limit = withTimeout(signal, this.timeouts.speakMs);
    try {
      const res = await fetch(`${API}/audio/speech`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.o.ttsModel,
          voice: this.o.voice,
          input: text,
          response_format: "pcm",
          instructions: tr().phone.voice.ttsInstructions,
        }),
        signal: limit,
      });
      if (!res.ok || !res.body) throw new Error(await apiError(res, tr().phone.voice.tts));
      const down = new Downsampler(TTS_RATE_FACTOR);
      let rest: Uint8Array = new Uint8Array(0);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (limit.aborted) return;
        const joined = new Uint8Array(rest.length + chunk.length);
        joined.set(rest);
        joined.set(chunk, rest.length);
        const { samples, rest: r } = bytesToPcm(joined);
        rest = r;
        if (samples.length) yield down.push(samples.map((s) => Math.round(s * TTS_GAIN)));
      }
    } catch (e) {
      if (signal.aborted) return;
      throw timeoutError(e, limit, signal, tr().phone.voice.tts);
    }
  }
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** A timeout reads better than "This operation was aborted". */
function timeoutError(e: unknown, limit: AbortSignal, outer: AbortSignal | undefined, what: string): unknown {
  if (limit.aborted && !outer?.aborted) return new Error(tr().phone.voice.openAiTimeout(what));
  return e;
}

async function apiError(res: Response, what: string): Promise<string> {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    detail = j.error?.message ?? "";
  } catch {
    /* no JSON body */
  }
  if (res.status === 401) return tr().phone.voice.openAiKeyInvalid(what);
  if (res.status === 429) return tr().phone.voice.openAiLimit(what);
  return tr().phone.voice.failed(what, res.status, detail);
}

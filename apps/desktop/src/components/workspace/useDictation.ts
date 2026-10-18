import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/queries";
import { errorMessage, rpc } from "@/lib/rpc";
import { useDictationActivity } from "@/stores/dictation";
import { toast } from "@/stores/toast";

/** What Claude's speech service expects; Chromium resamples the microphone to it. */
const RATE = 16_000;
const BLOCK = 2048;
/** The sidecar keeps a prewarmed connection for a minute and extends it on every prewarm. */
const PREWARM_EVERY_MS = 15_000;

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

interface Recording {
  /** the start() it came from; an older one never resets the state of a newer one */
  gen: number;
  stream: MediaStream;
  ctx: AudioContext;
  proc: ScriptProcessorNode;
  /** stream id in the sidecar; blocks recorded before it is known wait in `queue` */
  id: string | null;
  queue: string[];
  samples: number;
  /** resolves with the id once the connection is open, null when it failed */
  ready: Promise<string | null>;
  cancelled: boolean;
}

/** A start() still waiting for the microphone. */
interface Starting {
  gen: number;
  /** stop or cancel asked for meanwhile (space released early, Esc); done once the microphone runs */
  early: "stop" | "cancel" | null;
  /** resolves once this start has its recording or gave up */
  done: Promise<void>;
}

/**
 * Dictation for the composer over Claude's speech service (the one of /voice in the terminal): the
 * microphone streams to the sidecar, `live` is what was understood so far (the service still corrects
 * it), and `onText` gets the finished text when the recording is stopped.
 */
export function useDictation(onText: (text: string) => void, keyterms: string[]) {
  const [state, setState] = useState<DictationState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [live, setLive] = useState("");
  const rec = useRef<Recording | null>(null);
  const starting = useRef<Starting | null>(null);
  /** counts starts */
  const gen = useRef(0);
  const mounted = useRef(true);
  const deliver = useRef(onText);
  const terms = useRef(keyterms);
  useEffect(() => {
    deliver.current = onText;
    terms.current = keyterms;
  }, [onText, keyterms]);

  // Dialogs that open on their own wait until the recording is transcribed.
  const busy = state !== "idle";
  useEffect(() => (busy ? useDictationActivity.getState().hold() : undefined), [busy]);

  // Live text of the own recording only.
  useEffect(
    () =>
      rpc.subscribe((e) => {
        if (e.event === "voice.transcript" && e.payload.id === rec.current?.id) setLive(e.payload.text);
      }),
    [],
  );

  const teardown = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (!r) return null;
    r.proc.onaudioprocess = null;
    r.proc.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => {});
    return r;
  }, []);

  const stop = useCallback(async () => {
    const r = teardown();
    if (!r) {
      if (starting.current && !starting.current.early) starting.current.early = "stop";
      return;
    }
    setState("transcribing");
    try {
      // Stopped before the connection was open: the queued words go out first.
      const id = r.id ?? (await r.ready);
      if (!id) throw new Error("Keine Verbindung zum Sprachdienst von Claude.");
      for (const pcm of r.queue.splice(0)) void call("voice.audio", { id, pcm }).catch(() => {});
      const { text } = await call("voice.stop", { id });
      // The composer may be gone by now (other session opened); it still puts the text into its draft.
      if (text) deliver.current(text);
      else if (mounted.current) toast.info("Nichts erkannt", "In der Aufnahme war keine Sprache zu hören.");
    } catch (e) {
      toast.error("Spracheingabe fehlgeschlagen", errorMessage(e));
    } finally {
      if (gen.current === r.gen) {
        setState("idle");
        setLive("");
      }
    }
  }, [teardown]);

  const cancel = useCallback(() => {
    const r = teardown();
    if (!r && starting.current) starting.current.early = "cancel";
    if (r) r.cancelled = true;
    if (r?.id) void call("voice.cancel", { id: r.id }).catch(() => {});
    setState("idle");
    setLive("");
  }, [teardown]);

  /** A recording is likely (composer focused, space down): the connection opens now, not at the first word. */
  const warmedAt = useRef(0);
  const prewarm = useCallback(() => {
    if (rec.current || Date.now() - warmedAt.current < PREWARM_EVERY_MS) return;
    warmedAt.current = Date.now();
    void call("voice.prewarm", { language: "de", keyterms: terms.current }).catch(() => {});
  }, []);

  const start = useCallback(async () => {
    if (rec.current) return;
    const prev = starting.current;
    // Only a start the user discarded (Esc, then space again) may be overtaken, and it lets go of the microphone first.
    if (prev && prev.early !== "cancel") return;
    let settle!: () => void;
    const me: Starting = { gen: ++gen.current, early: null, done: new Promise<void>((r) => (settle = r)) };
    starting.current = me;
    const leave = () => {
      settle();
      if (starting.current === me) starting.current = null;
    };
    const latest = () => gen.current === me.gen;
    // The recording uses up the prewarmed connection.
    warmedAt.current = 0;
    setState("starting");
    setSeconds(0);
    setLive("");
    // The connection opens while the microphone starts; the first words are queued, not lost.
    const opening = call("voice.start", { language: "de", keyterms: terms.current });
    opening.catch(() => {});
    const dropOpening = () => void opening.then(({ id }) => call("voice.cancel", { id })).catch(() => {});
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let r: Recording | null = null;
    try {
      if (prev) await prev.done;
      // Raw voice like Claude Code records it: Chromium's noise suppression and echo cancellation cut
      // word starts and quiet syllables, which the recognizer then guesses wrong.
      if (mounted.current && me.early !== "cancel")
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } });
      // Windows may take a moment to grant the microphone; the composer can be gone by then.
      if (!stream || !mounted.current || me.early === "cancel") {
        stream?.getTracks().forEach((t) => t.stop());
        dropOpening();
        if (mounted.current && latest()) setState("idle");
        return;
      }
      const mic = stream;
      const audio = new AudioContext({ sampleRate: RATE });
      ctx = audio;
      const source = audio.createMediaStreamSource(mic);
      // ScriptProcessor instead of an AudioWorklet: the CSP allows no worklet from a blob. 128 ms blocks
      // keep the live text close to the voice; smaller ones crackle when the UI is busy.
      const proc = audio.createScriptProcessor(BLOCK, 1, 1);
      const rr: Recording = { gen: me.gen, stream: mic, ctx: audio, proc, id: null, queue: [], samples: 0, ready: opening.then((o) => o.id, () => null), cancelled: false };
      proc.onaudioprocess = (e) => {
        const pcm = toBase64(toInt16(e.inputBuffer.getChannelData(0)));
        rr.samples += e.inputBuffer.length;
        setSeconds(Math.floor(rr.samples / RATE));
        if (rr.id) void call("voice.audio", { id: rr.id, pcm }).catch(() => {});
        else rr.queue.push(pcm);
      };
      source.connect(proc);
      // Without a connection to the output the processor gets no audio; it writes silence there.
      proc.connect(audio.destination);
      r = rr;
      rec.current = rr;
      setState("recording");
      leave();
      if (me.early === "stop") void stop();

      const { id } = await opening;
      if (rr.cancelled) {
        void call("voice.cancel", { id }).catch(() => {});
        return;
      }
      rr.id = id;
      for (const pcm of rr.queue.splice(0)) void call("voice.audio", { id, pcm }).catch(() => {});
    } catch (e) {
      // Stopped meanwhile: stop() reports the failed connection itself.
      if (r && rec.current !== r) return;
      if (r) teardown();
      else {
        // Failed between microphone and audio graph: nothing else holds them.
        stream?.getTracks().forEach((t) => t.stop());
        void ctx?.close().catch(() => {});
      }
      if (latest()) setState("idle");
      dropOpening();
      if (me.early === "cancel" || !mounted.current) return;
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      const missing = e instanceof DOMException && e.name === "NotFoundError";
      if (denied || missing)
        toast.error(
          "Mikrofon nicht verfügbar",
          denied ? "Zugriff verweigert. In Windows unter Einstellungen, Datenschutz und Sicherheit, Mikrofon den Zugriff für Desktop-Apps erlauben." : "Kein Mikrofon gefunden.",
        );
      else toast.error("Spracheingabe nicht gestartet", errorMessage(e));
    } finally {
      leave();
    }
  }, [teardown, stop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const r = teardown();
      if (r) r.cancelled = true;
      if (r?.id) void call("voice.cancel", { id: r.id }).catch(() => {});
    };
  }, [teardown]);

  return { state, seconds, live, start, stop, cancel, prewarm };
}

function toInt16(block: Float32Array): Int16Array {
  const out = new Int16Array(block.length);
  for (let i = 0; i < block.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(block[i]! * 32767)));
  return out;
}

/** Little-endian like the service expects (every Windows machine is). */
function toBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

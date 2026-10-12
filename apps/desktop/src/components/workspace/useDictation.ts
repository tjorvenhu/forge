import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "@/lib/queries";
import { errorMessage, rpc } from "@/lib/rpc";
import { toast } from "@/stores/toast";

/** What Claude's speech service expects; Chromium resamples the microphone to it. */
const RATE = 16_000;

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

interface Recording {
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

/**
 * Dictation for the composer over Claude's speech service (the one of /voice in the terminal): the
 * microphone streams to the sidecar, `live` shows what was understood so far, and `onText` gets the
 * finished text when the recording is stopped.
 */
export function useDictation(onText: (text: string) => void, keyterms: string[]) {
  const [state, setState] = useState<DictationState>("idle");
  const [seconds, setSeconds] = useState(0);
  const [live, setLive] = useState("");
  const rec = useRef<Recording | null>(null);
  const mounted = useRef(true);
  const deliver = useRef(onText);
  const terms = useRef(keyterms);
  useEffect(() => {
    deliver.current = onText;
    terms.current = keyterms;
  }, [onText, keyterms]);

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

  const start = useCallback(async () => {
    if (rec.current) return;
    setState("starting");
    setSeconds(0);
    setLive("");
    // The connection opens while the microphone starts; the first words are queued, not lost.
    const opening = call("voice.start", { language: "de", keyterms: terms.current });
    opening.catch(() => {});
    let r: Recording | null = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      // Windows may take a moment to grant the microphone; the composer can be gone by then.
      if (!mounted.current) {
        stream.getTracks().forEach((t) => t.stop());
        void opening.then(({ id }) => call("voice.cancel", { id })).catch(() => {});
        return;
      }
      const ctx = new AudioContext({ sampleRate: RATE });
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessor instead of an AudioWorklet: the CSP allows no worklet from a blob, and 256 ms blocks are fine here.
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const rr: Recording = { stream, ctx, proc, id: null, queue: [], samples: 0, ready: opening.then((o) => o.id, () => null), cancelled: false };
      r = rr;
      rec.current = rr;
      proc.onaudioprocess = (e) => {
        const pcm = toBase64(toInt16(e.inputBuffer.getChannelData(0)));
        rr.samples += e.inputBuffer.length;
        setSeconds(Math.floor(rr.samples / RATE));
        if (rr.id) void call("voice.audio", { id: rr.id, pcm }).catch(() => {});
        else rr.queue.push(pcm);
      };
      source.connect(proc);
      // Without a connection to the output the processor gets no audio; it writes silence there.
      proc.connect(ctx.destination);
      setState("recording");

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
      teardown();
      setState("idle");
      void opening.then(({ id }) => call("voice.cancel", { id })).catch(() => {});
      const denied = e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError");
      const missing = e instanceof DOMException && e.name === "NotFoundError";
      if (denied || missing)
        toast.error(
          "Mikrofon nicht verfügbar",
          denied ? "Zugriff verweigert. In Windows unter Einstellungen, Datenschutz und Sicherheit, Mikrofon den Zugriff für Desktop-Apps erlauben." : "Kein Mikrofon gefunden.",
        );
      else toast.error("Spracheingabe nicht gestartet", errorMessage(e));
    }
  }, [teardown]);

  const stop = useCallback(async () => {
    const r = teardown();
    if (!r) return;
    setState("transcribing");
    try {
      // Stopped before the connection was open: the queued words go out first.
      const id = r.id ?? (await r.ready);
      if (!id) throw new Error("Keine Verbindung zum Sprachdienst von Claude.");
      for (const pcm of r.queue.splice(0)) void call("voice.audio", { id, pcm }).catch(() => {});
      const { text } = await call("voice.stop", { id });
      if (!mounted.current) return;
      if (text) deliver.current(text);
      else toast.info("Nichts erkannt", "In der Aufnahme war keine Sprache zu hören.");
    } catch (e) {
      toast.error("Spracheingabe fehlgeschlagen", errorMessage(e));
    } finally {
      setState("idle");
      setLive("");
    }
  }, [teardown]);

  const cancel = useCallback(() => {
    const r = teardown();
    if (r) r.cancelled = true;
    if (r?.id) void call("voice.cancel", { id: r.id }).catch(() => {});
    setState("idle");
    setLive("");
  }, [teardown]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const r = teardown();
      if (r) r.cancelled = true;
      if (r?.id) void call("voice.cancel", { id: r.id }).catch(() => {});
    };
  }, [teardown]);

  return { state, seconds, live, start, stop, cancel };
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

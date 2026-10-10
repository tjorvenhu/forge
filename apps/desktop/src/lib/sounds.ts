export type SoundKind = "done" | "approval" | "error";

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One soft sine note with a short attack and exponential release. */
function note(ac: AudioContext, freq: number, start: number, duration: number, volume: number) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

const PATTERNS: Record<SoundKind, Array<[freq: number, offset: number, duration: number]>> = {
  // rising major third: calm "finished"
  done: [
    [659.25, 0, 0.35],
    [880, 0.12, 0.5],
  ],
  // two quick identical notes: "needs your attention"
  approval: [
    [987.77, 0, 0.16],
    [987.77, 0.2, 0.22],
  ],
  // falling minor third, lower register
  error: [
    [392, 0, 0.3],
    [329.63, 0.16, 0.45],
  ],
};

export function playSound(kind: SoundKind, volume = 0.12) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  for (const [f, o, d] of PATTERNS[kind]) note(ac, f, t + o, d, volume);
}

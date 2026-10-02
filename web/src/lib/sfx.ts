// Small synthesized game-show sounds (no audio files). Separate from Spotify playback.

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call from any click/keypress so later sounds are allowed to play. */
export function unlockSfx() {
  ac();
}

function tone(c: AudioContext, type: OscillatorType, freq: number, start: number, dur: number, vol: number, endFreq?: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, start + dur);
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(vol, start + 0.01);
  g.gain.setValueAtTime(vol, start + dur - 0.05);
  g.gain.linearRampToValueAtTime(0, start + dur);
  o.connect(g).connect(c.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

export const sfx = {
  /** Classic quiz-show buzzer: two detuned low saws. */
  buzz() {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + 0.01;
    tone(c, 'sawtooth', 146, t, 0.55, 0.16);
    tone(c, 'sawtooth', 155, t, 0.55, 0.12);
    tone(c, 'square', 73, t, 0.55, 0.08);
  },
  /** Bright two-note ding for a correct answer. */
  correct() {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + 0.01;
    tone(c, 'triangle', 784, t, 0.18, 0.25);
    tone(c, 'triangle', 1175, t + 0.14, 0.42, 0.25);
  },
  /** Descending "nope". */
  wrong() {
    const c = ac();
    if (!c) return;
    const t = c.currentTime + 0.01;
    tone(c, 'square', 311, t, 0.22, 0.1, 290);
    tone(c, 'square', 233, t + 0.24, 0.45, 0.1, 180);
  },
};

// AIM-style sound cues, synthesized via Web Audio so we ship no copyrighted
// assets and no extra files. AudioContext can only be created in response to a
// user gesture in modern browsers; we lazy-init and silently no-op until the
// renderer has had at least one interaction.

export type Cue =
  | 'door-open'
  | 'door-close'
  | 'buddy-in'
  | 'buddy-out'
  | 'im-receive'
  | 'mail'
  | 'ring'
  | 'error';

export type SoundScheme = 'buzz' | 'classic';

// Classic (AIM) scheme: maps each Cue to a .wav file in public/aim/
const CLASSIC_MAP: Record<Cue, string> = {
  'door-open':  'aim/welcome.wav',
  'door-close': 'aim/goodbye.wav',
  'buddy-in':   'aim/buddyin.wav',
  'buddy-out':  'aim/buddyout.wav',
  'im-receive': 'aim/im.wav',
  'mail':       'aim/gotmail.wav',
  'ring':       'aim/phonecall.wav',
  'error':      'aim/alert.wav',
};

let ctx: AudioContext | null = null;
let enabled = true;

// Initialise scheme from localStorage so it survives across windows/sessions
// without requiring an authenticated DB read.
let scheme: SoundScheme =
  (typeof localStorage !== 'undefined' && localStorage.getItem('buzz_soundScheme') === 'classic')
    ? 'classic'
    : 'buzz';

export function setSoundScheme(s: SoundScheme): void {
  scheme = s;
  try { localStorage.setItem('buzz_soundScheme', s); } catch { /* ignore */ }
}

export function getSoundScheme(): SoundScheme { return scheme; }

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
}

// One simple beep: gain envelope around an oscillator.
function beep(
  c: AudioContext,
  freq: number,
  startAt: number,
  durSec: number,
  type: OscillatorType = 'sine',
  peakGain = 0.18,
): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, startAt);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec);
  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + durSec + 0.02);
}

// Frequency glide: useful for door opens/closes.
function glide(
  c: AudioContext,
  fromHz: number,
  toHz: number,
  startAt: number,
  durSec: number,
  type: OscillatorType = 'triangle',
  peakGain = 0.16,
): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(fromHz, startAt);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), startAt + durSec);
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durSec);
  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + durSec + 0.02);
}

export function playSound(cue: Cue): void {
  if (!enabled) return;

  // Classic scheme: play the corresponding AIM .wav file
  if (scheme === 'classic') {
    const file = CLASSIC_MAP[cue];
    if (file) {
      const a = new Audio(file);
      a.play().catch(() => undefined);
    }
    return;
  }

  // Buzz scheme: synthesized tones via Web Audio
  const c = ensureCtx();
  if (!c) return;
  // Resuming is required if the context was suspended (some browsers
  // suspend until a user gesture). Tolerate failure silently.
  if (c.state === 'suspended') void c.resume().catch(() => undefined);

  const t = c.currentTime + 0.005;
  switch (cue) {
    case 'door-open':
      // Two ascending notes — a friendly "ding".
      beep(c, 660, t, 0.12, 'sine');
      beep(c, 988, t + 0.10, 0.18, 'sine');
      break;
    case 'door-close':
      // Two descending notes — softer.
      beep(c, 660, t, 0.12, 'sine');
      beep(c, 440, t + 0.10, 0.20, 'sine');
      break;
    case 'buddy-in':
      // Quick double-beep, ascending.
      beep(c, 880, t, 0.08, 'square', 0.12);
      beep(c, 1175, t + 0.09, 0.10, 'square', 0.12);
      break;
    case 'buddy-out':
      // Quick double-beep, descending.
      beep(c, 880, t, 0.08, 'square', 0.12);
      beep(c, 587, t + 0.09, 0.10, 'square', 0.12);
      break;
    case 'im-receive':
      // Single short "boop" reminiscent of AIM's IM tone.
      beep(c, 988, t, 0.10, 'triangle', 0.16);
      beep(c, 1320, t + 0.08, 0.10, 'triangle', 0.14);
      break;
    case 'mail':
      // Three rising chimes — for the future offline-mail cue.
      beep(c, 784, t, 0.18, 'sine');
      beep(c, 988, t + 0.16, 0.18, 'sine');
      beep(c, 1175, t + 0.32, 0.30, 'sine');
      break;
    case 'ring':
      // Classic two‑tone phone ring: a pair of beeps repeated.
      beep(c, 480, t, 0.4, 'sine', 0.18);
      beep(c, 620, t, 0.4, 'sine', 0.18);
      beep(c, 480, t + 0.5, 0.4, 'sine', 0.18);
      beep(c, 620, t + 0.5, 0.4, 'sine', 0.18);
      break;
    case 'error':
      glide(c, 440, 220, t, 0.18, 'sawtooth', 0.14);
      break;
  }
}

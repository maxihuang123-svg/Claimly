// Phone ringtone for the browser-call demo: public/ringtone.mp3 if present, else a marimba tune generated with Web Audio.
// The generated one is an original melody in the style of a smartphone ringtone.

const BEAT = 0.16; // seconds per step
const CYCLE = 2.6; // the tune, then a short pause, then again
const NOTE = { E5: 659.26, G5: 783.99, A5: 880, C6: 1046.5, D6: 1174.66 };
// [step, note]: a bouncy rising figure that answers itself.
const TUNE = [
  [0, 'E5'], [1, 'G5'], [2, 'C6'], [3, 'G5'], [4, 'D6'], [6, 'C6'],
  [7, 'G5'], [8, 'E5'], [9, 'G5'], [10, 'A5'], [12, 'G5'],
];

// One marimba note: a soft mallet hit on a wooden bar. The bar's overtones sit near 4x and
// 10x the note and fade faster than it, which gives the warm, hollow knock.
function hit(context, out, frequency, time) {
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, time);
  envelope.gain.linearRampToValueAtTime(0.3, time + 0.004);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.7);
  envelope.connect(out);
  for (const [multiple, level, decay] of [[1, 1, 0.7], [3.93, 0.25, 0.15], [9.97, 0.08, 0.05]]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency * multiple;
    gain.gain.setValueAtTime(level, time);
    gain.gain.exponentialRampToValueAtTime(0.001, time + decay);
    oscillator.connect(gain).connect(envelope);
    oscillator.start(time);
    oscillator.stop(time + 0.75);
  }
}

// Plays public/ringtone.mp3 on a loop if it is there; otherwise, or if it cannot play,
// rings with the generated tune. Returns a function that stops it.
export function startRingtone() {
  let stopped = false;
  let stopFallback = null;
  const fallback = () => {
    if (!stopped && !stopFallback) stopFallback = startGenerated();
  };
  const audio = new Audio('/ringtone.mp3');
  audio.loop = true;
  audio.addEventListener('error', fallback);
  audio.play().catch(fallback);
  return () => {
    stopped = true;
    audio.pause();
    stopFallback?.();
  };
}

function startGenerated() {
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.6;
  master.connect(context.destination);

  const schedule = (start) => {
    for (const [step, note] of TUNE) hit(context, master, NOTE[note], start + step * BEAT);
  };

  // Keep one cycle scheduled ahead so the ring never stutters.
  const start = context.currentTime + 0.05;
  let cycles = 0;
  schedule(start);
  schedule(start + CYCLE);
  const timer = setInterval(() => schedule(start + (cycles++ + 2) * CYCLE), CYCLE * 1000);

  return () => {
    clearInterval(timer);
    master.gain.value = 0;
    context.close();
  };
}

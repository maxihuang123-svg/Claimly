// Phone ringtone for the browser-call demo: a classic telephone bell, generated with Web Audio.

// Classic double ring: ring 0.4 s, pause 0.2 s, ring 0.4 s, pause 2 s.
const RINGS = [[0, 0.4], [0.6, 1.0]];
const CYCLE = 3.0;
const STRIKES_PER_SEC = 25; // the clapper hitting the bells
const BELLS = [1050, 1250]; // two gongs struck alternately, as in a mechanical phone

function strike(context, out, frequency, time) {
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, time);
  envelope.gain.linearRampToValueAtTime(0.25, time + 0.002);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
  envelope.connect(out);
  // A bell: fundamental plus inharmonic partials that give the metallic ring.
  for (const [multiple, level] of [[1, 1], [2.76, 0.4], [5.4, 0.15]]) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency * multiple;
    gain.gain.value = level;
    oscillator.connect(gain).connect(envelope);
    oscillator.start(time);
    oscillator.stop(time + 0.3);
  }
}

// Starts ringing and returns a function that stops it.
export function startRingtone() {
  const context = new AudioContext();
  const master = context.createGain();
  master.gain.value = 0.5;
  master.connect(context.destination);

  const schedule = (start) => {
    for (const [from, to] of RINGS) {
      let index = 0;
      for (let time = from; time < to; time += 1 / STRIKES_PER_SEC) strike(context, master, BELLS[index++ % 2], start + time);
    }
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

// Bell sounds, shared by the bell page (app/bells.js) and the schedule
// editor's preview button (app/admin.bells.js).
//
// Everything is synthesized with Web Audio: no audio files to download,
// cache, or fail to load on a classroom device, and a bell can be queued
// on the audio clock minutes before it is due.
//
// Keys are stored in bell_periods.tone and constrained by a CHECK there:
// adding a tone means adding it to that constraint as well.

export const DEFAULT_TONE = 'chime';

export const TONES = [
  { key: 'chime',       label: 'Chime' },
  { key: 'classic',     label: 'Classic school bell' },
  { key: 'hallway',     label: 'Hallway bell (long ring)' },
  { key: 'electronic',  label: 'Electronic class bell' },
  { key: 'buzzer',      label: 'Class change buzzer' },
  { key: 'triple',      label: 'Three-note PA chime' },
  { key: 'dingdong',    label: 'Ding dong' },
  { key: 'westminster', label: 'Westminster' },
  { key: 'tone',        label: 'Steady tone' },
  { key: 'soft',        label: 'Soft' },
];

export function toneLabel(key) {
  return (TONES.find(t => t.key === key) ?? TONES[0]).label;
}

let master = null;

function masterFor(ctx) {
  if (!master || master.context !== ctx) {
    master = ctx.createDynamicsCompressor();
    master.connect(ctx.destination);
  }
  return master;
}

// One struck note: a sine with two quiet upper partials (one deliberately
// inharmonic) so it reads as a bell rather than a beep.
const STRUCK = [[1, 0.5], [2, 0.18], [2.76, 0.08]];

function strike(ctx, out, nodes, freq, t, decay, level = 1) {
  for (const [mult, vol] of STRUCK) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq * mult;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol * level, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    osc.connect(gain);
    gain.connect(out);
    osc.start(t);
    osc.stop(t + decay + 0.1);
    nodes.push(osc);
  }
}

function melody(ctx, out, nodes, when, notes, step, decay, repeats = 1, gap = 0, level = 1) {
  const span = notes.length * step + gap;
  for (let r = 0; r < repeats; r++) {
    notes.forEach((freq, i) => strike(ctx, out, nodes, freq, when + r * span + i * step, decay, level));
  }
}

// The hallway bell: bright metallic partials chopped by a fast hammer.
function classic(ctx, out, nodes, when) {
  const length = 3;
  const body = ctx.createGain();
  body.gain.setValueAtTime(0.0001, when);
  body.gain.exponentialRampToValueAtTime(0.5, when + 0.02);
  body.gain.setValueAtTime(0.5, when + length - 0.5);
  body.gain.exponentialRampToValueAtTime(0.0001, when + length);
  body.connect(out);

  // The hammer: a 24 Hz square wave swings the level between 0.1 and 1.
  const hammer = ctx.createGain();
  hammer.gain.value = 0.55;
  hammer.connect(body);
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.type = 'square';
  lfo.frequency.value = 24;
  depth.gain.value = 0.45;
  lfo.connect(depth);
  depth.connect(hammer.gain);
  lfo.start(when);
  lfo.stop(when + length + 0.1);
  nodes.push(lfo);

  for (const [freq, vol] of [[1480, 0.5], [2217, 0.32], [2960, 0.22], [3730, 0.12]]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    gain.gain.value = vol;
    osc.connect(gain);
    gain.connect(hammer);
    osc.start(when);
    osc.stop(when + length + 0.1);
    nodes.push(osc);
  }
}

// Shared envelope: fade in, hold, fade out, over `length` seconds.
function envelope(ctx, out, when, length, level, attack = 0.02, release = 0.25) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(level, when + attack);
  gain.gain.setValueAtTime(level, when + length - release);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
  gain.connect(out);
  return gain;
}

function source(ctx, nodes, type, freq, vol, dest, when, length) {
  const osc = ctx.createOscillator();
  const level = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  level.gain.value = vol;
  osc.connect(level);
  level.connect(dest);
  osc.start(when);
  osc.stop(when + length + 0.1);
  nodes.push(osc);
}

// The long hallway bell: a gong hit 17 times a second by its clapper.
// A falling sawtooth shapes every hit (sharp strike, then decay), which
// is what makes it ring like metal instead of buzz. Rings out at the end.
function hallway(ctx, out, nodes, when) {
  const length = 5;
  const body = envelope(ctx, out, when, length, 0.5, 0.02, 0.9);

  const strikes = ctx.createGain();
  strikes.gain.value = 0.55;
  strikes.connect(body);
  const lfo = ctx.createOscillator();
  const depth = ctx.createGain();
  lfo.type = 'sawtooth';
  lfo.frequency.value = 17;
  depth.gain.value = -0.45;          // inverted: jump up on the strike, fall away after it
  lfo.connect(depth);
  depth.connect(strikes.gain);
  lfo.start(when);
  lfo.stop(when + length + 0.1);
  nodes.push(lfo);

  // A bell gong's partials are not whole multiples of each other.
  for (const [freq, vol] of [[1046, 0.42], [1570, 0.26], [2340, 0.18], [3120, 0.1]]) {
    source(ctx, nodes, 'triangle', freq, vol, strikes, when, length);
  }
}

// The modern electronic bell in most new buildings: two pitches
// trading places six times a second for three seconds.
function electronic(ctx, out, nodes, when) {
  const length = 3;
  const body = envelope(ctx, out, when, length, 0.45, 0.02, 0.2);

  const lfo = ctx.createOscillator();
  lfo.type = 'square';
  lfo.frequency.value = 6;
  lfo.start(when);
  lfo.stop(when + length + 0.1);
  nodes.push(lfo);

  for (const [freq, sign] of [[1046.5, 1], [830.6, -1]]) {
    const gate = ctx.createGain();
    gate.gain.value = 0.5;
    const depth = ctx.createGain();
    depth.gain.value = 0.5 * sign;   // one pitch on while the other is off
    lfo.connect(depth);
    depth.connect(gate.gain);
    gate.connect(body);
    source(ctx, nodes, 'triangle', freq, 0.9, gate, when, length);
    source(ctx, nodes, 'sine', freq * 2, 0.15, gate, when, length);
  }
}

// The class change buzzer: a low, rough tone, softened just enough
// with a filter that it is firm rather than painful.
function buzzer(ctx, out, nodes, when) {
  const length = 2.2;
  const body = envelope(ctx, out, when, length, 0.4, 0.015, 0.06);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2400;
  filter.connect(body);
  source(ctx, nodes, 'square', 150, 0.5, filter, when, length);
  source(ctx, nodes, 'sawtooth', 300, 0.3, filter, when, length);
}

// The PA tone: one steady pitch with soft edges.
function steady(ctx, out, nodes, when) {
  const length = 2.5;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(0.4, when + 0.04);
  gain.gain.setValueAtTime(0.4, when + length - 0.15);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
  gain.connect(out);

  for (const [freq, vol] of [[880, 1], [1760, 0.2]]) {
    const osc = ctx.createOscillator();
    const level = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    level.gain.value = vol;
    osc.connect(level);
    level.connect(gain);
    osc.start(when);
    osc.stop(when + length + 0.1);
    nodes.push(osc);
  }
}

const PLAYERS = {
  chime:       (ctx, out, nodes, when) => melody(ctx, out, nodes, when, [659.25, 830.61, 987.77, 1318.51], 0.26, 1.9, 2, 0.46),
  classic,
  hallway,
  electronic,
  buzzer,
  triple:      (ctx, out, nodes, when) => melody(ctx, out, nodes, when, [783.99, 659.25, 523.25], 0.55, 2.3),
  dingdong:    (ctx, out, nodes, when) => melody(ctx, out, nodes, when, [659.25, 523.25], 0.7, 2.2, 2, 0.5),
  westminster: (ctx, out, nodes, when) => melody(ctx, out, nodes, when, [659.25, 523.25, 587.33, 392.0], 0.6, 2.4),
  tone:        steady,
  soft:        (ctx, out, nodes, when) => melody(ctx, out, nodes, when, [523.25, 659.25, 783.99], 0.45, 2.6, 1, 0, 0.5),
};

/**
 * Queues a bell on ctx's clock at `when` (seconds, ctx.currentTime based).
 * Returns the started source nodes so a queued bell can be cancelled with
 * stop(). Unknown tone keys fall back to the default.
 */
export function ringAt(ctx, when, tone = DEFAULT_TONE) {
  const nodes = [];
  (PLAYERS[tone] ?? PLAYERS[DEFAULT_TONE])(ctx, masterFor(ctx), nodes, when);
  return nodes;
}

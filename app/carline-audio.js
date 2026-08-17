// Shared Web Audio plumbing for the carline pages (dismissal screen, input
// screen, kiosk). Each page keeps its own melodies; only the context and the
// gesture handling live here, because getting those wrong fails *silently*.
//
// Two failure modes this exists to prevent, both seen in the field:
//
//  1. A context created without a user gesture starts suspended, and
//     resume() outside a gesture is ignored. If the first thing that wants
//     sound is an incoming realtime call rather than a tap, that chime is
//     lost -- and every later chime works, because by then the operator has
//     touched the screen. Hence priming on any gesture, not just pointerdown.
//
//  2. resume() is asynchronous. Tones scheduled against a currentTime that
//     hasn't started advancing yet get dropped, so a call landing in the same
//     moment as the unlocking tap is silent. Hence playTones() waiting for
//     the context to actually reach 'running' before scheduling.

let audioCtx = null;
const readyListeners = new Set();

// No amount of priming can start audio on a page the user has never touched
// -- an unattended display (projector, wall TV) needs to *say* so, which is
// what these let a page do.
export function isAudioReady() {
  return audioCtx?.state === 'running';
}

export function onAudioReadyChange(cb) {
  readyListeners.add(cb);
  cb(isAudioReady());
}

function notifyReady() {
  const ready = isAudioReady();
  readyListeners.forEach(cb => { try { cb(ready); } catch { /* keep notifying the rest */ } });
}

export function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.addEventListener('statechange', notifyReady);
    notifyReady();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// A single silent sample is the long-standing way to make iOS actually start
// the context clock rather than just reporting 'running'.
function unlock(ctx) {
  try {
    const src = ctx.createBufferSource();
    src.buffer = ctx.createBuffer(1, 1, 22050);
    src.connect(ctx.destination);
    src.start(0);
  } catch { /* nothing to do -- the tones below will retry */ }
}

// Call from any user gesture. Safe to call repeatedly.
export function primeAudio() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'running') { unlock(ctx); return; }
    ctx.resume().then(() => unlock(ctx)).catch(() => {});
  } catch { /* no Web Audio support -- pages degrade to silent */ }
}

// Wire every gesture a school device can produce: taps on the tablet, the
// keypad on a desktop, and a tab regaining focus (browsers suspend the
// context of a backgrounded page, so a display left on a wall monitor needs
// to re-resume when it comes back).
export function wireAudioPriming() {
  const onGesture = () => {
    primeAudio();
    if (audioCtx?.state === 'running') {
      ['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
        document.removeEventListener(ev, onGesture, true));
    }
  };
  ['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
    document.addEventListener(ev, onGesture, true));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) primeAudio();
  });
  window.addEventListener('focus', () => primeAudio());
}

// specs: [frequency, startOffsetSeconds, durationSeconds, volume?, waveform?]
export function playTones(specs) {
  const schedule = ctx => {
    specs.forEach(([freq, start, dur, vol = 0.25, type = 'sine']) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type; osc.frequency.value = freq;
      const t = ctx.currentTime + start;
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.start(t); osc.stop(t + dur + 0.05);
    });
  };

  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'running') schedule(ctx);
    else ctx.resume().then(() => schedule(ctx)).catch(() => {});
  } catch { /* silent rather than throwing into a call handler */ }
}

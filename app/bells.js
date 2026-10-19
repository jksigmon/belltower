// Bell page: shows the school clock and a countdown, and rings the bell.
//
// How it stays correct and cheap:
//
//  * Bells fire from a timeline held in this page, not from the server.
//    At bell time the page sends nothing, so dozens of rooms ringing at
//    once (including the last bell, which lands on carline dismissal)
//    put no load on anything.
//
//  * The timeline arrives as absolute instants already resolved in the
//    school's timezone by the bell_board edge function, and "now" is the
//    server's clock carried forward on performance.now(). The device's
//    own clock and timezone are never used to decide when a bell rings.
//
//  * Bell audio is queued on the Web Audio clock a couple of minutes
//    ahead. A teacher's bell tab is usually in the background, where
//    browsers throttle timers to once a second and then once a minute;
//    audio that is already queued still plays on time.
//
//  * The Supabase client is only loaded for the schedule picker. A page
//    that already knows its schedule needs nothing but this file, the
//    feed, and its saved copy of the timeline, so it keeps ringing
//    through a Wi-Fi drop or an expired login.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { getAudioCtx, primeAudio, wireAudioPriming, isAudioReady, onAudioReadyChange } from './carline-audio.js';
import { ringAt, DEFAULT_TONE } from './bell-tones.js?v=2';

const FEED = `${SUPABASE_URL}/functions/v1/bell_board`;
const FEED_HEADERS = { Authorization: `Bearer ${SUPABASE_ANON_KEY}`, apikey: SUPABASE_ANON_KEY };

const STORE_KEY = 'bt-bells';
const THEME_KEY = 'bt-bells-theme';
const DEFAULT_TZ = 'America/New_York';

const POLL_MS = 60_000;
const POLL_JITTER_MS = 15_000;   // spreads rooms out so they never poll in step
const LOOKAHEAD_MS = 150_000;    // longer than the once-a-minute timer floor of a hidden tab
const LATE_GRACE_MS = 1_500;     // a bell missed by more than this is skipped, not rung late
const FLASH_MS = 7_000;
const URGENT_MS = 60_000;
const STALE_SYNC_MS = 5 * 60_000;
const GOOD_RTT_MS = 1_500;

const $ = id => document.getElementById(id);

/* ===============================
   STATE
================================ */
let saved = null;            // { token, scheduleId, version, timeline }
let timeline = null;
let version = null;
let bells = [];              // [{ at, title, tone }] sorted by at
let online = false;
let stopped = false;
let pollTimer = null;
let lastPollAt = 0;
let lastTickNow = null;
let flashTimer = null;
let ringingUntil = 0;
let flashTitle = '';
let pipWin = null;
let wakeLock = null;
let stripKey = '';
let fmt = null;

// at (epoch ms) -> { tone, nodes } queued for that bell
const scheduled = new Map();

/* ===============================
   SERVER TIME
   One sample = { serverMs, perfMs }: "the server clock read serverMs at
   performance.now() === perfMs". The midpoint of the request is used as
   perfMs, so the error is at most half the round trip, and the sample
   with the shortest round trip wins.
================================ */
let sync = null;
let forceResync = false;
let holdUntil = 0;
let wallSkew = Date.now() - performance.now();

function nowMs() {
  return sync ? sync.serverMs + (performance.now() - sync.perfMs) : Date.now();
}

function takeSample(serverNow, t0, t1) {
  const rtt = t1 - t0;
  const stale = sync && t1 - sync.at > STALE_SYNC_MS;
  if (sync && !forceResync && rtt > sync.rtt && !(stale && rtt < GOOD_RTT_MS)) return;

  sync = { serverMs: serverNow, perfMs: (t0 + t1) / 2, rtt, at: t1 };
  wallSkew = Date.now() - performance.now();
  if (forceResync) {
    forceResync = false;
    holdUntil = 0;
    cancelScheduled();
  }
}

// performance.now() can stop during system sleep, and the audio clock
// stops with it, so anything queued before the lid closed would ring
// late by however long the laptop slept. The device clock and
// performance.now() drifting apart is the signal: drop what is queued,
// assume the gap was sleep until the server says otherwise, and resync.
function checkClockJump() {
  const skew = Date.now() - performance.now();
  const delta = skew - wallSkew;
  if (Math.abs(delta) < 2_000) return;

  wallSkew = skew;
  if (sync) sync.perfMs -= delta;
  cancelScheduled();
  forceResync = true;
  holdUntil = performance.now() + 8_000;
  pollSoon();
}

// Some systems keep performance.now() running through sleep but still
// stop the audio clock, which the check above cannot see. Same remedy:
// requeue against the clocks as they are now.
let audioSkew = null;
function checkAudioClock() {
  if (!isAudioReady()) { audioSkew = null; return; }
  const skew = getAudioCtx().currentTime * 1000 - performance.now();
  if (audioSkew != null && Math.abs(skew - audioSkew) > 250) cancelScheduled();
  audioSkew = skew;
}

async function fetchFeed(params) {
  const t0 = performance.now();
  const res = await fetch(`${FEED}?${new URLSearchParams(params)}`, { headers: FEED_HEADERS, cache: 'no-store' });
  const t1 = performance.now();
  const body = await res.json().catch(() => null);
  if (body && typeof body.now === 'number') takeSample(body.now, t0, t1);
  return { res, body };
}

// The first request often pays an edge function cold start, which makes
// for a poor time sample. Two quick follow-ups give a much tighter one.
async function refineSync() {
  for (let i = 0; i < 2; i++) {
    await new Promise(r => setTimeout(r, 400));
    try { await fetchFeed({ action: 'time' }); } catch { /* next poll will sample again */ }
  }
}

/* ===============================
   FEED
================================ */
function readSaved() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    return v && typeof v.token === 'string' ? v : null;
  } catch { return null; }
}

function writeSaved() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* private mode: runs without a saved copy */ }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (stopped) return;
  pollTimer = setTimeout(poll, POLL_MS + Math.random() * POLL_JITTER_MS);
}

function pollSoon() {
  clearTimeout(pollTimer);
  if (!stopped) pollTimer = setTimeout(poll, 50);
}

async function poll() {
  if (stopped) return;
  clearTimeout(pollTimer);
  lastPollAt = performance.now();
  const firstSync = !sync;

  try {
    const params = { t: saved.token };
    if (version) params.v = version;
    const { res, body } = await fetchFeed(params);

    if (res.status === 404) { scheduleGone(); return; }
    // Anything else that is not OK keeps the last good timeline on screen
    // and ringing, and tries again next cycle.
    if (!res.ok || !body) throw new Error(`feed responded ${res.status}`);

    online = true;
    if (body.timeline) applyTimeline(body.timeline, body.version, true);
    if (firstSync) refineSync();
  } catch (err) {
    online = false;
    console.warn('Bell feed unavailable, using the saved schedule.', err);
  }

  updatePills();
  schedulePoll();
}

// The schedule was deleted, deactivated, or the module was turned off.
function scheduleGone() {
  stopped = true;
  cancelScheduled();
  try { localStorage.removeItem(STORE_KEY); } catch { /* nothing saved to remove */ }
  location.replace(`${location.pathname}?schedule=choose&gone=1`);
}

function applyTimeline(tl, ver, persist) {
  timeline = tl;
  version = ver;

  // A bell at the instant one period ends and the next begins rings once,
  // announced as (and in the tone of) the period that is starting.
  const map = new Map();
  for (const day of tl.days ?? []) {
    for (const p of day.periods ?? []) {
      if (p.ring_end && !map.has(p.end)) map.set(p.end, { at: p.end, title: `${p.name} has ended`, tone: p.tone });
      if (p.ring_start) map.set(p.start, { at: p.start, title: `${p.name} is starting`, tone: p.tone });
    }
  }
  bells = [...map.values()].sort((a, b) => a.at - b.at);

  // Unqueue audio for bells that no longer exist or changed sound (a
  // period was moved or the day was silenced after its bell was queued).
  // Anything dropped here is queued again on the next tick.
  const now = nowMs();
  for (const [at, entry] of scheduled) {
    const bell = map.get(at);
    if (at > now && (!bell || (bell.tone ?? DEFAULT_TONE) !== entry.tone)) {
      stopNodes(entry.nodes);
      scheduled.delete(at);
    }
  }

  buildFormatters(tl.timezone);
  stripKey = '';

  if (persist) {
    saved.version = ver;
    saved.timeline = tl;
    writeSaved();
  }

  $('bpSchool').textContent = tl.school ?? '';
  $('bpSchedule').textContent = tl.grade_label ? `${tl.schedule} · ${tl.grade_label}` : (tl.schedule ?? '');
  render();
}

/* ===============================
   AUDIO
================================ */
function stopNodes(nodes) {
  for (const n of nodes) {
    try { n.stop(); n.disconnect(); } catch { /* already finished */ }
  }
}

// Drops every bell that has not started ringing yet. They are queued
// again on the next tick against the current clocks.
function cancelScheduled() {
  const now = nowMs();
  for (const [at, entry] of scheduled) {
    if (at > now) { stopNodes(entry.nodes); scheduled.delete(at); }
  }
}

function queueBells(now) {
  if (!isAudioReady() || performance.now() < holdUntil) return;
  const ctx = getAudioCtx();

  for (const b of bells) {
    const delta = b.at - now;
    if (delta > LOOKAHEAD_MS) break;
    if (delta < -LATE_GRACE_MS || scheduled.has(b.at)) continue;
    const tone = b.tone ?? DEFAULT_TONE;
    scheduled.set(b.at, { tone, nodes: ringAt(ctx, ctx.currentTime + Math.max(delta, 0) / 1000, tone) });
  }

  for (const at of scheduled.keys()) {
    if (at < now - 60_000) scheduled.delete(at);
  }
}

function ringNow() {
  try {
    const ctx = getAudioCtx();
    const go = () => ringAt(ctx, ctx.currentTime + 0.08);
    if (ctx.state === 'running') go();
    else ctx.resume().then(go).catch(() => {});
  } catch { /* no Web Audio: the visual bell still shows */ }
}

/* ===============================
   FORMATTING (always in the school's timezone)
================================ */
function buildFormatters(tz) {
  const make = zone => ({
    zone,
    day:   new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }),
    date:  new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'long', month: 'long', day: 'numeric' }),
    clock: new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }),
    time:  new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true }),
  });

  if (fmt?.zone === tz) return;
  try { fmt = make(tz || DEFAULT_TZ); }
  catch { fmt = make(DEFAULT_TZ); }
}

const fmtTime = ms => fmt.time.format(ms);

// "9:28 - 10:58 AM" rather than "9:28 AM - 10:58 AM" when both ends share
// AM or PM, so a range fits on a period card at a size readable from the
// back of the room.
function fmtRange(a, b) {
  const start = fmtTime(a), end = fmtTime(b);
  const tail = s => s.slice(-2);
  return tail(start) === tail(end) ? `${start.slice(0, -3)} - ${end}` : `${start} - ${end}`;
}

function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/* ===============================
   WHAT IS HAPPENING RIGHT NOW
================================ */
// title, sub, and status.html are written with innerHTML: escape anything
// that came from the database before passing it in.
function idle(title, sub = '', status = null) {
  return { mode: 'idle', title, sub, status, current: -1 };
}

const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function computeState(now) {
  if (!timeline) return { ...idle('Loading the schedule'), day: null };

  const today = fmt.day.format(now);
  const days = timeline.days ?? [];
  const idx = days.findIndex(d => d.date === today);
  const day = idx === -1 ? null : days[idx];

  if (!day) {
    return { ...idle("Waiting for today's schedule", online ? '' : 'This device is offline.'), day: null };
  }

  const periods = day.periods ?? [];
  const tomorrow = days[idx + 1];
  const tomorrowFirst = tomorrow?.status === 'bells' ? tomorrow.periods?.[0] : null;
  const tomorrowStatus = tomorrowFirst
    ? { tone: 'info', html: `Tomorrow's first bell <strong>${fmtTime(tomorrowFirst.start)}</strong>` }
    : null;

  if (day.status === 'closed') {
    return { ...idle(esc(day.label || 'No school today'), 'No bells today', tomorrowStatus), day };
  }
  if (day.status === 'silenced') {
    return { ...idle(esc(day.label || 'Bells are off today'), day.label ? 'Bells are off today' : 'Turned off by the office', tomorrowStatus), day };
  }
  if (day.status !== 'bells' || !periods.length) {
    return { ...idle('No bells today', 'Enjoy the day.', tomorrowStatus), day };
  }

  const first = periods[0];
  const dayEnd = periods.reduce((max, p) => Math.max(max, p.end), 0);

  if (now < first.start) {
    return {
      mode: 'count', day, current: -1, dayEnd,
      title: 'Good morning',
      sub: 'until the first bell',
      target: first.start,
      status: { tone: 'info', html: `<strong>${esc(first.name)}</strong> starts at ${fmtTime(first.start)}` },
    };
  }

  if (now >= dayEnd) {
    return {
      ...idle('School day complete', tomorrowFirst ? 'See you tomorrow.' : 'Bells are done for today.',
        { tone: 'done', html: `${CHECK}All bells completed for today` }),
      day, dayEnd,
    };
  }

  const current = periods.findIndex(p => now >= p.start && now < p.end);
  if (current !== -1) {
    const p = periods[current];
    const nxt = periods.find(q => q.start >= p.end);
    return {
      mode: 'count', day, current, dayEnd,
      title: esc(p.name),
      sub: 'until the bell',
      target: p.end,
      progress: (now - p.start) / (p.end - p.start),
      status: nxt
        ? { tone: 'info', html: `Next <strong>${esc(nxt.name)}</strong> at ${fmtTime(nxt.start)}` }
        : { tone: 'info', html: 'Last period of the day' },
    };
  }

  // Between periods.
  const nxt = periods.find(p => p.start > now);
  return {
    mode: 'count', day, current: -1, dayEnd,
    title: 'Passing time',
    sub: `until ${esc(nxt.name)} starts`,
    target: nxt.start,
    status: { tone: 'info', html: `<strong>${esc(nxt.name)}</strong> starts at ${fmtTime(nxt.start)}` },
  };
}

// Period names come from the database and go into innerHTML strings.
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/* ===============================
   RENDER
================================ */
// Only touch the DOM when a value actually changes: this runs four times
// a second and most of what it writes changes once a second or less.
const lastWrite = new WeakMap();
function put(el, value, html = false) {
  if (!el || lastWrite.get(el) === value) return;
  lastWrite.set(el, value);
  if (html) el.innerHTML = value; else el.textContent = value;
}

// The day as a row of cards: every period with its times, then a final
// Dismissal card for the last bell. Finished periods get a check; the
// current one is outlined in gold with a bar that fills as it runs.
function renderStrip(state, now) {
  const strip = $('bpStrip');
  const periods = state.day?.status === 'bells' ? (state.day.periods ?? []) : [];
  const key = `${version}|${state.day?.date ?? ''}`;

  if (key !== stripKey) {
    stripKey = key;
    const cards = periods.map(p => `
      <div class="bp-seg">
        <div class="bp-seg-head"><div class="bp-seg-name">${esc(p.name)}</div><span class="bp-seg-check">${CHECK}</span></div>
        <div class="bp-seg-time">${fmtRange(p.start, p.end)}</div>
        <div class="bp-seg-bar"><i></i></div>
      </div>`);
    if (periods.length) {
      cards.push(`
      <div class="bp-seg bp-seg-end">
        <div class="bp-seg-head"><div class="bp-seg-name">Dismissal</div><span class="bp-seg-check">${CHECK}</span></div>
        <div class="bp-seg-time">${fmtTime(state.dayEnd)}</div>
      </div>`);
    }
    strip.innerHTML = cards.join('');
  }

  [...strip.children].forEach((seg, i) => {
    const p = periods[i];
    let s;
    if (!p) s = now >= state.dayEnd ? 'done' : 'next';          // the Dismissal card
    else s = now >= p.end ? 'past' : (now >= p.start ? 'current' : 'next');
    if (seg.dataset.state !== s) {
      seg.dataset.state = s;
      // Only matters when the strip is too narrow to show every card.
      if (s === 'current' && strip.scrollWidth > strip.clientWidth) {
        strip.scrollLeft = seg.offsetLeft - (strip.clientWidth - seg.offsetWidth) / 2;
      }
    }

    const bar = seg.querySelector('.bp-seg-bar i');
    if (bar) {
      const w = s === 'current' ? `${Math.min(100, ((now - p.start) / (p.end - p.start)) * 100).toFixed(2)}%` : '0%';
      if (bar.style.width !== w) bar.style.width = w;
    }
  });
}

function render() {
  if (!fmt) return;
  const now = nowMs();
  const state = computeState(now);

  const parts = Object.fromEntries(fmt.clock.formatToParts(now).map(p => [p.type, p.value]));
  put($('bpClockMain'), `${parts.hour}:${parts.minute}`);
  put($('bpClockSec'), parts.second);
  put($('bpClockAmPm'), parts.dayPeriod ?? '');
  const dateText = fmt.date.format(now);
  const dayType = state.day?.status === 'bells' && state.day.day_type ? `${state.day.day_type} schedule` : '';
  put($('bpDate'), dayType ? `${dateText} · ${dayType}` : dateText);

  const counting = state.mode === 'count';
  const remaining = counting ? state.target - now : 0;
  const countdown = counting ? fmtCountdown(remaining) : '';
  const urgent = counting && remaining <= URGENT_MS;
  // With nothing to count down to, the giant number shows the time of day
  // (and the small clock in the header steps aside).
  const hero = counting ? countdown : `${parts.hour}:${parts.minute}`;
  const heroHtml = counting ? hero : `${hero}<span class="bp-hero-ampm">${esc(parts.dayPeriod ?? '')}</span>`;

  const stage = $('bpNow');
  if (stage.dataset.mode !== state.mode) stage.dataset.mode = state.mode;
  if (stage.dataset.urgent !== String(urgent)) stage.dataset.urgent = String(urgent);
  const app = $('bpApp');
  if (app.dataset.mode !== state.mode) app.dataset.mode = state.mode;

  put($('bpCountdown'), heroHtml, true);
  const long = String(hero.length > 5);
  if ($('bpCountdown').dataset.long !== long) $('bpCountdown').dataset.long = long;
  put($('bpNowTitle'), state.title, true);
  put($('bpNowSub'), state.sub ?? '', true);

  const status = $('bpStatus');
  put(status, state.status?.html ?? '', true);
  const tone = state.status?.tone ?? 'none';
  if (status.dataset.tone !== tone) status.dataset.tone = tone;

  renderStrip(state, now);

  // Plain-text versions for the tab title and the floating window.
  const plainTitle = $('bpNowTitle').textContent;
  const tabTitle = counting ? `${countdown} · ${plainTitle}` : 'Bells · Belltower';
  if (document.title !== tabTitle) document.title = tabTitle;

  renderMini({ counting, countdown, urgent, title: plainTitle, clock: `${parts.hour}:${parts.minute} ${parts.dayPeriod ?? ''}`, now });
}

function tick() {
  if (stopped) return;
  checkClockJump();
  checkAudioClock();

  const now = nowMs();
  queueBells(now);

  // The visual bell. Skipped if this tick is running late (a throttled
  // background tab), since a flash seconds after the bell is just noise.
  if (lastTickNow != null) {
    const due = bells.find(b => b.at > lastTickNow && b.at <= now && now - b.at < 5_000);
    if (due) showFlash(due.title, fmt ? fmtTime(due.at) : '');
  }
  lastTickNow = now;

  render();
}

/* ===============================
   VISUAL BELL
================================ */
function showFlash(title, sub) {
  flashTitle = title;
  ringingUntil = performance.now() + FLASH_MS;
  $('bpFlashTitle').textContent = title;
  $('bpFlashSub').textContent = sub;
  $('bpFlash').hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('bpFlash').hidden = true; }, FLASH_MS);
}

/* ===============================
   FLOATING MINI WINDOW
   An always-on-top countdown for a teacher whose screen is showing
   slides, not this tab. Chrome and Edge only; the button stays hidden
   elsewhere.
================================ */
async function toggleMini() {
  if (pipWin) { pipWin.close(); return; }

  try {
    const win = await window.documentPictureInPicture.requestWindow({ width: 400, height: 150 });
    const doc = win.document;
    doc.title = 'Bells';
    doc.documentElement.dataset.theme = document.documentElement.dataset.theme;

    document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
      const copy = doc.createElement('link');
      copy.rel = 'stylesheet';
      copy.href = link.href;
      doc.head.appendChild(copy);
    });

    doc.body.className = 'bp-mini';
    doc.body.innerHTML = `
      <div style="min-width:0">
        <div class="bp-mini-title" id="miniTitle"></div>
        <div class="bp-mini-sub" id="miniSub"></div>
      </div>
      <div class="bp-mini-count" id="miniCount"></div>`;

    win.addEventListener('pagehide', () => { pipWin = null; });
    pipWin = win;
    render();
  } catch (err) {
    console.warn('Could not open the floating window.', err);
  }
}

function renderMini({ counting, countdown, urgent, title, clock }) {
  if (!pipWin) return;
  const doc = pipWin.document;
  const ringing = performance.now() < ringingUntil;

  put(doc.getElementById('miniTitle'), ringing ? flashTitle : title);
  put(doc.getElementById('miniSub'), clock.trim());
  put(doc.getElementById('miniCount'), counting ? countdown : '');
  if (doc.body.dataset.urgent !== String(urgent)) doc.body.dataset.urgent = String(urgent);
  if (doc.body.dataset.ring !== String(ringing)) doc.body.dataset.ring = String(ringing);
}

/* ===============================
   STATUS, WAKE LOCK, THEME
================================ */
function updatePills() {
  const sound = $('bpSoundPill');
  const ready = isAudioReady();
  sound.textContent = ready ? 'Sound on' : 'Sound off. Tap to turn on';
  sound.dataset.state = ready ? 'ok' : 'warn';

  const pill = $('bpSyncPill');
  if (online) {
    pill.textContent = 'Synced';
    pill.dataset.state = 'ok';
  } else if (sync) {
    pill.textContent = 'Offline. Using saved schedule';
    pill.dataset.state = 'warn';
  } else {
    pill.textContent = timeline ? 'Offline. Using device clock' : 'Connecting';
    pill.dataset.state = 'warn';
  }
}

// Keeps the screen from sleeping while the page is visible. Browsers
// release the lock whenever the tab is hidden, so it is taken again on
// every return. The device's own sleep settings still apply when the
// lid is closed or the tab is in the background.
async function keepAwake() {
  if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* denied (low battery, policy): nothing to do */ }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  if (pipWin) pipWin.document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* not remembered */ }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ===============================
   DISPLAY
================================ */
function startDisplay() {
  $('bpSetup').hidden = true;
  $('bpApp').hidden = false;
  $('bpStart').hidden = false;

  buildFormatters(saved.timeline?.timezone);
  if (saved.timeline) applyTimeline(saved.timeline, saved.version, false);

  wireAudioPriming();
  onAudioReadyChange(ready => {
    // The audio clock stops while the context is suspended, so anything
    // queued before it resumed would now ring late.
    if (ready) cancelScheduled();
    updatePills();
  });

  $('bpStartBtn').addEventListener('click', () => {
    $('bpStart').hidden = true;
    primeAudio();
    ringNow();
    keepAwake();
  });
  $('bpSoundPill').addEventListener('click', () => { primeAudio(); });
  $('bpTestBtn').addEventListener('click', () => {
    primeAudio();
    ringNow();
    showFlash('Test bell', fmt ? fmtTime(nowMs()) : '');
  });
  $('bpThemeBtn').addEventListener('click', toggleTheme);
  $('bpFullscreenBtn').addEventListener('click', toggleFullscreen);
  $('bpChangeBtn').addEventListener('click', () => { location.href = `${location.pathname}?schedule=choose`; });
  $('bpFlash').addEventListener('click', () => { $('bpFlash').hidden = true; });

  if ('documentPictureInPicture' in window) {
    $('bpMiniBtn').hidden = false;
    $('bpMiniBtn').addEventListener('click', toggleMini);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    keepAwake();
    if (performance.now() - lastPollAt > 30_000) pollSoon();
  });
  window.addEventListener('online', pollSoon);
  window.addEventListener('offline', () => { online = false; updatePills(); });

  updatePills();
  setInterval(tick, 250);
  tick();
  poll();
}

/* ===============================
   SCHEDULE PICKER (signed-in staff)
================================ */
function setupMessage(title, text, { signIn = false, school = '' } = {}) {
  $('bpSetupTitle').textContent = title;
  $('bpSetupSchool').textContent = school;
  $('bpSetupSchool').hidden = !school;
  $('bpSetupText').textContent = text;
  $('bpScheduleList').innerHTML = '';
  $('bpKeepBtn').hidden = true;
  $('bpSignInLink').hidden = !signIn;
}

// "9-12" or "K-5" reads better as "Grades 9-12"; anything already worded
// ("Upper School", "Grades 6-8") is shown as entered.
function gradeText(label) {
  if (!label) return '';
  return /^(PK|K|\d{1,2})(\s*-\s*(K|\d{1,2}))?$/i.test(label.trim()) ? `Grades ${label.trim()}` : label;
}

function choose(s) {
  saved = { token: s.feed_token, scheduleId: s.id, version: null, timeline: null };
  writeSaved();
  history.replaceState(null, '', location.pathname);
  startDisplay();
}

async function showPicker(wantedId, gone) {
  let supabase;
  try {
    ({ supabase } = await import('./admin.supabase.js?v=2'));
  } catch (err) {
    console.error('Bell picker: could not load the Supabase client', err);
    setupMessage('Bells', 'Could not reach Belltower. Check the connection and reload this page.');
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) {
    setupMessage('Bells', 'Sign in to choose a bell schedule for this screen. After signing in, come back to this page.', { signIn: true });
    return;
  }

  const { data: profile, error: profileErr } = await supabase
    .from('profiles')
    .select('school_id, status, is_superadmin, schools!profiles_school_id_fkey(name, school_modules(module, enabled))')
    .eq('user_id', session.user.id)
    .single();

  if (profileErr || !profile || profile.status !== 'active') {
    console.error('Bell picker: profile load failed', profileErr);
    setupMessage('Bells', 'Your account could not be loaded. Reload the page or contact your administrator.');
    return;
  }

  const enabled = (profile.schools?.school_modules ?? []).some(m => m.module === 'bells' && m.enabled === true);
  if (!enabled) {
    setupMessage('Bells', 'Bell Schedules is not turned on for your school yet.');
    return;
  }

  const { data: schedules, error } = await supabase
    .from('bell_schedules')
    .select('id, name, grade_label, feed_token')
    .eq('school_id', profile.school_id)
    .eq('is_active', true)
    .order('sort_order')
    .order('name');

  if (error) {
    console.error('Bell picker: schedule load failed', error);
    setupMessage('Bells', 'The bell schedules could not be loaded. Reload the page to try again.');
    return;
  }

  if (!schedules?.length) {
    setupMessage('Bells', 'No bell schedules have been set up yet. An administrator can add one under Bell Schedules in the Admin Panel.');
    return;
  }

  const wanted = schedules.find(s => s.id === wantedId);
  if (wanted) { choose(wanted); return; }

  setupMessage(
    'Select Bell Schedule',
    gone
      ? 'The schedule this screen was using is no longer available. Choose another one.'
      : 'Choose the schedule for this room.',
    { school: profile.schools?.name || '' }
  );

  // The schedule this screen already runs goes first and is marked.
  const currentId = saved?.token ? saved.scheduleId : null;
  const ordered = [...schedules].sort((a, b) => (b.id === currentId) - (a.id === currentId));

  $('bpScheduleList').innerHTML = ordered.map(s => {
    const current = s.id === currentId;
    return `
    <button type="button" class="bp-schedule-btn${current ? ' is-current' : ''}" data-id="${esc(s.id)}"${current ? ' aria-current="true"' : ''}>
      <div class="bp-schedule-icon" aria-hidden="true">${current ? '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M4 2C2.8 3.7 2 5.7 2 8"/><path d="M22 8c0-2.3-.8-4.3-2-6"/></svg>' : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>'}</div>
      <div class="bp-schedule-text">
        <strong>${esc(s.name)}</strong>
        ${s.grade_label ? `<span>${esc(gradeText(s.grade_label))}</span>` : ''}
      </div>
      ${current ? '<span class="bp-current-pill">Current</span>' : ''}
      <svg class="bp-schedule-chevron" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
    </button>`;
  }).join('');

  $('bpScheduleList').querySelectorAll('.bp-schedule-btn').forEach(btn =>
    btn.addEventListener('click', () => choose(schedules.find(s => s.id === btn.dataset.id))));

  if (currentId) {
    $('bpKeepBtn').hidden = false;
    $('bpKeepBtn').onclick = () => { location.href = location.pathname; };
  }
}

/* ===============================
   BOOT
================================ */
(async () => {
  let theme = 'dark';
  try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* default */ }
  applyTheme(theme === 'light' ? 'light' : 'dark');

  const params = new URLSearchParams(location.search);
  const wanted = params.get('schedule');
  saved = readSaved();

  // A screen that already knows its schedule goes straight to the bells:
  // no sign-in, no Supabase client, nothing that can fail offline.
  if (saved?.token && (!wanted || wanted === saved.scheduleId)) {
    startDisplay();
    return;
  }

  await showPicker(wanted, params.has('gone'));
})();

import { esc, dbError } from './admin.shared.js';

// Color config keyed by event_type — all values are hardcoded constants, safe to interpolate
const TYPE_CONFIG = {
  no_school:      { bar: '#ef4444', bg: '#fef2f2', text: '#dc2626' },
  holiday:        { bar: '#ef4444', bg: '#fef2f2', text: '#dc2626' },
  pd_day:         { bar: '#3b82f6', bg: '#eff6ff', text: '#1d4ed8' },
  early_release:  { bar: '#f59e0b', bg: '#fffbeb', text: '#b45309' },
  break:          { bar: '#8b5cf6', bg: '#faf5ff', text: '#6d28d9' },
  quarter_end:    { bar: '#10b981', bg: '#f0fdf4', text: '#047857' },
  first_last_day: { bar: '#0b2d4f', bg: '#e8f0fb', text: '#0b2d4f' },
  event:          { bar: '#0891b2', bg: '#ecfeff', text: '#0e7490' },
};

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function getDaysLabel(eventDate, endDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = parseDate(eventDate);
  const end   = endDate ? parseDate(endDate) : start;
  if (end < today)                         return null;
  if (start <= today && today <= end)      return 'Today';
  const diff = Math.round((start - today) / 86_400_000);
  if (diff === 1)                          return 'Tomorrow';
  return `${diff} days`;
}

function fmtRange(eventDate, endDate) {
  const opts  = { month: 'short', day: 'numeric' };
  const start = parseDate(eventDate).toLocaleDateString('en-US', opts);
  if (!endDate || endDate === eventDate) return start;
  return `${start} – ${parseDate(endDate).toLocaleDateString('en-US', opts)}`;
}

// 'HH:MM[:SS]' → 'h:mm AM/PM'
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ap = h < 12 ? 'AM' : 'PM';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, '0')} ${ap}`;
}

// Build the muted "3:00 PM – 4:00 PM · Gym" meta line. Times are derived
// (safe); location is user input and must be escaped.
function metaLine(ev) {
  let timeStr = '';
  if (ev.start_time) {
    timeStr = ev.end_time
      ? `${fmtTime(ev.start_time)} – ${fmtTime(ev.end_time)}`
      : fmtTime(ev.start_time);
  }
  return [timeStr, ev.location ? esc(ev.location) : ''].filter(Boolean).join(' · ');
}

// Module-level guard: the drawer is injected into <body> once per page load
let _ready = false;

export async function initCalendarStrip(supabase, schoolId, mountEl, canManage = false) {
  if (_ready || !mountEl) return;
  _ready = true;

  // ── Build drawer DOM ───────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.className = 'cal-overlay';

  const drawer = document.createElement('div');
  drawer.className = 'cal-drawer';
  drawer.innerHTML = `
    <div class="cal-drawer-hd">
      <span class="cal-drawer-title">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
             style="vertical-align:-2px;margin-right:6px">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8"  y1="2" x2="8"  y2="6"/>
          <line x1="3"  y1="10" x2="21" y2="10"/>
        </svg>School Calendar
      </span>
      <button class="cal-drawer-close" aria-label="Close calendar">&#10005;</button>
    </div>
    <div class="cal-drawer-body">
      <p class="cal-loading">Loading&hellip;</p>
    </div>
    <div class="cal-drawer-ft">
      <a class="cal-pdf-btn" href="#" target="_blank" rel="noopener noreferrer" style="display:none;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        View Full Calendar (PDF)
      </a>
    </div>`;

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  const bodyEl   = drawer.querySelector('.cal-drawer-body');
  const pdfBtn   = drawer.querySelector('.cal-pdf-btn');
  const closeBtn = drawer.querySelector('.cal-drawer-close');

  function openDrawer()  { overlay.classList.add('open');    drawer.classList.add('open'); }
  function closeDrawer() { overlay.classList.remove('open'); drawer.classList.remove('open'); }

  overlay.addEventListener('click', closeDrawer);
  closeBtn.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

  // Persistent structure inside the scrollable body: a list + (optional) add section
  bodyEl.innerHTML = '';
  const listEl = document.createElement('div');
  listEl.className = 'cal-list';
  bodyEl.appendChild(listEl);
  if (canManage) bodyEl.appendChild(buildAddSection());

  let upcoming = [];

  // ── Fetch the school's PDF URL once ────────────────────────────────────
  supabase
    .from('schools')
    .select('calendar_pdf_url')
    .eq('id', schoolId)
    .single()
    .then(({ data }) => {
      if (data?.calendar_pdf_url) {
        pdfBtn.href = data.calendar_pdf_url;
        pdfBtn.style.display = '';
      }
    });

  async function loadEvents() {
    const today = todayISO();
    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 14);
    const lookbackStr = lookback.toISOString().slice(0, 10);

    const { data } = await supabase
      .from('school_calendar_events')
      .select('id, title, event_date, end_date, event_type, start_time, end_time, location')
      .eq('school_id', schoolId)
      .gte('event_date', lookbackStr)
      .order('event_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: true })
      .limit(30);

    upcoming = (data ?? [])
      .filter(e => (e.end_date || e.event_date) >= today)
      .slice(0, 7);

    renderList();
    renderChip();
  }

  // ── Render the event list ──────────────────────────────────────────────
  function renderList() {
    listEl.innerHTML = '';
    if (!upcoming.length) {
      listEl.innerHTML = '<p class="cal-loading">No upcoming events.</p>';
      return;
    }
    upcoming.forEach(ev => {
      const dLabel = getDaysLabel(ev.event_date, ev.end_date) ?? 'Ongoing';
      const cfg    = TYPE_CONFIG[ev.event_type] ?? TYPE_CONFIG.no_school;
      const meta   = metaLine(ev);

      const card = document.createElement('div');
      card.className = 'cal-card';
      // cfg values are from the hardcoded TYPE_CONFIG constant — safe to interpolate
      card.innerHTML = `
        <div class="cal-card-bar" style="background:${cfg.bar}"></div>
        <div class="cal-card-info">
          <div class="cal-card-title">${esc(ev.title)}</div>
          <div class="cal-card-date">${fmtRange(ev.event_date, ev.end_date)}</div>
          ${meta ? `<div class="cal-card-meta">${meta}</div>` : ''}
        </div>
        <span class="cal-card-badge" style="background:${cfg.bg};color:${cfg.text}">${esc(dLabel)}</span>`;
      listEl.appendChild(card);
    });
  }

  // ── Render the header banner chip ──────────────────────────────────────
  function renderChip() {
    mountEl.innerHTML = '';
    let chip;
    if (upcoming.length) {
      const next      = upcoming[0];
      const nextLabel = getDaysLabel(next.event_date, next.end_date) ?? 'Ongoing';
      chip = document.createElement('button');
      chip.className = 'cal-chip';
      chip.setAttribute('aria-label', 'Open school calendar');
      chip.innerHTML = `
        ${calIconSvg('cal-chip-icon')}
        <span class="cal-chip-text">${esc(next.title)}</span>
        <span class="cal-chip-badge">${esc(nextLabel)}</span>`;
    } else if (canManage) {
      // No events yet — still give managers a way into the drawer to add one
      chip = document.createElement('button');
      chip.className = 'cal-chip';
      chip.setAttribute('aria-label', 'Open school calendar');
      chip.innerHTML = `
        ${calIconSvg('cal-chip-icon')}
        <span class="cal-chip-text">Calendar</span>`;
    } else {
      return; // nothing to show
    }
    chip.addEventListener('click', openDrawer);
    mountEl.appendChild(chip);
  }

  // ── Add-event section (managers only) ──────────────────────────────────
  function buildAddSection() {
    const wrap = document.createElement('div');
    wrap.className = 'cal-add';
    wrap.innerHTML = `
      <button type="button" class="cal-add-trigger">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Add event
      </button>
      <form class="cal-add-form" hidden novalidate>
        <input type="text" class="cal-input cal-new-title" placeholder="Event title" maxlength="120" required />
        <input type="date" class="cal-input cal-new-date" required />
        <div class="cal-time-row">
          <input type="time" class="cal-input cal-new-start" aria-label="Start time" />
          <span class="cal-time-sep">to</span>
          <input type="time" class="cal-input cal-new-end" aria-label="End time" />
        </div>
        <input type="text" class="cal-input cal-new-loc" placeholder="Location (optional)" maxlength="120" />
        <p class="cal-form-err" hidden></p>
        <div class="cal-form-actions">
          <button type="button" class="cal-btn-cancel">Cancel</button>
          <button type="submit" class="cal-btn-save">Save event</button>
        </div>
      </form>`;

    const trigger  = wrap.querySelector('.cal-add-trigger');
    const form     = wrap.querySelector('.cal-add-form');
    const titleInp = wrap.querySelector('.cal-new-title');
    const dateInp  = wrap.querySelector('.cal-new-date');
    const startInp = wrap.querySelector('.cal-new-start');
    const endInp   = wrap.querySelector('.cal-new-end');
    const locInp   = wrap.querySelector('.cal-new-loc');
    const errEl    = wrap.querySelector('.cal-form-err');
    const saveBtn  = wrap.querySelector('.cal-btn-save');
    const cancelBtn = wrap.querySelector('.cal-btn-cancel');

    function showErr(msg) { errEl.textContent = msg; errEl.hidden = false; }
    function reset() {
      form.reset();
      form.hidden = true;
      trigger.hidden = false;
      errEl.hidden = true;
    }

    trigger.addEventListener('click', () => {
      form.hidden = false;
      trigger.hidden = true;
      if (!dateInp.value) dateInp.value = todayISO();
      titleInp.focus();
    });
    cancelBtn.addEventListener('click', reset);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      errEl.hidden = true;
      const title    = titleInp.value.trim();
      const date     = dateInp.value;
      const start    = startInp.value || null;
      const end      = endInp.value || null;
      const location = locInp.value.trim() || null;

      if (!title) { showErr('Please enter a title.'); titleInp.focus(); return; }
      if (!date)  { showErr('Please choose a date.'); dateInp.focus(); return; }
      if (start && end && end < start) { showErr('End time is before start time.'); return; }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      const { error } = await supabase.from('school_calendar_events').insert({
        school_id:  schoolId,
        title,
        event_date: date,
        end_date:   null,
        event_type: 'event',
        start_time: start,
        end_time:   end,
        location,
      });
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save event';

      if (error) {
        console.error('Calendar add error:', error);
        showErr(dbError ? dbError(error) : 'Could not save. Please try again.');
        return;
      }
      reset();
      await loadEvents();
    });

    return wrap;
  }

  await loadEvents();
}

function calIconSvg(cls) {
  return `
    <svg class="${cls}" width="12" height="12" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8"  y1="2" x2="8"  y2="6"/>
      <line x1="3"  y1="10" x2="21" y2="10"/>
    </svg>`;
}

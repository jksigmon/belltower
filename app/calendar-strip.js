import { esc } from './admin.shared.js';

// Color config keyed by event_type — all values are hardcoded constants, safe to interpolate
const TYPE_CONFIG = {
  no_school:      { bar: '#ef4444', bg: '#fef2f2', text: '#dc2626' },
  holiday:        { bar: '#ef4444', bg: '#fef2f2', text: '#dc2626' },
  pd_day:         { bar: '#3b82f6', bg: '#eff6ff', text: '#1d4ed8' },
  early_release:  { bar: '#f59e0b', bg: '#fffbeb', text: '#b45309' },
  break:          { bar: '#8b5cf6', bg: '#faf5ff', text: '#6d28d9' },
  quarter_end:    { bar: '#10b981', bg: '#f0fdf4', text: '#047857' },
  first_last_day: { bar: '#0b2d4f', bg: '#e8f0fb', text: '#0b2d4f' },
};

function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
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

// Module-level guard: the drawer is injected into <body> once per page load
let _ready = false;

export async function initCalendarStrip(supabase, schoolId, mountEl) {
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

  // ── Fetch events + PDF URL in parallel ────────────────────────────────
  const today    = new Date().toISOString().slice(0, 10);
  const lookback = new Date();
  lookback.setDate(lookback.getDate() - 14);
  const lookbackStr = lookback.toISOString().slice(0, 10);

  const [eventsRes, schoolRes] = await Promise.all([
    supabase
      .from('school_calendar_events')
      .select('id, title, event_date, end_date, event_type')
      .eq('school_id', schoolId)
      .gte('event_date', lookbackStr)
      .order('event_date', { ascending: true })
      .limit(30),
    supabase
      .from('schools')
      .select('calendar_pdf_url')
      .eq('id', schoolId)
      .single(),
  ]);

  // Wire PDF button if URL is set
  const pdfUrl = schoolRes.data?.calendar_pdf_url;
  if (pdfUrl) {
    pdfBtn.href = pdfUrl;
    pdfBtn.style.display = '';
  }

  // Keep only events whose end (or start, for single-day) is today or later
  const upcoming = (eventsRes.data ?? [])
    .filter(e => (e.end_date || e.event_date) >= today)
    .slice(0, 7);

  if (!upcoming.length) {
    bodyEl.innerHTML = '<p class="cal-loading">No upcoming events.</p>';
    return; // nothing to show in the banner either
  }

  // ── Render banner chip ─────────────────────────────────────────────────
  const next      = upcoming[0];
  const nextLabel = getDaysLabel(next.event_date, next.end_date) ?? 'Ongoing';

  const chip = document.createElement('button');
  chip.className = 'cal-chip';
  chip.setAttribute('aria-label', 'Open school calendar');
  chip.innerHTML = `
    <svg class="cal-chip-icon" width="12" height="12" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8"  y1="2" x2="8"  y2="6"/>
      <line x1="3"  y1="10" x2="21" y2="10"/>
    </svg>
    <span class="cal-chip-text">${esc(next.title)}</span>
    <span class="cal-chip-badge">${esc(nextLabel)}</span>`;
  chip.addEventListener('click', openDrawer);
  mountEl.appendChild(chip);

  // ── Render event cards in drawer ───────────────────────────────────────
  bodyEl.innerHTML = '';
  upcoming.forEach(ev => {
    const dLabel = getDaysLabel(ev.event_date, ev.end_date) ?? 'Ongoing';
    const cfg    = TYPE_CONFIG[ev.event_type] ?? TYPE_CONFIG.no_school;

    const card = document.createElement('div');
    card.className = 'cal-card';
    // cfg values are from the hardcoded TYPE_CONFIG constant — safe to interpolate
    card.innerHTML = `
      <div class="cal-card-bar" style="background:${cfg.bar}"></div>
      <div class="cal-card-info">
        <div class="cal-card-title">${esc(ev.title)}</div>
        <div class="cal-card-date">${fmtRange(ev.event_date, ev.end_date)}</div>
      </div>
      <span class="cal-card-badge" style="background:${cfg.bg};color:${cfg.text}">${esc(dLabel)}</span>`;
    bodyEl.appendChild(card);
  });
}

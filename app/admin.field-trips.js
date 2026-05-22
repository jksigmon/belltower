import { supabase } from './admin.supabase.js';
import { initPage } from './admin.auth.js';
import { esc, debounce, loadSchoolConfig, GRADE_ORDER } from './admin.shared.js';

let profile = null;
let schoolConfig = null;

// ── Module-level state ──────────────────────────────────────────────────
let tripCache            = [];
let currentTrip          = null;
let chaperoneList        = [];
let studentList          = [];
let bgCheckMap           = new Map(); // email (lower) -> bg check row
let requiredFormTemplates = [];        // school-level, loaded once on init
let agreementsMap        = new Map(); // email (lower) -> Set<templateId>
let selectedGuardian     = null;
let activeTab            = 'chaperones';
let drawerManagers       = [];   // { profile_id, name, email } — pending in drawer
let currentManagers      = [];   // loaded from DB for current trip

// Populated from school config on init — not a hardcoded constant
let GRADE_LEVELS = GRADE_ORDER;

// ── Init ────────────────────────────────────────────────────────────────
async function init() {
  profile = await initPage();
  if (!profile) return;

  schoolConfig = await loadSchoolConfig(profile.school_id);
  GRADE_LEVELS = schoolConfig?.grade_levels ?? GRADE_ORDER;

  wireNav();
  wireTripDrawer();
  wireChapDrawer();
  wireTabs();
  wireFilters();

  document.getElementById('signOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });

  document.getElementById('sideNav')?.classList.remove('hidden');

  await loadRequiredForms();
  setActive('#trips');
}

// ── Routing ─────────────────────────────────────────────────────────────
function setActive(hash) {
  history.replaceState(null, '', '#trips');

  document.querySelectorAll('#sideNav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#trips');
  });

  document.querySelectorAll('main section').forEach(s => { s.style.display = 'none'; });
  const section = document.getElementById('trips');
  if (section) section.style.display = 'block';

  showListView();
  if (!tripCache.length) loadTrips();
}

function wireNav() {
  window.addEventListener('hashchange', () => setActive(location.hash || '#trips'));
  document.getElementById('hamburgerBtn')?.addEventListener('click', () => {
    document.getElementById('adminNav')?.classList.toggle('hidden');
    document.getElementById('sideNav')?.classList.toggle('hidden');
    document.getElementById('navOverlay')?.classList.toggle('visible');
  });
  document.getElementById('navOverlay')?.addEventListener('click', () => {
    document.getElementById('sideNav')?.classList.add('hidden');
    document.getElementById('navOverlay')?.classList.remove('visible');
  });
}

// ── List view ────────────────────────────────────────────────────────────
function showListView() {
  document.getElementById('ftListView').style.display  = '';
  document.getElementById('ftDetailView').style.display = 'none';
  currentTrip = null;
  document.getElementById('pageSubtitle').textContent = 'Field Trips';
}

function showDetailView() {
  document.getElementById('ftListView').style.display  = 'none';
  document.getElementById('ftDetailView').style.display = '';
}

async function loadTrips() {
  const tbody = document.getElementById('ftTableBody');
  tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px 0;">Loading...</td></tr>`;

  let tripIds = null;
  if (!profile.can_manage_field_trips && !profile.is_superadmin) {
    const { data: managed } = await supabase
      .from('field_trip_managers')
      .select('field_trip_id')
      .eq('profile_id', profile.id);
    tripIds = (managed ?? []).map(r => r.field_trip_id);
    if (!tripIds.length) {
      tripCache = [];
      renderTripList();
      return;
    }
  }

  let query = supabase
    .from('field_trips')
    .select('id, name, destination, start_date, end_date, depart_at, return_at, grade_levels, drivers_needed, max_chaperones, notes, status, created_at')
    .eq('school_id', profile.school_id)
    .order('start_date', { ascending: false });
  if (tripIds) query = query.in('id', tripIds);

  const { data, error } = await query;
  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  tripCache = data ?? [];
  renderTripList();
}

function renderTripList() {
  const tbody     = document.getElementById('ftTableBody');
  const search    = document.getElementById('ftSearch')?.value.trim().toLowerCase();
  const statusVal = document.getElementById('ftStatusFilter')?.value;
  const today     = new Date(); today.setHours(0, 0, 0, 0);

  const filtered = tripCache.filter(t => {
    if (search) {
      const hay = `${t.name} ${t.destination ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    const tripDate = new Date(t.start_date + 'T12:00:00');
    if (statusVal === 'upcoming'  && (t.status === 'cancelled' || tripDate < today)) return false;
    if (statusVal === 'past'      && (t.status === 'cancelled' || tripDate >= today)) return false;
    if (statusVal === 'active'    && t.status !== 'active') return false;
    if (statusVal === 'cancelled' && t.status !== 'cancelled') return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted" style="text-align:center;padding:32px 0;">No trips found.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(t => {
    const startDate = new Date(t.start_date + 'T12:00:00');
    const isPast    = startDate < today;
    const badge     = t.status === 'cancelled'
      ? `<span class="trip-badge trip-badge-cancelled">Cancelled</span>`
      : isPast
        ? `<span class="trip-badge trip-badge-past">Past</span>`
        : `<span class="trip-badge trip-badge-active">Upcoming</span>`;

    const grades  = (t.grade_levels ?? []).map(g => `<span class="grade-pill">${esc(g)}</span>`).join('');
    const dateStr = t.end_date && t.end_date !== t.start_date
      ? `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(t.end_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
      : startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.innerHTML = `
      <td><strong>${esc(t.name)}</strong></td>
      <td>${dateStr}</td>
      <td>${t.destination ? esc(t.destination) : '<span class="muted">—</span>'}</td>
      <td>${grades || '<span class="muted">—</span>'}</td>
      <td id="chapCount-${esc(t.id)}"><span class="muted">—</span></td>
      <td id="studCount-${esc(t.id)}"><span class="muted">—</span></td>
      <td>${badge}</td>
      <td><button class="btn btn-sm" data-id="${esc(t.id)}">Open</button></td>
    `;
    tr.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      openTrip(t.id);
    });
    tr.querySelector('button[data-id]').addEventListener('click', () => openTrip(t.id));
    tbody.appendChild(tr);
  });

  loadChaperoneCounts(filtered.map(t => t.id));
  loadStudentCounts(filtered);
}

async function loadChaperoneCounts(ids) {
  if (!ids.length) return;
  const { data } = await supabase
    .from('field_trip_chaperones')
    .select('field_trip_id')
    .in('field_trip_id', ids)
    .is('removed_at', null);

  if (!data) return;
  const counts = {};
  data.forEach(r => { counts[r.field_trip_id] = (counts[r.field_trip_id] ?? 0) + 1; });
  ids.forEach(id => {
    const el = document.getElementById(`chapCount-${id}`);
    if (el) el.textContent = counts[id] ?? '0';
  });
}

async function loadStudentCounts(trips) {
  if (!trips.length) return;
  // For each trip, count students matching its grade_levels (minus explicit non-attenders)
  await Promise.all(trips.map(async t => {
    const el = document.getElementById(`studCount-${t.id}`);
    if (!el) return;
    const grades = t.grade_levels ?? [];
    let q = supabase.from('students').select('id', { count: 'exact', head: true })
      .eq('school_id', profile.school_id).eq('active', true);
    if (grades.length) q = q.in('grade_level', grades);
    const { count } = await q;
    if (el) el.textContent = count ?? '—';
  }));
}

function wireFilters() {
  const search  = document.getElementById('ftSearch');
  const status  = document.getElementById('ftStatusFilter');
  const handler = debounce(() => renderTripList(), 200);
  search?.addEventListener('input', handler);
  status?.addEventListener('change', handler);
  document.getElementById('newTripBtn')?.addEventListener('click', () => openTripDrawer(null));
}

// ── Trip detail ──────────────────────────────────────────────────────────
async function openTrip(id) {
  const trip = tripCache.find(t => t.id === id);
  if (!trip) return;
  currentTrip = trip;

  showDetailView();
  document.getElementById('pageSubtitle').textContent = trip.name;

  renderTripHeader(trip);
  switchTab('chaperones');
  await Promise.all([loadChaperones(), renderComplianceFormLinks(), loadManagers(trip.id)]);
}

function renderTripHeader(trip) {
  const today     = new Date(); today.setHours(0, 0, 0, 0);
  const startDate = new Date(trip.start_date + 'T12:00:00');
  const endDate   = trip.end_date ? new Date(trip.end_date + 'T12:00:00') : null;
  const isPast    = (endDate ?? startDate) < today;

  document.getElementById('ftDetailName').textContent = trip.name;
  document.getElementById('ftDetailDest').textContent = trip.destination ?? '';

  let badge = '';
  if (trip.status === 'cancelled') {
    badge = `<span class="trip-badge trip-badge-cancelled">Cancelled</span>`;
  } else if (isPast) {
    badge = `<span class="trip-badge trip-badge-past">Past</span>`;
  } else {
    badge = `<span class="trip-badge trip-badge-active">Upcoming</span>`;
  }
  document.getElementById('ftDetailBadge').innerHTML = badge;

  const fmt = { month: 'long', day: 'numeric', year: 'numeric' };
  const dateStr = endDate && endDate.getTime() !== startDate.getTime()
    ? `${startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', fmt)}`
    : startDate.toLocaleDateString('en-US', { weekday: 'long', ...fmt });

  let timeStr = '';
  if (trip.depart_at) timeStr += `Departs ${fmtTime(trip.depart_at)}`;
  if (trip.return_at) timeStr += (timeStr ? ' &bull; ' : '') + `Returns ${fmtTime(trip.return_at)}`;

  const grades = (trip.grade_levels ?? []).map(g => `<span class="grade-pill">${esc(g)}</span>`).join('');

  document.getElementById('ftDetailMeta').innerHTML = `
    <span class="trip-hdr-meta-item">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      ${dateStr}
    </span>
    ${timeStr ? `<span class="trip-hdr-meta-item">${timeStr}</span>` : ''}
    ${grades ? `<span class="trip-hdr-meta-item">${grades}</span>` : ''}
    ${trip.max_chaperones ? `<span class="trip-hdr-meta-item">Max ${trip.max_chaperones} chaperones</span>` : ''}
    ${trip.drivers_needed ? `<span class="trip-hdr-meta-item" style="color:#d97706;">Drivers needed</span>` : ''}
  `;

  document.getElementById('ftEditBtn').onclick   = () => openTripDrawer(trip);
  document.getElementById('ftCancelBtn').style.display = (!isPast && trip.status === 'active') ? '' : 'none';
  document.getElementById('ftCancelBtn').onclick  = () => cancelTrip(trip.id);
  document.getElementById('ftBackBtn').onclick    = showListView;
}

async function cancelTrip(id) {
  if (!confirm('Cancel this trip? This cannot be undone.')) return;
  const { error } = await supabase.from('field_trips').update({ status: 'cancelled' }).eq('id', id);
  if (error) { alert('Failed to cancel trip.'); return; }
  const t = tripCache.find(t => t.id === id);
  if (t) t.status = 'cancelled';
  renderTripHeader(currentTrip);
}

// ── Tabs ────────────────────────────────────────────────────────────────
function wireTabs() {
  document.querySelectorAll('.ft-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.ft-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('ftTabChaperones').style.display = tab === 'chaperones' ? '' : 'none';
  document.getElementById('ftTabStudents').style.display   = tab === 'students'   ? '' : 'none';

  if (tab === 'students' && !studentList.length) loadStudents();
}

// ── Chaperones ───────────────────────────────────────────────────────────
async function loadChaperones() {
  const tbody = document.getElementById('ftChapTableBody');
  tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">Loading...</td></tr>`;

  const { data, error } = await supabase
    .from('field_trip_chaperones')
    .select(`
      id, guardian_id, is_driver, added_at,
      guardian:guardians(id, first_name, last_name, email,
        family:families(family_name,
          students(id, first_name, last_name, grade_level)
        )
      )
    `)
    .eq('field_trip_id', currentTrip.id)
    .is('removed_at', null)
    .order('added_at', { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">Failed to load.</td></tr>`;
    return;
  }

  chaperoneList = data ?? [];

  const emails = chaperoneList.map(c => c.guardian?.email).filter(Boolean);
  await Promise.all([
    loadBgChecksByEmail(emails),
    loadAgreementsByEmail(emails),
  ]);

  renderChaperoneTable();
  renderComplianceStats();
}

async function loadRequiredForms() {
  const { data } = await supabase
    .from('compliance_form_templates')
    .select('id, title')
    .eq('school_id', profile.school_id)
    .eq('required_for_chaperones', true)
    .eq('active', true)
    .order('title');
  requiredFormTemplates = data ?? [];
  document.getElementById('thForms').style.display = requiredFormTemplates.length ? '' : 'none';
}

async function loadAgreementsByEmail(emails) {
  agreementsMap.clear();
  if (!emails.length || !requiredFormTemplates.length) return;

  const { data } = await supabase
    .from('compliance_agreements')
    .select('signer_email, template_id')
    .eq('school_id', profile.school_id)
    .in('signer_email', emails)
    .in('template_id', requiredFormTemplates.map(t => t.id))
    .is('voided_at', null);

  (data ?? []).forEach(row => {
    const key = (row.signer_email ?? '').toLowerCase();
    if (!agreementsMap.has(key)) agreementsMap.set(key, new Set());
    agreementsMap.get(key).add(row.template_id);
  });
}

async function loadBgChecksByEmail(emails) {
  bgCheckMap.clear();
  if (!emails.length) return;

  const { data } = await supabase
    .from('compliance_bg_check_requests')
    .select('id, subject_email, status, cleared_at, expires_at, mvr_cleared_at, mvr_expires_at')
    .eq('school_id', profile.school_id)
    .in('subject_email', emails)
    .in('status', ['cleared', 'submitted', 'pending']);

  if (!data) return;
  // Keep most recent cleared record per email; fall back to any record
  data.forEach(row => {
    const key = (row.subject_email ?? '').toLowerCase();
    const existing = bgCheckMap.get(key);
    if (!existing || (row.status === 'cleared' && existing.status !== 'cleared')) {
      bgCheckMap.set(key, row);
    }
  });
}

function getMissingForms(email) {
  if (!requiredFormTemplates.length) return [];
  const signed = agreementsMap.get((email ?? '').toLowerCase()) ?? new Set();
  return requiredFormTemplates.filter(t => !signed.has(t.id));
}

function computeComplianceStatus(guardian, bgCheck, tripDate, isDriver) {
  if (!bgCheck) return 'blocked';

  const trip  = new Date(tripDate + 'T12:00:00');
  const bgExp = bgCheck.expires_at ? new Date(bgCheck.expires_at + 'T12:00:00') : null;
  const bgOk  = bgCheck.status === 'cleared' && (!bgExp || bgExp >= trip);

  if (!bgOk) {
    return bgCheck.status === 'pending' || bgCheck.status === 'submitted' ? 'action' : 'blocked';
  }

  // Only enforce MVR if the school has require_mvr_for_drivers enabled (default: true)
  const requireMvr = schoolConfig?.require_mvr_for_drivers !== false;
  if (isDriver && requireMvr) {
    if (!bgCheck.mvr_cleared_at) return 'action';
    const mvrExp = bgCheck.mvr_expires_at ? new Date(bgCheck.mvr_expires_at + 'T12:00:00') : null;
    if (mvrExp && mvrExp < trip) return 'action';
  }

  if (getMissingForms(guardian?.email).length) return 'action';

  return 'cleared';
}

function renderBgChip(status, bgCheck, tripDate, isDriver) {
  const labels = { cleared: 'Cleared', action: 'Action needed', blocked: 'Blocked', unknown: 'No record' };
  const cls    = { cleared: 'comp-cleared', action: 'comp-action', blocked: 'comp-blocked', unknown: 'comp-unknown' };
  const s = bgCheck ? status : 'unknown';

  let tooltip = '';
  if (!bgCheck) {
    tooltip = 'No background check on file';
  } else if (s === 'blocked') {
    const bgExp = bgCheck.expires_at ? new Date(bgCheck.expires_at + 'T12:00:00') : null;
    const trip  = new Date(tripDate + 'T12:00:00');
    tooltip = bgExp && bgExp < trip ? 'BG check expired by trip date' : `BG check status: ${bgCheck.status}`;
  } else if (s === 'action' && bgCheck.status === 'cleared' && isDriver) {
    tooltip = 'MVR required for drivers';
  }

  return `<span class="comp-chip ${cls[s]}" title="${esc(tooltip)}">${labels[s]}</span>`;
}

function renderFormsChip(email) {
  const missing = getMissingForms(email);
  if (!missing.length) return `<span class="comp-chip comp-cleared">All signed</span>`;
  const names = missing.map(t => t.title).join(', ');
  const label = missing.length === 1 ? `Missing: ${missing[0].title}` : `${missing.length} forms missing`;
  return `<span class="comp-chip comp-action" title="Missing: ${esc(names)}">${esc(label)}</span>`;
}

function renderChaperoneTable() {
  const tbody         = document.getElementById('ftChapTableBody');
  const driversNeeded = currentTrip.drivers_needed;
  const formsRequired = requiredFormTemplates.length > 0;
  const tripDate      = currentTrip.end_date ?? currentTrip.start_date;

  const requireMvrGlobal = schoolConfig?.require_mvr_for_drivers !== false;
  document.getElementById('thMvr').style.display   = (driversNeeded && requireMvrGlobal) ? '' : 'none';
  document.getElementById('thForms').style.display  = formsRequired ? '' : 'none';

  const colCount = 4 + (driversNeeded && requireMvrGlobal ? 1 : 0) + (formsRequired ? 1 : 0) + 1 + 1;
  if (!chaperoneList.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="muted" style="text-align:center;padding:32px 0;">No chaperones added yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  chaperoneList.forEach(chap => {
    const g      = chap.guardian ?? {};
    const email  = (g.email ?? '').toLowerCase();
    const bg     = bgCheckMap.get(email) ?? null;
    const status = computeComplianceStatus(g, bg, tripDate, chap.is_driver);

    const students = (g.family?.students ?? [])
      .map(s => esc(s.first_name))
      .join(', ') || '<span class="muted">—</span>';

    let mvrCell = '';
    const requireMvr = schoolConfig?.require_mvr_for_drivers !== false;
    if (driversNeeded && requireMvr) {
      if (!chap.is_driver) {
        mvrCell = `<td><span class="muted" style="font-size:12px;">N/A</span></td>`;
      } else {
        const tripEnd = new Date(tripDate + 'T12:00:00');
        const mvrOk   = bg?.mvr_cleared_at && (!bg.mvr_expires_at || new Date(bg.mvr_expires_at + 'T12:00:00') >= tripEnd);
        mvrCell = `<td><span class="comp-chip ${mvrOk ? 'comp-cleared' : 'comp-action'}">${mvrOk ? 'Cleared' : 'Needed'}</span></td>`;
      }
    }

    const formsCell = formsRequired
      ? `<td>${renderFormsChip(email)}</td>`
      : '';

    const tr = document.createElement('tr');
    tr.className = 'chap-row';
    tr.innerHTML = `
      <td class="chap-name">
        <strong>${esc(g.first_name ?? '')} ${esc(g.last_name ?? '')}</strong>
        <span>${esc(g.email ?? '')}</span>
      </td>
      <td class="chap-students">${students}</td>
      <td>${renderBgChip(status, bg, tripDate, chap.is_driver)}</td>
      ${mvrCell}
      ${formsCell}
      <td>${chap.is_driver ? '<span class="comp-chip comp-action">Driver</span>' : '<span class="muted" style="font-size:12px;">No</span>'}</td>
      <td><button class="btn btn-sm btn-danger" data-chap-id="${esc(chap.id)}" style="font-size:11px;">Remove</button></td>
    `;
    tr.querySelector('button[data-chap-id]').addEventListener('click', () => removeChaperone(chap.id));
    tbody.appendChild(tr);
  });
}

function renderComplianceStats() {
  const statsWrap = document.getElementById('ftCompStats');
  if (!chaperoneList.length) { statsWrap.style.display = 'none'; return; }

  let cleared = 0, action = 0, blocked = 0;
  chaperoneList.forEach(chap => {
    const g  = chap.guardian ?? {};
    const bg = bgCheckMap.get((g.email ?? '').toLowerCase()) ?? null;
    const s  = computeComplianceStatus(g, bg, currentTrip.end_date ?? currentTrip.start_date, chap.is_driver);
    if (s === 'cleared')  cleared++;
    else if (s === 'action') action++;
    else blocked++;
  });

  document.getElementById('ftStatTotal').textContent   = chaperoneList.length;
  document.getElementById('ftStatCleared').textContent = cleared;
  document.getElementById('ftStatAction').textContent  = action;
  document.getElementById('ftStatBlocked').textContent = blocked;
  document.getElementById('ftStatActionCard').style.display  = action  ? '' : 'none';
  document.getElementById('ftStatBlockedCard').style.display = blocked ? '' : 'none';
  statsWrap.style.display = '';
}

async function renderComplianceFormLinks() {
  const wrap = document.getElementById('ftFormLinksWrap');
  if (!wrap) return;

  const { data: templates } = await supabase
    .from('compliance_form_templates')
    .select('id, title')
    .eq('school_id', profile.school_id)
    .eq('required_for_chaperones', true)
    .eq('active', true)
    .order('title');

  if (!templates?.length) { wrap.style.display = 'none'; return; }

  const { data: links } = await supabase
    .from('compliance_form_links')
    .select('id, token, label, template_id, active')
    .eq('school_id', profile.school_id)
    .in('template_id', templates.map(t => t.id))
    .eq('active', true);

  const linksByTemplate = new Map();
  (links ?? []).forEach(l => {
    if (!linksByTemplate.has(l.template_id)) linksByTemplate.set(l.template_id, []);
    linksByTemplate.get(l.template_id).push(l);
  });

  const BASE = `${window.location.origin}/volunteer.html?form=`;
  wrap.innerHTML = templates.map(t => {
    const tLinks = linksByTemplate.get(t.id) ?? [];
    const linkHtml = tLinks.length
      ? tLinks.map(l => `
          <span style="display:inline-flex;align-items:center;gap:6px;margin-right:8px;margin-top:4px;">
            <span style="font-size:12px;color:#374151;">${esc(l.label || 'Link')}</span>
            <button class="btn btn-sm" data-copy-url="${esc(BASE + l.token)}" style="font-size:11px;padding:2px 8px;">Copy Link</button>
          </span>`).join('')
      : `<span style="font-size:12px;color:#9ca3af;">No active link — create one in Compliance settings</span>`;
    return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;padding:6px 0;border-bottom:1px solid #f1f5f9;">
      <span style="font-size:13px;font-weight:600;color:#0b2d4f;min-width:160px;">${esc(t.title)}</span>
      <div style="display:flex;flex-wrap:wrap;gap:4px;">${linkHtml}</div>
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-copy-url]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copyUrl).then(() => {
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    });
  });

  wrap.style.display = '';
}

async function removeChaperone(chapId) {
  const { error } = await supabase
    .from('field_trip_chaperones')
    .update({ removed_at: new Date().toISOString() })
    .eq('id', chapId);
  if (error) { alert('Failed to remove chaperone.'); return; }
  chaperoneList = chaperoneList.filter(c => c.id !== chapId);
  renderChaperoneTable();
  renderComplianceStats();
  // Reload chaperone counts in list cache
  const t = tripCache.find(t => t.id === currentTrip.id);
  if (t) loadChaperoneCounts([t.id]);
}

// ── Students ─────────────────────────────────────────────────────────────
async function loadStudents() {
  const tbody = document.getElementById('ftStudTableBody');
  tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:32px 0;">Loading...</td></tr>`;

  // Load all students matching grade_levels for this school
  const grades = currentTrip.grade_levels ?? [];
  let query = supabase
    .from('students')
    .select('id, first_name, last_name, grade_level, homeroom_teacher_id, employees!left(first_name, last_name)')
    .eq('school_id', profile.school_id)
    .eq('active', true)
    .order('last_name', { ascending: true });

  if (grades.length) {
    query = query.in('grade_level', grades);
  }

  const [{ data: students, error: sErr }, { data: ftStudents }] = await Promise.all([
    query,
    supabase.from('field_trip_students').select('student_id, attending').eq('field_trip_id', currentTrip.id),
  ]);

  if (sErr) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:32px 0;">Failed to load.</td></tr>`;
    return;
  }

  // Build attendance override map
  const overrides = new Map((ftStudents ?? []).map(r => [r.student_id, r.attending]));
  studentList = (students ?? []).map(s => ({
    ...s,
    attending: overrides.has(s.id) ? overrides.get(s.id) : true,
  }));

  renderStudentTable();
}

function renderStudentTable() {
  const tbody = document.getElementById('ftStudTableBody');
  if (!studentList.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:32px 0;">No students found for the selected grade levels.</td></tr>`;
    return;
  }

  const attending = studentList.filter(s => s.attending).length;
  tbody.innerHTML = '';
  studentList.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(s.last_name)}, ${esc(s.first_name)}</strong></td>
      <td>${s.grade_level ? esc(s.grade_level) : '<span class="muted">—</span>'}</td>
      <td>${s.employees ? esc(`${s.employees.first_name} ${s.employees.last_name}`) : '<span class="muted">—</span>'}</td>
      <td>
        <label class="student-attending-toggle">
          <input type="checkbox" data-student-id="${esc(s.id)}" ${s.attending ? 'checked' : ''}>
          ${s.attending ? 'Attending' : '<span style="color:#9ca3af;">Not attending</span>'}
        </label>
      </td>
    `;
    const cb = tr.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => toggleAttendance(s.id, cb.checked, tr));
    tbody.appendChild(tr);
  });

  const summary = document.createElement('tr');
  summary.innerHTML = `<td colspan="4" style="font-size:12px;color:var(--text-muted,#6b7280);padding:10px 16px;">${attending} of ${studentList.length} attending</td>`;
  tbody.appendChild(summary);
}

async function toggleAttendance(studentId, attending, tr) {
  const s = studentList.find(s => s.id === studentId);
  if (!s) return;
  s.attending = attending;

  const { error } = await supabase.from('field_trip_students').upsert({
    school_id: profile.school_id,
    field_trip_id: currentTrip.id,
    student_id: studentId,
    attending,
  }, { onConflict: 'field_trip_id,student_id' });

  if (error) { s.attending = !attending; renderStudentTable(); return; }

  const label = tr.querySelector('label');
  if (label) {
    label.querySelector('input').checked = attending;
    label.innerHTML = `
      <input type="checkbox" data-student-id="${esc(studentId)}" ${attending ? 'checked' : ''}>
      ${attending ? 'Attending' : '<span style="color:#9ca3af;">Not attending</span>'}
    `;
    label.querySelector('input').addEventListener('change', e => toggleAttendance(studentId, e.target.checked, tr));
  }
}

// ── Add Chaperone drawer ─────────────────────────────────────────────────
function wireChapDrawer() {
  document.getElementById('ftAddChaperoneBtn')?.addEventListener('click', openChapDrawer);
  document.getElementById('ftChapDrawerClose')?.addEventListener('click', closeChapDrawer);
  document.getElementById('ftChapDrawerOverlay')?.addEventListener('click', closeChapDrawer);
  document.getElementById('ftCancelChapBtn')?.addEventListener('click', closeChapDrawer);
  document.getElementById('ftChapClearBtn')?.addEventListener('click', clearChapSelection);
  document.getElementById('ftSaveChapBtn')?.addEventListener('click', saveChaperone);

  const search = document.getElementById('ftChapSearch');
  if (search) {
    search.addEventListener('input', debounce(searchGuardians, 250));
    search.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('ftChapResults').style.display = 'none'; });
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('.ft-typeahead-wrap')) {
      document.getElementById('ftChapResults').style.display = 'none';
    }
  });
}

function openChapDrawer() {
  clearChapSelection();
  document.getElementById('ftChapSearch').value = '';
  document.getElementById('ftChapResults').style.display = 'none';
  document.getElementById('ftChapIsDriver').checked = false;
  document.getElementById('ftChapDrawer').classList.add('open');
  document.getElementById('ftChapDrawerOverlay').classList.add('open');
  document.getElementById('ftChapSearch').focus();
}

function closeChapDrawer() {
  document.getElementById('ftChapDrawer').classList.remove('open');
  document.getElementById('ftChapDrawerOverlay').classList.remove('open');
  clearChapSelection();
}

function clearChapSelection() {
  selectedGuardian = null;
  document.getElementById('ftChapSelected').style.display = 'none';
  document.getElementById('ftSaveChapBtn').disabled = true;
}

async function searchGuardians() {
  const val = document.getElementById('ftChapSearch').value.trim();
  const results = document.getElementById('ftChapResults');
  if (val.length < 2) { results.style.display = 'none'; return; }

  results.innerHTML = `<div class="ft-typeahead-empty">Searching...</div>`;
  results.style.display = '';

  const { data } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, email, family_id')
    .eq('school_id', profile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${val}%,last_name.ilike.%${val}%,email.ilike.%${val}%`)
    .limit(8);

  if (!data?.length) {
    results.innerHTML = `<div class="ft-typeahead-empty">No guardians found.</div>`;
    return;
  }

  // Exclude guardians already added
  const existingIds = new Set(chaperoneList.map(c => c.guardian_id));
  const filtered = data.filter(g => !existingIds.has(g.id));

  if (!filtered.length) {
    results.innerHTML = `<div class="ft-typeahead-empty">All matching guardians are already added.</div>`;
    return;
  }

  results.innerHTML = '';
  filtered.forEach(g => {
    const item = document.createElement('div');
    item.className = 'ft-typeahead-item';
    item.innerHTML = `<strong>${esc(g.first_name)} ${esc(g.last_name)}</strong><span>${esc(g.email ?? '')}</span>`;
    item.addEventListener('mousedown', e => { e.preventDefault(); selectGuardian(g); });
    results.appendChild(item);
  });
}

function selectGuardian(g) {
  selectedGuardian = g;
  document.getElementById('ftChapResults').style.display = 'none';
  document.getElementById('ftChapSearch').value = '';
  document.getElementById('ftChapSelectedName').textContent  = `${g.first_name} ${g.last_name}`;
  document.getElementById('ftChapSelectedEmail').textContent = g.email ?? '';
  document.getElementById('ftChapSelected').style.display = '';
  document.getElementById('ftSaveChapBtn').disabled = false;
}

async function saveChaperone() {
  if (!selectedGuardian || !currentTrip) return;
  const btn = document.getElementById('ftSaveChapBtn');
  btn.disabled = true;

  const isDriver = document.getElementById('ftChapIsDriver').checked;
  const { error } = await supabase.from('field_trip_chaperones').insert({
    school_id:           profile.school_id,
    field_trip_id:       currentTrip.id,
    guardian_id:         selectedGuardian.id,
    is_driver:           isDriver,
    added_by_profile_id: profile.id,
  });

  if (error) {
    alert(error.code === '23505' ? 'This guardian is already added.' : 'Failed to add chaperone.');
    btn.disabled = false;
    return;
  }

  closeChapDrawer();
  await loadChaperones();
  loadChaperoneCounts([currentTrip.id]);
}

// ── CSV Export ───────────────────────────────────────────────────────────
document.getElementById('ftExportCsvBtn')?.addEventListener('click', exportChaperoneCSV);

function exportChaperoneCSV() {
  if (!currentTrip || !chaperoneList.length) return;

  const driversNeeded = currentTrip.drivers_needed;
  const headers = ['Name', 'Email', 'Driver', 'Students in family', 'BG Check status', 'BG Check expires'];
  if (driversNeeded) headers.push('MVR cleared', 'MVR expires');
  if (requiredFormTemplates.length) {
    requiredFormTemplates.forEach(t => headers.push(`Form: ${t.title}`));
    headers.push('Missing forms');
  }
  headers.push('Overall compliance');

  const rows = chaperoneList.map(chap => {
    const g     = chap.guardian ?? {};
    const email = (g.email ?? '').toLowerCase();
    const bg    = bgCheckMap.get(email) ?? null;
    const s     = computeComplianceStatus(g, bg, currentTrip.end_date ?? currentTrip.start_date, chap.is_driver);
    const kids  = (g.family?.students ?? []).map(k => `${k.first_name} ${k.last_name}`).join('; ');
    const row = [
      `${g.last_name ?? ''}, ${g.first_name ?? ''}`,
      g.email ?? '',
      chap.is_driver ? 'Yes' : 'No',
      kids,
      bg?.status ?? 'No record',
      bg?.expires_at ?? '',
    ];
    if (driversNeeded) {
      row.push(bg?.mvr_cleared_at ? 'Yes' : 'No', bg?.mvr_expires_at ?? '');
    }
    if (requiredFormTemplates.length) {
      const signed  = agreementsMap.get(email) ?? new Set();
      const missing = getMissingForms(g.email);
      requiredFormTemplates.forEach(t => row.push(signed.has(t.id) ? 'Signed' : 'Not signed'));
      row.push(missing.map(t => t.title).join('; ') || 'None');
    }
    row.push(s);
    return row;
  });

  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `${currentTrip.name.replace(/[^a-z0-9]/gi, '_')}_chaperones.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Trip create/edit drawer ───────────────────────────────────────────────
function wireTripDrawer() {
  document.getElementById('ftTripDrawerClose')?.addEventListener('click', closeTripDrawer);
  document.getElementById('ftTripDrawerOverlay')?.addEventListener('click', closeTripDrawer);
  document.getElementById('ftCancelTripDrawerBtn')?.addEventListener('click', closeTripDrawer);
  document.getElementById('ftSaveTripBtn')?.addEventListener('click', saveTrip);
  buildGradeCheckboxes();

  const mgrSearch = document.getElementById('ftMgrSearch');
  if (mgrSearch) {
    mgrSearch.addEventListener('input', debounce(searchManagerProfiles, 250));
    mgrSearch.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('ftMgrResults').style.display = 'none'; });
  }
  document.addEventListener('click', e => {
    if (!e.target.closest('#ftMgrSearchWrap')) {
      const r = document.getElementById('ftMgrResults');
      if (r) r.style.display = 'none';
    }
  });
}

function buildGradeCheckboxes() {
  const wrap = document.getElementById('ftDrawerGrades');
  if (!wrap) return;
  GRADE_LEVELS.forEach(g => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;';
    label.innerHTML = `<input type="checkbox" value="${esc(g)}" style="width:14px;height:14px;"> ${esc(g)}`;
    wrap.appendChild(label);
  });
}

function openTripDrawer(trip) {
  drawerManagers = trip ? currentManagers.map(m => ({ ...m })) : [];
  renderDrawerManagerChips();
  document.getElementById('ftDrawerTitle').textContent = trip ? 'Edit Trip' : 'New Trip';
  document.getElementById('ftDrawerTripId').value  = trip?.id ?? '';
  document.getElementById('ftDrawerName').value    = trip?.name ?? '';
  document.getElementById('ftDrawerDest').value    = trip?.destination ?? '';
  document.getElementById('ftDrawerDate').value    = trip?.start_date ?? '';
  document.getElementById('ftDrawerEndDate').value = trip?.end_date ?? '';
  document.getElementById('ftDrawerDepart').value  = trip?.depart_at ?? '';
  document.getElementById('ftDrawerReturn').value  = trip?.return_at ?? '';
  document.getElementById('ftDrawerMaxChap').value = trip?.max_chaperones ?? '';
  document.getElementById('ftDrawerDrivers').checked = trip?.drivers_needed ?? false;
  document.getElementById('ftDrawerNotes').value   = trip?.notes ?? '';

  const selected = new Set(trip?.grade_levels ?? []);
  document.querySelectorAll('#ftDrawerGrades input[type="checkbox"]').forEach(cb => {
    cb.checked = selected.has(cb.value);
  });

  document.getElementById('ftTripDrawer').classList.add('open');
  document.getElementById('ftTripDrawerOverlay').classList.add('open');
  document.getElementById('ftDrawerName').focus();
}

function closeTripDrawer() {
  document.getElementById('ftTripDrawer').classList.remove('open');
  document.getElementById('ftTripDrawerOverlay').classList.remove('open');
}

async function saveTrip() {
  const id        = document.getElementById('ftDrawerTripId').value;
  const name      = document.getElementById('ftDrawerName').value.trim();
  const startDate = document.getElementById('ftDrawerDate').value;
  const endDate   = document.getElementById('ftDrawerEndDate').value;

  if (!name)      { alert('Trip name is required.'); return; }
  if (!startDate) { alert('Start date is required.'); return; }
  if (endDate && endDate < startDate) { alert('End date cannot be before start date.'); return; }

  const grades = [...document.querySelectorAll('#ftDrawerGrades input:checked')].map(cb => cb.value);

  const payload = {
    school_id:      profile.school_id,
    name,
    destination:    document.getElementById('ftDrawerDest').value.trim() || null,
    start_date:     startDate,
    end_date:       endDate || null,
    depart_at:      document.getElementById('ftDrawerDepart').value  || null,
    return_at:      document.getElementById('ftDrawerReturn').value  || null,
    grade_levels:   grades,
    drivers_needed: document.getElementById('ftDrawerDrivers').checked,
    max_chaperones: document.getElementById('ftDrawerMaxChap').value ? parseInt(document.getElementById('ftDrawerMaxChap').value, 10) : null,
    notes:          document.getElementById('ftDrawerNotes').value.trim() || null,
  };

  const btn = document.getElementById('ftSaveTripBtn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  let error;
  if (id) {
    ({ error } = await supabase.from('field_trips').update(payload).eq('id', id));
    if (!error) {
      const idx = tripCache.findIndex(t => t.id === id);
      if (idx >= 0) tripCache[idx] = { ...tripCache[idx], ...payload };
      if (currentTrip?.id === id) { currentTrip = { ...currentTrip, ...payload }; renderTripHeader(currentTrip); }
      // Delta: insert new managers, delete removed ones
      const editorEntry = { profile_id: profile.id, name: '', email: '' };
      const allEditMgrs = drawerManagers.some(m => m.profile_id === profile.id)
        ? drawerManagers
        : [editorEntry, ...drawerManagers];
      const existingIds = new Set(currentManagers.map(m => m.profile_id));
      const toAdd = allEditMgrs.filter(m => !existingIds.has(m.profile_id));
      const keptIds = new Set(allEditMgrs.map(m => m.profile_id));
      const toRemove = currentManagers.filter(m => !keptIds.has(m.profile_id) && m.profile_id !== profile.id);
      if (toAdd.length) {
        const { error: mgrErr } = await supabase.from('field_trip_managers').insert(
          toAdd.map(m => ({ field_trip_id: id, profile_id: m.profile_id, added_by: profile.id }))
        );
        if (mgrErr) console.error('manager insert failed:', mgrErr);
      }
      if (toRemove.length) {
        await supabase.from('field_trip_managers').delete()
          .eq('field_trip_id', id).in('profile_id', toRemove.map(m => m.profile_id));
      }
      await loadManagers(id);
    }
  } else {
    const { data, error: insertErr } = await supabase.from('field_trips').insert({ ...payload, created_by_profile_id: profile.id }).select().single();
    error = insertErr;
    if (!error && data) {
      tripCache.unshift(data);
      // Insert creator first (bootstrap), then any additional drawer managers
      await supabase.from('field_trip_managers').insert(
        { field_trip_id: data.id, profile_id: profile.id, added_by: profile.id }
      );
      const others = drawerManagers.filter(m => m.profile_id !== profile.id);
      if (others.length) {
        await supabase.from('field_trip_managers').insert(
          others.map(m => ({ field_trip_id: data.id, profile_id: m.profile_id, added_by: profile.id }))
        );
      }
      await loadManagers(data.id);
    }
  }

  btn.disabled = false;
  btn.textContent = 'Save Trip';

  if (error) { alert('Failed to save trip.'); return; }

  closeTripDrawer();
  renderTripList();
}

// ── Trip managers ────────────────────────────────────────────────────────
async function loadManagers(tripId) {
  const { data: rows, error: rpcErr } = await supabase.rpc('get_trip_managers', { trip_id: tripId });
  if (rpcErr) { console.error('get_trip_managers failed:', rpcErr); currentManagers = []; renderManagerChips(); return; }
  const ids = (rows ?? []).map(r => r.profile_id).filter(Boolean);
  if (!ids.length) { currentManagers = []; renderManagerChips(); return; }
  const { data: profs } = await supabase.from('profiles').select('id, display_name, email').in('id', ids);
  currentManagers = ids.map(pid => {
    const prof = (profs ?? []).find(p => p.id === pid) ?? {};
    return { profile_id: pid, name: prof.display_name ?? prof.email ?? '', email: prof.email ?? '' };
  });
  renderManagerChips();
}

async function removeManager(profileId) {
  if (!currentTrip) return;
  await supabase.from('field_trip_managers')
    .delete()
    .eq('field_trip_id', currentTrip.id)
    .eq('profile_id', profileId);
  currentManagers = currentManagers.filter(m => m.profile_id !== profileId);
  renderManagerChips();
}

function renderManagerChips() {
  const wrap = document.getElementById('ftManagerChips');
  if (!wrap) return;
  if (!currentManagers.length) {
    wrap.innerHTML = '<span style="font-size:12px;color:#9ca3af;">No managers assigned</span>';
    return;
  }
  wrap.innerHTML = currentManagers.map(m => `
    <span style="display:inline-flex;align-items:center;gap:4px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:999px;padding:2px 10px;font-size:12px;color:#1d4ed8;">
      ${esc(m.name)}
      <button data-remove-mgr="${esc(m.profile_id)}" style="background:none;border:none;cursor:pointer;padding:0;color:#93c5fd;font-size:14px;line-height:1;" title="Remove">&times;</button>
    </span>`).join('');
  wrap.querySelectorAll('[data-remove-mgr]').forEach(btn => {
    btn.addEventListener('click', () => removeManager(btn.dataset.removeMgr));
  });
}

// Drawer manager typeahead
async function searchManagerProfiles() {
  const val = document.getElementById('ftMgrSearch')?.value.trim();
  const results = document.getElementById('ftMgrResults');
  if (!results) return;
  if (!val || val.length < 2) { results.style.display = 'none'; return; }

  results.innerHTML = `<div class="ft-typeahead-empty">Searching...</div>`;
  results.style.display = '';

  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('school_id', profile.school_id)
    .eq('can_login', true)
    .or(`display_name.ilike.%${val}%,email.ilike.%${val}%`)
    .limit(8);

  const existingIds = new Set(drawerManagers.map(m => m.profile_id));
  const filtered = (data ?? []).filter(p => !existingIds.has(p.id));

  if (!filtered.length) {
    results.innerHTML = `<div class="ft-typeahead-empty">No staff found.</div>`;
    return;
  }

  results.innerHTML = '';
  filtered.forEach(p => {
    const item = document.createElement('div');
    item.className = 'ft-typeahead-item';
    item.innerHTML = `<strong>${esc(p.display_name ?? p.email)}</strong><span>${esc(p.email ?? '')}</span>`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      drawerManagers.push({ profile_id: p.id, name: p.display_name ?? p.email ?? '', email: p.email ?? '' });
      renderDrawerManagerChips();
      document.getElementById('ftMgrSearch').value = '';
      results.style.display = 'none';
    });
    results.appendChild(item);
  });
}

function renderDrawerManagerChips() {
  const wrap = document.getElementById('ftDrawerMgrChips');
  if (!wrap) return;
  wrap.innerHTML = drawerManagers.map((m, i) => `
    <span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:999px;padding:2px 10px;font-size:12px;color:#15803d;">
      ${esc(m.name)}
      <button data-remove-drawer-mgr="${i}" style="background:none;border:none;cursor:pointer;padding:0;color:#86efac;font-size:14px;line-height:1;" title="Remove">&times;</button>
    </span>`).join('');
  wrap.querySelectorAll('[data-remove-drawer-mgr]').forEach(btn => {
    btn.addEventListener('click', () => {
      drawerManagers.splice(Number(btn.dataset.removeDrawerMgr), 1);
      renderDrawerManagerChips();
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────
function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr  = parseInt(h, 10);
  const ampm = hr >= 12 ? 'PM' : 'AM';
  return `${hr % 12 || 12}:${m} ${ampm}`;
}

// ── Boot ─────────────────────────────────────────────────────────────────
init();

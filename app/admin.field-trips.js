import { supabase } from './admin.supabase.js';
import { initPage } from './admin.auth.js';
import { esc, debounce, loadSchoolConfig, GRADE_ORDER, fmtTime, todayISO, dbError } from './admin.shared.js';

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
let drawerInstallments   = [];   // installment rows being built in trip drawer
let paymentCache         = [];   // field_trip_payments rows for current trip
let paymentStudentMap    = new Map();
let paymentChaperoneMap  = new Map();
let pendingPaymentId     = null; // payment row targeted by the record-payment modal
let paymentsLoaded       = false;

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

  document.getElementById('ftPaymentModalCancel')?.addEventListener('click', closePaymentModal);
  document.getElementById('ftPaymentModalSave')?.addEventListener('click', savePayment);
  document.getElementById('ftPaymentModal')?.addEventListener('click', e => {
    if (e.target.id === 'ftPaymentModal') closePaymentModal();
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
    .select('id, name, destination, start_date, end_date, depart_at, return_at, grade_levels, drivers_needed, max_chaperones, notes, status, created_at, payment_required, student_cost, chaperone_payment_required, chaperone_cost, allow_installments, installment_schedule, payment_due_date')
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

  paymentsLoaded = false;
  paymentCache   = [];
  document.getElementById('ftPaymentsTab').style.display = trip.payment_required ? '' : 'none';

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
  if (error) { dbError(error, 'Failed to cancel trip'); return; }
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
  document.getElementById('ftTabPayments').style.display   = tab === 'payments'   ? '' : 'none';

  if (tab === 'students' && !studentList.length) loadStudents();
  if (tab === 'payments') loadPayments();
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

  const hasDrivers = chaperoneList.some(c => c.is_driver);
  const planBtn = document.getElementById('ftPlanVehiclesBtn');
  if (planBtn) {
    planBtn.style.display = hasDrivers ? '' : 'none';
    planBtn.onclick = () => {
      window.location.href = `/app/field-trip-vehicles.html?trip=${currentTrip.id}`;
    };
  }
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
  if (error) { dbError(error, 'Failed to remove chaperone'); return; }
  chaperoneList = chaperoneList.filter(c => c.id !== chapId);
  renderChaperoneTable();
  renderComplianceStats();
  const planBtn = document.getElementById('ftPlanVehiclesBtn');
  if (planBtn) planBtn.style.display = chaperoneList.some(c => c.is_driver) ? '' : 'none';
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

  if (currentTrip.payment_required) {
    if (!attending) {
      await supabase.from('field_trip_payments')
        .delete()
        .eq('field_trip_id', currentTrip.id)
        .eq('student_id', studentId);
    } else {
      await ensurePaymentRows();
    }
    paymentsLoaded = false;
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

  document.getElementById('ftChapIsDriver')?.addEventListener('change', e => {
    document.getElementById('ftChapCapacityWrap').style.display = e.target.checked ? '' : 'none';
  });
}

function openChapDrawer() {
  clearChapSelection();
  document.getElementById('ftChapSearch').value = '';
  document.getElementById('ftChapResults').style.display = 'none';
  document.getElementById('ftChapIsDriver').checked = false;
  document.getElementById('ftChapCapacity').value = '';
  document.getElementById('ftChapCapacityWrap').style.display = 'none';
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

  const isDriver   = document.getElementById('ftChapIsDriver').checked;
  const capInput   = document.getElementById('ftChapCapacity').value;
  const vehicleCap = isDriver && capInput ? (parseInt(capInput, 10) || null) : null;
  const { error } = await supabase.from('field_trip_chaperones').insert({
    school_id:           profile.school_id,
    field_trip_id:       currentTrip.id,
    guardian_id:         selectedGuardian.id,
    is_driver:           isDriver,
    vehicle_capacity:    vehicleCap,
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

  // Payment toggles
  document.getElementById('ftDrawerPaymentRequired')?.addEventListener('change', e => {
    document.getElementById('ftDrawerPaymentFields').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('ftDrawerChaperonePayment')?.addEventListener('change', e => {
    document.getElementById('ftDrawerChaperoneCostWrap').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('ftDrawerAllowInstallments')?.addEventListener('change', e => {
    document.getElementById('ftDrawerInstallmentWrap').style.display = e.target.checked ? '' : 'none';
  });
  document.getElementById('ftDrawerStudentCost')?.addEventListener('input', updateInstallmentTotal);
  document.getElementById('ftDrawerAddInstallmentBtn')?.addEventListener('click', () => {
    drawerInstallments.push({ label: '', amount: 0, due_date: '' });
    renderDrawerInstallments();
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

  // Payment settings
  const payReq = document.getElementById('ftDrawerPaymentRequired');
  payReq.checked = trip?.payment_required ?? false;
  document.getElementById('ftDrawerPaymentFields').style.display    = payReq.checked ? '' : 'none';
  document.getElementById('ftDrawerStudentCost').value              = trip?.student_cost ?? '';
  document.getElementById('ftDrawerPaymentDueDate').value           = trip?.payment_due_date ?? '';
  const chapPay = document.getElementById('ftDrawerChaperonePayment');
  chapPay.checked = trip?.chaperone_payment_required ?? false;
  document.getElementById('ftDrawerChaperoneCostWrap').style.display = chapPay.checked ? '' : 'none';
  document.getElementById('ftDrawerChaperoneCost').value             = trip?.chaperone_cost ?? '';
  const allowInst = document.getElementById('ftDrawerAllowInstallments');
  allowInst.checked = trip?.allow_installments ?? false;
  document.getElementById('ftDrawerInstallmentWrap').style.display  = allowInst.checked ? '' : 'none';
  drawerInstallments = (trip?.installment_schedule ?? []).map(i => ({ ...i }));
  renderDrawerInstallments();

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

  const paymentRequired = document.getElementById('ftDrawerPaymentRequired').checked;
  const studentCost     = document.getElementById('ftDrawerStudentCost').value ? parseFloat(document.getElementById('ftDrawerStudentCost').value) : null;
  const allowInst       = document.getElementById('ftDrawerAllowInstallments').checked;
  const instSchedule    = getInstallmentSchedule();

  if (paymentRequired && allowInst && instSchedule?.length && studentCost != null) {
    const instTotal = instSchedule.reduce((s, i) => s + (i.amount || 0), 0);
    if (Math.abs(instTotal - studentCost) > 0.01) {
      alert(`Installment total ($${instTotal.toFixed(2)}) must equal the student cost ($${studentCost.toFixed(2)}).`);
      return;
    }
  }

  const grades = [...document.querySelectorAll('#ftDrawerGrades input:checked')].map(cb => cb.value);

  const payload = {
    school_id:                  profile.school_id,
    name,
    destination:                document.getElementById('ftDrawerDest').value.trim() || null,
    start_date:                 startDate,
    end_date:                   endDate || null,
    depart_at:                  document.getElementById('ftDrawerDepart').value  || null,
    return_at:                  document.getElementById('ftDrawerReturn').value  || null,
    grade_levels:               grades,
    drivers_needed:             document.getElementById('ftDrawerDrivers').checked,
    max_chaperones:             document.getElementById('ftDrawerMaxChap').value ? parseInt(document.getElementById('ftDrawerMaxChap').value, 10) : null,
    notes:                      document.getElementById('ftDrawerNotes').value.trim() || null,
    payment_required:           paymentRequired,
    student_cost:               studentCost,
    chaperone_payment_required: document.getElementById('ftDrawerChaperonePayment').checked,
    chaperone_cost:             document.getElementById('ftDrawerChaperoneCost').value ? parseFloat(document.getElementById('ftDrawerChaperoneCost').value) : null,
    allow_installments:         allowInst,
    installment_schedule:       instSchedule,
    payment_due_date:           document.getElementById('ftDrawerPaymentDueDate').value || null,
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
      if (currentTrip?.id === id) {
        currentTrip = { ...currentTrip, ...payload };
        renderTripHeader(currentTrip);
        document.getElementById('ftPaymentsTab').style.display = currentTrip.payment_required ? '' : 'none';
        if (!currentTrip.payment_required && activeTab === 'payments') switchTab('chaperones');
        paymentsLoaded = false;
      }
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

  if (error) { dbError(error, 'Failed to save trip'); return; }

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

// Search can_login profiles by employee name or email — returns [{id, name, email}]
async function searchStaffProfiles(val) {
  // Search employees by first/last name first, then match to their profiles
  const { data: emps } = await supabase
    .from('employees')
    .select('id, first_name, last_name, email')
    .eq('school_id', profile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${val}%,last_name.ilike.%${val}%,email.ilike.%${val}%`)
    .limit(20);

  if (!emps?.length) return [];

  const { data: profs } = await supabase
    .from('profiles')
    .select('id, employee_id, email')
    .eq('school_id', profile.school_id)
    .eq('can_login', true)
    .in('employee_id', emps.map(e => e.id));

  return (profs ?? []).map(p => {
    const emp = emps.find(e => e.id === p.employee_id) ?? {};
    const name = [emp.first_name, emp.last_name].filter(Boolean).join(' ') || p.email;
    return { id: p.id, name, email: p.email ?? emp.email ?? '' };
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

  const found = await searchStaffProfiles(val);
  const existingIds = new Set(drawerManagers.map(m => m.profile_id));
  const filtered = found.filter(p => !existingIds.has(p.id));

  if (!filtered.length) {
    results.innerHTML = `<div class="ft-typeahead-empty">No staff found.</div>`;
    return;
  }

  results.innerHTML = '';
  filtered.forEach(p => {
    const item = document.createElement('div');
    item.className = 'ft-typeahead-item';
    item.innerHTML = `<strong>${esc(p.name)}</strong><span>${esc(p.email)}</span>`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      drawerManagers.push({ profile_id: p.id, name: p.name, email: p.email });
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

// ── Payment drawer helpers ────────────────────────────────────────────────
function renderDrawerInstallments() {
  const list = document.getElementById('ftDrawerInstallmentList');
  if (!list) return;
  list.innerHTML = '';
  drawerInstallments.forEach((inst, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;';
    row.innerHTML = `
      <input type="text" class="admin-input" value="${esc(inst.label ?? '')}" placeholder="Label (e.g. Deposit)" style="flex:2;font-size:12px;padding:5px 8px;">
      <input type="number" class="admin-input" value="${inst.amount || ''}" min="0" step="0.01" placeholder="$0.00" style="flex:1;font-size:12px;padding:5px 8px;">
      <input type="date" class="admin-input" value="${inst.due_date ?? ''}" style="flex:1.5;font-size:12px;padding:5px 8px;">
      <button type="button" style="background:none;border:none;cursor:pointer;padding:0 4px;color:#9ca3af;font-size:18px;line-height:1;">&times;</button>
    `;
    const inputs = row.querySelectorAll('input');
    const delBtn = row.querySelector('button');
    inputs[0].addEventListener('input', () => { drawerInstallments[i].label    = inputs[0].value; });
    inputs[1].addEventListener('input', () => { drawerInstallments[i].amount   = parseFloat(inputs[1].value) || 0; updateInstallmentTotal(); });
    inputs[2].addEventListener('input', () => { drawerInstallments[i].due_date = inputs[2].value; });
    delBtn.addEventListener('click',   () => { drawerInstallments.splice(i, 1); renderDrawerInstallments(); });
    list.appendChild(row);
  });
  updateInstallmentTotal();
}

function updateInstallmentTotal() {
  const el = document.getElementById('ftDrawerInstallmentTotal');
  if (!el || !drawerInstallments.length) { if (el) el.textContent = ''; return; }
  const total       = drawerInstallments.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
  const studentCost = parseFloat(document.getElementById('ftDrawerStudentCost')?.value) || 0;
  const match       = studentCost > 0 && Math.abs(total - studentCost) < 0.01;
  const color       = match ? '#15803d' : (studentCost > 0 ? '#dc2626' : '#6b7280');
  el.innerHTML      = `Total: <strong style="color:${color};">$${total.toFixed(2)}</strong>${studentCost ? ` of $${studentCost.toFixed(2)}${match ? ' ✓' : ' — must equal student cost'}` : ''}`;
}

function getInstallmentSchedule() {
  if (!document.getElementById('ftDrawerAllowInstallments')?.checked) return null;
  if (!drawerInstallments.length) return null;
  return drawerInstallments.map(i => ({
    label:    (i.label || 'Payment').trim(),
    amount:   parseFloat(i.amount) || 0,
    due_date: i.due_date || null,
  }));
}

// ── Payments tab ──────────────────────────────────────────────────────────
async function loadPayments() {
  const wrap = document.getElementById('ftTabPayments');
  if (!wrap || !currentTrip) return;

  if (!currentTrip.payment_required) {
    wrap.innerHTML = '<p class="muted" style="padding:40px;text-align:center;">Payment tracking is not enabled for this trip.</p>';
    return;
  }

  wrap.innerHTML = '<p class="muted" style="padding:40px;text-align:center;">Loading...</p>';

  if (!paymentsLoaded) {
    await ensurePaymentRows();
    paymentsLoaded = true;
  }

  const { data: payments, error } = await supabase
    .from('field_trip_payments')
    .select('*')
    .eq('field_trip_id', currentTrip.id)
    .order('payer_type')
    .order('created_at');

  if (error) {
    wrap.innerHTML = '<p class="muted" style="padding:40px;text-align:center;">Failed to load payment data.</p>';
    return;
  }

  paymentCache = payments ?? [];

  const studentIds   = paymentCache.filter(p => p.student_id).map(p => p.student_id);
  const chaperoneIds = paymentCache.filter(p => p.chaperone_id).map(p => p.chaperone_id);

  const [studRes, chapRes] = await Promise.all([
    studentIds.length
      ? supabase.from('students').select('id, first_name, last_name, grade_level').in('id', studentIds)
      : Promise.resolve({ data: [] }),
    chaperoneIds.length
      ? supabase.from('field_trip_chaperones').select('id, guardian:guardians(first_name, last_name, email)').in('id', chaperoneIds)
      : Promise.resolve({ data: [] }),
  ]);

  paymentStudentMap   = new Map((studRes.data ?? []).map(s => [s.id, s]));
  paymentChaperoneMap = new Map((chapRes.data ?? []).map(c => [c.id, c.guardian]));

  renderPaymentTab(wrap);
}

async function ensurePaymentRows() {
  const studentCost   = currentTrip.student_cost   ?? 0;
  const chaperoneCost = currentTrip.chaperone_cost  ?? studentCost;
  const grades        = currentTrip.grade_levels    ?? [];

  if (grades.length) {
    const [{ data: allStudents }, { data: excluded }] = await Promise.all([
      supabase.from('students').select('id').eq('school_id', profile.school_id).eq('active', true).in('grade_level', grades),
      supabase.from('field_trip_students').select('student_id').eq('field_trip_id', currentTrip.id).eq('attending', false),
    ]);
    const excludedIds = new Set((excluded ?? []).map(r => r.student_id));
    const attending   = (allStudents ?? []).filter(s => !excludedIds.has(s.id));
    if (attending.length) {
      await supabase.from('field_trip_payments').upsert(
        attending.map(s => ({ school_id: profile.school_id, field_trip_id: currentTrip.id, student_id: s.id, payer_type: 'student', amount_due: studentCost })),
        { onConflict: 'field_trip_id,student_id', ignoreDuplicates: true }
      );
    }
  }

  if (currentTrip.chaperone_payment_required) {
    const { data: chaperones } = await supabase
      .from('field_trip_chaperones').select('id')
      .eq('field_trip_id', currentTrip.id).is('removed_at', null);
    if (chaperones?.length) {
      await supabase.from('field_trip_payments').upsert(
        chaperones.map(c => ({ school_id: profile.school_id, field_trip_id: currentTrip.id, chaperone_id: c.id, payer_type: 'chaperone', amount_due: chaperoneCost })),
        { onConflict: 'field_trip_id,chaperone_id', ignoreDuplicates: true }
      );
    }
  }
}

function renderPaymentTab(wrap) {
  const schedule   = currentTrip.installment_schedule ?? [];
  const students   = paymentCache.filter(p => p.payer_type === 'student');
  const chaperones = paymentCache.filter(p => p.payer_type === 'chaperone');
  const today      = new Date(); today.setHours(0, 0, 0, 0);

  const countByStatus = s => paymentCache.filter(p => p.status === s).length;
  const paid = countByStatus('paid'), partial = countByStatus('partial'),
        unpaid = countByStatus('unpaid'), waived = countByStatus('waived');

  let html = '';

  // Installment schedule bar
  if (schedule.length) {
    html += `<div class="pay-inst-bar">
      <div style="width:100%;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;margin-bottom:4px;">Installment schedule</div>`;
    schedule.forEach(inst => {
      const due     = inst.due_date ? new Date(inst.due_date + 'T12:00:00') : null;
      const isPast  = due && due < today;
      const cls     = isPast ? 'pay-inst-overdue' : 'pay-inst-future';
      const dateStr = due ? due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      html += `<div class="pay-inst-badge ${cls}">
        <span style="font-size:11px;font-weight:700;">${esc(inst.label)}</span>
        <span style="font-size:14px;font-weight:800;">$${parseFloat(inst.amount || 0).toFixed(2)}</span>
        ${dateStr ? `<span style="font-size:10px;">${dateStr}</span>` : ''}
        ${isPast ? `<span style="font-size:9px;font-weight:700;text-transform:uppercase;margin-top:1px;">Past due</span>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  // Summary strip
  html += `<div class="pay-summary-strip">
    <div class="pay-summary-card"><div class="val">${paid}</div><div class="lbl">Paid</div></div>
    <div class="pay-summary-card${partial ? ' warn' : ''}"><div class="val">${partial}</div><div class="lbl">Partial</div></div>
    <div class="pay-summary-card${unpaid ? ' alert' : ''}"><div class="val">${unpaid}</div><div class="lbl">Unpaid</div></div>
    ${waived ? `<div class="pay-summary-card"><div class="val">${waived}</div><div class="lbl">Waived</div></div>` : ''}
  </div>`;

  const sortedStudents = [...students].sort((a, b) => {
    const sa = paymentStudentMap.get(a.student_id);
    const sb = paymentStudentMap.get(b.student_id);
    const last  = (sa?.last_name  ?? '').localeCompare(sb?.last_name  ?? '');
    const first = (sa?.first_name ?? '').localeCompare(sb?.first_name ?? '');
    return last !== 0 ? last : first;
  });

  if (sortedStudents.length) {
    html += `<h4 style="font-size:12px;font-weight:700;color:#374151;margin:0 0 10px 0;text-transform:uppercase;letter-spacing:0.05em;">Students</h4>`;
    html += buildPaymentTable(sortedStudents, 'student');
  } else if (!(currentTrip.grade_levels?.length)) {
    html += `<p class="muted" style="font-size:13px;margin-bottom:16px;">Set grade levels on this trip to auto-populate student payment records.</p>`;
  }

  if (currentTrip.chaperone_payment_required) {
    if (chaperones.length) {
      html += `<h4 style="font-size:12px;font-weight:700;color:#374151;margin:16px 0 10px 0;text-transform:uppercase;letter-spacing:0.05em;">Chaperones</h4>`;
      html += buildPaymentTable(chaperones, 'chaperone');
    } else {
      html += `<p class="muted" style="font-size:13px;margin-top:8px;">No active chaperones to track.</p>`;
    }
  }

  wrap.innerHTML = html;

  wrap.querySelectorAll('[data-record-payment]').forEach(btn => {
    btn.addEventListener('click', () => openPaymentModal(btn.dataset.recordPayment, btn.dataset.name, parseFloat(btn.dataset.balance)));
  });
  wrap.querySelectorAll('[data-waive-payment]').forEach(btn => {
    btn.addEventListener('click', () => waivePayment(btn.dataset.waivePayment, btn.dataset.name));
  });
}

function buildPaymentTable(rows, type) {
  const gradeCol = type === 'student';
  let html = `<div class="panel" style="padding:0;overflow:hidden;margin-bottom:20px;">
    <table class="admin-table">
      <thead><tr>
        <th>Name</th>${gradeCol ? '<th>Grade</th>' : ''}
        <th>Due</th><th>Paid</th><th>Balance</th><th>Status</th><th>Last payment</th><th></th>
      </tr></thead><tbody>`;

  const statusCls = { paid: 'pay-status-paid', partial: 'pay-status-partial', unpaid: 'pay-status-unpaid', waived: 'pay-status-waived' };

  rows.forEach(p => {
    const balance    = Math.max(0, (p.amount_due || 0) - (p.amount_paid || 0));
    const badge      = `<span class="comp-chip ${statusCls[p.status] ?? ''}">${p.status}</span>`;
    const lastDate   = p.last_payment_date
      ? new Date(p.last_payment_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    let name = '—', grade = '—';
    if (type === 'student') {
      const s = paymentStudentMap.get(p.student_id);
      if (s) { name = `${esc(s.last_name)}, ${esc(s.first_name)}`; grade = esc(s.grade_level ?? '—'); }
    } else {
      const g = paymentChaperoneMap.get(p.chaperone_id);
      if (g) name = `${esc(g.first_name)} ${esc(g.last_name)}`;
    }
    const canAct = p.status !== 'paid' && p.status !== 'waived';
    const actions = canAct
      ? `<button class="btn btn-sm" data-record-payment="${p.id}" data-name="${name}" data-balance="${balance}" style="font-size:11px;">Record</button>
         <button data-waive-payment="${p.id}" data-name="${name}" style="background:none;border:none;cursor:pointer;font-size:11px;color:#9ca3af;padding:4px 6px;">Waive</button>`
      : '';

    html += `<tr>
      <td><strong>${name}</strong></td>
      ${gradeCol ? `<td style="font-size:12px;">${grade}</td>` : ''}
      <td>$${(p.amount_due  || 0).toFixed(2)}</td>
      <td>$${(p.amount_paid || 0).toFixed(2)}</td>
      <td>${balance > 0 ? `<span style="color:#dc2626;font-weight:600;">$${balance.toFixed(2)}</span>` : '<span style="color:#15803d;">—</span>'}</td>
      <td>${badge}</td>
      <td style="font-size:12px;color:#6b7280;">${lastDate}</td>
      <td style="white-space:nowrap;">${actions}</td>
    </tr>`;
  });

  html += `</tbody></table></div>`;
  return html;
}

// ── Payment modal ─────────────────────────────────────────────────────────
function openPaymentModal(paymentId, name, balanceDue) {
  pendingPaymentId = paymentId;
  document.getElementById('ftPaymentModalTitle').textContent = `Record payment — ${name}`;
  document.getElementById('ftPaymentModalAmount').value      = balanceDue > 0 ? balanceDue.toFixed(2) : '';
  document.getElementById('ftPaymentModalDate').value        = todayISO();
  document.getElementById('ftPaymentModalNotes').value       = '';
  document.getElementById('ftPaymentModal').classList.add('open');
  setTimeout(() => document.getElementById('ftPaymentModalAmount').focus(), 50);
}

function closePaymentModal() {
  document.getElementById('ftPaymentModal').classList.remove('open');
  pendingPaymentId = null;
}

async function savePayment() {
  const amount = parseFloat(document.getElementById('ftPaymentModalAmount').value);
  if (!amount || amount <= 0) { alert('Enter a valid amount greater than $0.'); return; }

  const receivedDate = document.getElementById('ftPaymentModalDate').value  || todayISO();
  const notes        = document.getElementById('ftPaymentModalNotes').value.trim() || null;
  const rec          = paymentCache.find(p => p.id === pendingPaymentId);
  if (!rec) return;

  const btn = document.getElementById('ftPaymentModalSave');
  btn.disabled = true; btn.textContent = 'Saving...';

  const newPaid   = (parseFloat(rec.amount_paid) || 0) + amount;
  const newStatus = computePaymentStatus(newPaid, rec.amount_due);

  const { error: logErr } = await supabase.from('field_trip_payment_log').insert({
    payment_id:    pendingPaymentId,
    amount,
    received_date: receivedDate,
    notes,
    recorded_by:   profile.id,
  });

  if (logErr) {
    dbError(logErr, 'Failed to save payment log'); btn.disabled = false; btn.textContent = 'Save'; return;
  }

  const { error: updErr } = await supabase.from('field_trip_payments').update({
    amount_paid:       newPaid,
    status:            newStatus,
    last_payment_date: receivedDate,
    updated_by:        profile.id,
    updated_at:        new Date().toISOString(),
  }).eq('id', pendingPaymentId);

  if (!updErr) {
    const idx = paymentCache.findIndex(p => p.id === pendingPaymentId);
    if (idx >= 0) paymentCache[idx] = { ...paymentCache[idx], amount_paid: newPaid, status: newStatus, last_payment_date: receivedDate };
  }

  btn.disabled = false; btn.textContent = 'Save';
  closePaymentModal();
  renderPaymentTab(document.getElementById('ftTabPayments'));
}

async function waivePayment(paymentId, name) {
  const reason = prompt(`Waive payment for ${name}?\nEnter a reason (optional, press OK to confirm):`);
  if (reason === null) return;

  const { error } = await supabase.from('field_trip_payments').update({
    status:       'waived',
    waive_reason: reason || null,
    updated_by:   profile.id,
    updated_at:   new Date().toISOString(),
  }).eq('id', paymentId);

  if (error) { dbError(error, 'Failed to waive payment'); return; }

  const idx = paymentCache.findIndex(p => p.id === paymentId);
  if (idx >= 0) paymentCache[idx] = { ...paymentCache[idx], status: 'waived', waive_reason: reason || null };
  renderPaymentTab(document.getElementById('ftTabPayments'));
}

function computePaymentStatus(paid, due) {
  const p = parseFloat(paid) || 0;
  const d = parseFloat(due)  || 0;
  if (d === 0 || p >= d) return 'paid';
  if (p > 0)             return 'partial';
  return 'unpaid';
}

// ── Boot ─────────────────────────────────────────────────────────────────
init();

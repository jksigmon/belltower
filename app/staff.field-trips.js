/**
 * staff.field-trips.js
 * Field trips management for the staff portal.
 * Teachers see only trips they are listed on as managers.
 * Admin users with can_manage_field_trips see all trips.
 * Any manager on a trip can create/edit trips, manage chaperones,
 * mark attendance, add/remove managers, and copy compliance form links.
 */

import { supabase } from './admin.supabase.js';
import { esc, debounce, loadSchoolConfig, GRADE_ORDER } from './admin.shared.js';

// ── Module state ─────────────────────────────────────────────────────────
let _profile        = null;
let _schoolConfig   = null;
let _tripCache      = [];
let _currentTrip    = null;
let _chaperoneList  = [];
let _studentList    = [];
let _bgCheckMap     = new Map();
let _agreementsMap  = new Map();
let _requiredForms  = [];
let _managers       = [];       // managers for current open trip
let _drawerManagers = [];       // pending manager adds in trip drawer
let _selectedGuardian = null;
let _activeTab      = 'chaperones';
let _initialized    = false;

const VOLUNTEER_BASE = () => `${window.location.origin}/volunteer.html?form=`;

// ── Entry point ──────────────────────────────────────────────────────────
export async function initStaffFieldTrips(profile) {
  _profile = profile;
  if (!_schoolConfig) _schoolConfig = await loadSchoolConfig(profile.school_id);

  if (!_initialized) {
    _wireNav();
    _wireTripDrawer();
    _wireChapDrawer();
    _wireTabs();
    _initialized = true;
  }

  _showListView();
  await Promise.all([_loadRequiredForms(), _loadTrips()]);
}

// ── Navigation ───────────────────────────────────────────────────────────
function _wireNav() {
  document.getElementById('ftStaffBackBtn')?.addEventListener('click', _showListView);
  document.getElementById('ftStaffNewTripBtn')?.addEventListener('click', () => _openTripDrawer(null));
  document.getElementById('ftStaffSearch')?.addEventListener('input', debounce(_renderTripList, 200));
  document.getElementById('ftStaffStatusFilter')?.addEventListener('change', _renderTripList);
}

function _showListView() {
  document.getElementById('ftStaffListView').style.display  = '';
  document.getElementById('ftStaffDetailView').style.display = 'none';
  _currentTrip = null;
  const sub = document.getElementById('pageSubtitle');
  if (sub) sub.textContent = 'Field Trips';
}

function _showDetailView() {
  document.getElementById('ftStaffListView').style.display  = 'none';
  document.getElementById('ftStaffDetailView').style.display = '';
}

// ── Trip list ────────────────────────────────────────────────────────────
async function _loadTrips() {
  const tbody = document.getElementById('ftStaffTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">Loading...</td></tr>`;

  const { data, error } = await supabase
    .from('field_trips')
    .select('id, name, destination, start_date, end_date, depart_at, return_at, grade_levels, drivers_needed, max_chaperones, notes, status, created_at, created_by_profile_id')
    .eq('school_id', _profile.school_id)
    .order('start_date', { ascending: false });

  if (error) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">Failed to load trips.</td></tr>`;
    return;
  }

  _tripCache = data ?? [];
  _renderTripList();
}

function _renderTripList() {
  const tbody    = document.getElementById('ftStaffTableBody');
  if (!tbody) return;
  const search   = (document.getElementById('ftStaffSearch')?.value ?? '').trim().toLowerCase();
  const statusVal = document.getElementById('ftStaffStatusFilter')?.value ?? '';
  const today    = new Date(); today.setHours(0, 0, 0, 0);

  const filtered = _tripCache.filter(t => {
    if (search) {
      const hay = `${t.name} ${t.destination ?? ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    const tripDate = new Date(t.start_date + 'T12:00:00');
    if (statusVal === 'upcoming'  && (t.status === 'cancelled' || tripDate < today)) return false;
    if (statusVal === 'past'      && (t.status === 'cancelled' || tripDate >= today)) return false;
    if (statusVal === 'cancelled' && t.status !== 'cancelled') return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">No trips found.</td></tr>`;
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
      <td>${badge}</td>
      <td><button class="btn btn-sm" data-id="${esc(t.id)}">Open</button></td>
    `;
    tr.addEventListener('click', e => { if (e.target.closest('button')) return; _openTrip(t.id); });
    tr.querySelector('button[data-id]').addEventListener('click', () => _openTrip(t.id));
    tbody.appendChild(tr);
  });
}

// ── Trip detail ──────────────────────────────────────────────────────────
async function _openTrip(id) {
  const trip = _tripCache.find(t => t.id === id);
  if (!trip) return;
  _currentTrip = trip;

  _showDetailView();
  const sub = document.getElementById('pageSubtitle');
  if (sub) sub.textContent = trip.name;

  _renderTripHeader(trip);
  _switchTab('chaperones');
  await Promise.all([_loadChaperones(), _renderFormLinks(), _loadManagers(trip.id)]);
}

function _renderTripHeader(trip) {
  const today     = new Date(); today.setHours(0, 0, 0, 0);
  const startDate = new Date(trip.start_date + 'T12:00:00');
  const endDate   = trip.end_date ? new Date(trip.end_date + 'T12:00:00') : null;
  const isPast    = (endDate ?? startDate) < today;

  document.getElementById('ftStaffDetailName').textContent = trip.name;
  document.getElementById('ftStaffDetailDest').textContent = trip.destination ?? '';

  const badge = trip.status === 'cancelled'
    ? `<span class="trip-badge trip-badge-cancelled">Cancelled</span>`
    : isPast
      ? `<span class="trip-badge trip-badge-past">Past</span>`
      : `<span class="trip-badge trip-badge-active">Upcoming</span>`;
  document.getElementById('ftStaffDetailBadge').innerHTML = badge;

  const fmt     = { month: 'long', day: 'numeric', year: 'numeric' };
  const dateStr = endDate && endDate.getTime() !== startDate.getTime()
    ? `${startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', fmt)}`
    : startDate.toLocaleDateString('en-US', { weekday: 'long', ...fmt });

  let timeStr = '';
  if (trip.depart_at) timeStr += `Departs ${_fmtTime(trip.depart_at)}`;
  if (trip.return_at) timeStr += (timeStr ? ' &bull; ' : '') + `Returns ${_fmtTime(trip.return_at)}`;

  const grades = (trip.grade_levels ?? []).map(g => `<span class="grade-pill">${esc(g)}</span>`).join('');

  document.getElementById('ftStaffDetailMeta').innerHTML = `
    <span class="trip-hdr-meta-item">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      ${dateStr}
    </span>
    ${timeStr ? `<span class="trip-hdr-meta-item">${timeStr}</span>` : ''}
    ${grades ? `<span class="trip-hdr-meta-item">${grades}</span>` : ''}
    ${trip.max_chaperones ? `<span class="trip-hdr-meta-item">Max ${trip.max_chaperones} chaperones</span>` : ''}
    ${trip.drivers_needed ? `<span class="trip-hdr-meta-item" style="color:#d97706;">Drivers needed</span>` : ''}
  `;

  const editBtn   = document.getElementById('ftStaffEditBtn');
  const cancelBtn = document.getElementById('ftStaffCancelBtn');
  if (editBtn)   editBtn.onclick   = () => _openTripDrawer(trip);
  if (cancelBtn) {
    cancelBtn.style.display = (!isPast && trip.status === 'active') ? '' : 'none';
    cancelBtn.onclick = () => _cancelTrip(trip.id);
  }
}

async function _cancelTrip(id) {
  if (!confirm('Cancel this trip? This cannot be undone.')) return;
  const { error } = await supabase.from('field_trips').update({ status: 'cancelled' }).eq('id', id);
  if (error) { alert('Failed to cancel trip.'); return; }
  const t = _tripCache.find(t => t.id === id);
  if (t) t.status = 'cancelled';
  _renderTripHeader(_currentTrip);
}

// ── Compliance form links ────────────────────────────────────────────────
async function _renderFormLinks() {
  const wrap = document.getElementById('ftStaffFormLinksWrap');
  if (!wrap) return;

  const { data: templates } = await supabase
    .from('compliance_form_templates')
    .select('id, title')
    .eq('school_id', _profile.school_id)
    .eq('required_for_chaperones', true)
    .eq('active', true)
    .order('title');

  if (!templates?.length) { wrap.style.display = 'none'; return; }

  const { data: links } = await supabase
    .from('compliance_form_links')
    .select('id, token, label, template_id')
    .eq('school_id', _profile.school_id)
    .in('template_id', templates.map(t => t.id))
    .eq('active', true);

  const byTemplate = new Map();
  (links ?? []).forEach(l => {
    if (!byTemplate.has(l.template_id)) byTemplate.set(l.template_id, []);
    byTemplate.get(l.template_id).push(l);
  });

  const BASE = VOLUNTEER_BASE();
  wrap.innerHTML = templates.map(t => {
    const tLinks = byTemplate.get(t.id) ?? [];
    const linkHtml = tLinks.length
      ? tLinks.map(l => `
          <span style="display:inline-flex;align-items:center;gap:6px;margin-right:8px;margin-top:4px;">
            <span style="font-size:12px;color:#374151;">${esc(l.label || 'Link')}</span>
            <button class="btn btn-sm" data-copy-url="${esc(BASE + l.token)}" style="font-size:11px;padding:2px 8px;">Copy Link</button>
          </span>`)
        .join('')
      : `<span style="font-size:12px;color:#9ca3af;">No active link — contact admin</span>`;
    return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;padding:6px 0;border-bottom:1px solid #dbeafe;">
      <span style="font-size:13px;font-weight:600;color:#1d4ed8;min-width:160px;">${esc(t.title)}</span>
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

// ── Managers ─────────────────────────────────────────────────────────────
async function _loadManagers(tripId) {
  const { data } = await supabase
    .from('field_trip_managers')
    .select('profile_id, profiles(display_name, email)')
    .eq('field_trip_id', tripId);

  _managers = (data ?? []).map(r => ({
    profile_id: r.profile_id,
    name:  r.profiles?.display_name ?? r.profiles?.email ?? '',
    email: r.profiles?.email ?? '',
  }));
  _renderManagerChips();
}

function _renderManagerChips() {
  const wrap = document.getElementById('ftStaffManagerChips');
  if (!wrap) return;
  if (!_managers.length) {
    wrap.innerHTML = '<span style="font-size:12px;color:#9ca3af;">None assigned</span>';
    return;
  }
  wrap.innerHTML = _managers.map(m => `
    <span style="display:inline-flex;align-items:center;gap:4px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:999px;padding:2px 10px;font-size:12px;color:#1d4ed8;">
      ${esc(m.name)}
      <button data-remove-mgr="${esc(m.profile_id)}" style="background:none;border:none;cursor:pointer;padding:0;color:#93c5fd;font-size:14px;line-height:1;" title="Remove">&times;</button>
    </span>`).join('');

  wrap.querySelectorAll('[data-remove-mgr]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove ${_managers.find(m => m.profile_id === btn.dataset.removeMgr)?.name} from this trip?`)) return;
      const { error } = await supabase.from('field_trip_managers')
        .delete().eq('field_trip_id', _currentTrip.id).eq('profile_id', btn.dataset.removeMgr);
      if (error) { alert('Failed to remove manager.'); return; }
      _managers = _managers.filter(m => m.profile_id !== btn.dataset.removeMgr);
      _renderManagerChips();
    });
  });
}

async function _searchManagerProfiles() {
  const val     = document.getElementById('ftStaffMgrSearch')?.value.trim();
  const results = document.getElementById('ftStaffMgrResults');
  if (!results) return;
  if (!val || val.length < 2) { results.style.display = 'none'; return; }

  results.innerHTML = `<div class="ft-typeahead-empty">Searching...</div>`;
  results.style.display = '';

  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('school_id', _profile.school_id)
    .eq('can_login', true)
    .or(`display_name.ilike.%${val}%,email.ilike.%${val}%`)
    .limit(8);

  const existingIds = new Set(_managers.map(m => m.profile_id));
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
    item.addEventListener('mousedown', async e => {
      e.preventDefault();
      results.style.display = 'none';
      document.getElementById('ftStaffMgrSearch').value = '';
      const { error } = await supabase.from('field_trip_managers').upsert(
        { field_trip_id: _currentTrip.id, profile_id: p.id, added_by: _profile.id },
        { onConflict: 'field_trip_id,profile_id' }
      );
      if (error) { alert('Failed to add manager.'); return; }
      _managers.push({ profile_id: p.id, name: p.display_name ?? p.email ?? '', email: p.email ?? '' });
      _renderManagerChips();
    });
    results.appendChild(item);
  });
}

// ── Tabs ─────────────────────────────────────────────────────────────────
function _wireTabs() {
  document.querySelectorAll('.ft-staff-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });
}

function _switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.ft-staff-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('ftStaffTabChaperones').style.display = tab === 'chaperones' ? '' : 'none';
  document.getElementById('ftStaffTabStudents').style.display   = tab === 'students'   ? '' : 'none';
  if (tab === 'students' && !_studentList.length) _loadStudents();
}

// ── Chaperones ────────────────────────────────────────────────────────────
async function _loadRequiredForms() {
  const { data } = await supabase
    .from('compliance_form_templates')
    .select('id, title')
    .eq('school_id', _profile.school_id)
    .eq('required_for_chaperones', true)
    .eq('active', true)
    .order('title');
  _requiredForms = data ?? [];
}

async function _loadChaperones() {
  const tbody = document.getElementById('ftStaffChapTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">Loading...</td></tr>`;

  const { data, error } = await supabase
    .from('field_trip_chaperones')
    .select(`id, guardian_id, is_driver, added_at,
      guardian:guardians(id, first_name, last_name, email,
        family:families(family_name, students(id, first_name, last_name, grade_level))
      )`)
    .eq('field_trip_id', _currentTrip.id)
    .is('removed_at', null)
    .order('added_at', { ascending: true });

  if (error) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="muted" style="text-align:center;padding:32px 0;">Failed to load.</td></tr>`;
    return;
  }

  _chaperoneList = data ?? [];
  const emails = _chaperoneList.map(c => c.guardian?.email).filter(Boolean);
  await Promise.all([_loadBgChecks(emails), _loadAgreements(emails)]);
  _renderChaperoneTable();
  _renderComplianceStats();
}

async function _loadBgChecks(emails) {
  _bgCheckMap.clear();
  if (!emails.length) return;
  const { data } = await supabase
    .from('compliance_bg_check_requests')
    .select('id, subject_email, status, cleared_at, expires_at, mvr_cleared_at, mvr_expires_at')
    .eq('school_id', _profile.school_id)
    .in('subject_email', emails)
    .in('status', ['cleared', 'submitted', 'pending']);
  (data ?? []).forEach(row => {
    const key = (row.subject_email ?? '').toLowerCase();
    const ex  = _bgCheckMap.get(key);
    if (!ex || (row.status === 'cleared' && ex.status !== 'cleared')) _bgCheckMap.set(key, row);
  });
}

async function _loadAgreements(emails) {
  _agreementsMap.clear();
  if (!emails.length || !_requiredForms.length) return;
  const { data } = await supabase
    .from('compliance_agreements')
    .select('signer_email, template_id')
    .eq('school_id', _profile.school_id)
    .in('signer_email', emails)
    .in('template_id', _requiredForms.map(t => t.id))
    .is('voided_at', null);
  (data ?? []).forEach(row => {
    const key = (row.signer_email ?? '').toLowerCase();
    if (!_agreementsMap.has(key)) _agreementsMap.set(key, new Set());
    _agreementsMap.get(key).add(row.template_id);
  });
}

function _getMissingForms(email) {
  const signed = _agreementsMap.get((email ?? '').toLowerCase()) ?? new Set();
  return _requiredForms.filter(t => !signed.has(t.id));
}

function _computeStatus(guardian, bg, tripDate, isDriver) {
  if (!bg) return 'blocked';
  const trip  = new Date(tripDate + 'T12:00:00');
  const bgExp = bg.expires_at ? new Date(bg.expires_at + 'T12:00:00') : null;
  const bgOk  = bg.status === 'cleared' && (!bgExp || bgExp >= trip);
  if (!bgOk) return bg.status === 'pending' || bg.status === 'submitted' ? 'action' : 'blocked';
  const requireMvr = _schoolConfig?.require_mvr_for_drivers !== false;
  if (isDriver && requireMvr) {
    if (!bg.mvr_cleared_at) return 'action';
    const mvrExp = bg.mvr_expires_at ? new Date(bg.mvr_expires_at + 'T12:00:00') : null;
    if (mvrExp && mvrExp < trip) return 'action';
  }
  if (_getMissingForms(guardian?.email).length) return 'action';
  return 'cleared';
}

function _chipHtml(status, label) {
  const cls = { cleared: 'comp-cleared', action: 'comp-action', blocked: 'comp-blocked', unknown: 'comp-unknown' };
  return `<span class="comp-chip ${cls[status] ?? 'comp-unknown'}">${label}</span>`;
}

function _renderChaperoneTable() {
  const tbody         = document.getElementById('ftStaffChapTableBody');
  if (!tbody) return;
  const driversNeeded = _currentTrip.drivers_needed;
  const formsRequired = _requiredForms.length > 0;
  const tripDate      = _currentTrip.end_date ?? _currentTrip.start_date;
  const requireMvr    = _schoolConfig?.require_mvr_for_drivers !== false;

  document.getElementById('ftStaffThMvr')?.style.setProperty('display', driversNeeded && requireMvr ? '' : 'none');
  document.getElementById('ftStaffThForms')?.style.setProperty('display', formsRequired ? '' : 'none');

  const colCount = 4 + (driversNeeded && requireMvr ? 1 : 0) + (formsRequired ? 1 : 0) + 1 + 1;

  if (!_chaperoneList.length) {
    tbody.innerHTML = `<tr><td colspan="${colCount}" class="muted" style="text-align:center;padding:32px 0;">No chaperones added yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  _chaperoneList.forEach(chap => {
    const g      = chap.guardian ?? {};
    const email  = (g.email ?? '').toLowerCase();
    const bg     = _bgCheckMap.get(email) ?? null;
    const status = _computeStatus(g, bg, tripDate, chap.is_driver);
    const students = (g.family?.students ?? []).map(s => esc(s.first_name)).join(', ') || '—';

    let mvrCell = '';
    if (driversNeeded && requireMvr) {
      if (!chap.is_driver) {
        mvrCell = `<td><span class="muted" style="font-size:12px;">N/A</span></td>`;
      } else {
        const tripEnd = new Date(tripDate + 'T12:00:00');
        const mvrOk   = bg?.mvr_cleared_at && (!bg.mvr_expires_at || new Date(bg.mvr_expires_at + 'T12:00:00') >= tripEnd);
        mvrCell = `<td>${_chipHtml(mvrOk ? 'cleared' : 'action', mvrOk ? 'Cleared' : 'Needed')}</td>`;
      }
    }

    const missing      = _getMissingForms(email);
    const formsCell    = formsRequired
      ? `<td>${missing.length ? _chipHtml('action', `${missing.length} missing`) : _chipHtml('cleared', 'All signed')}</td>`
      : '';

    const bgLabel      = { cleared: 'Cleared', action: 'Action needed', blocked: 'Blocked' };
    const bgStatusDisp = bg ? (bgLabel[status] ?? status) : 'No record';
    const bgChip       = _chipHtml(bg ? status : 'unknown', bgStatusDisp);

    const tr = document.createElement('tr');
    tr.className = 'chap-row';
    tr.innerHTML = `
      <td class="chap-name">
        <strong>${esc(g.first_name ?? '')} ${esc(g.last_name ?? '')}</strong>
        <span>${esc(g.email ?? '')}</span>
      </td>
      <td class="chap-students" style="font-size:12px;color:#6b7280;">${students}</td>
      <td>${bgChip}</td>
      ${mvrCell}
      ${formsCell}
      <td>${chap.is_driver ? _chipHtml('action', 'Driver') : '<span class="muted" style="font-size:12px;">No</span>'}</td>
      <td><button class="btn btn-sm btn-danger" data-chap-id="${esc(chap.id)}" style="font-size:11px;">Remove</button></td>
    `;
    tr.querySelector('button[data-chap-id]').addEventListener('click', () => _removeChaperone(chap.id));
    tbody.appendChild(tr);
  });
}

function _renderComplianceStats() {
  const wrap = document.getElementById('ftStaffCompStats');
  if (!wrap) return;
  if (!_chaperoneList.length) { wrap.style.display = 'none'; return; }

  let cleared = 0, action = 0, blocked = 0;
  _chaperoneList.forEach(chap => {
    const g  = chap.guardian ?? {};
    const bg = _bgCheckMap.get((g.email ?? '').toLowerCase()) ?? null;
    const s  = _computeStatus(g, bg, _currentTrip.end_date ?? _currentTrip.start_date, chap.is_driver);
    if (s === 'cleared') cleared++; else if (s === 'action') action++; else blocked++;
  });

  document.getElementById('ftStaffStatTotal').textContent   = _chaperoneList.length;
  document.getElementById('ftStaffStatCleared').textContent = cleared;
  document.getElementById('ftStaffStatAction').textContent  = action;
  document.getElementById('ftStaffStatBlocked').textContent = blocked;
  document.getElementById('ftStaffStatActionCard').style.display  = action  ? '' : 'none';
  document.getElementById('ftStaffStatBlockedCard').style.display = blocked ? '' : 'none';
  wrap.style.display = '';
}

async function _removeChaperone(chapId) {
  const { error } = await supabase
    .from('field_trip_chaperones').update({ removed_at: new Date().toISOString() }).eq('id', chapId);
  if (error) { alert('Failed to remove chaperone.'); return; }
  _chaperoneList = _chaperoneList.filter(c => c.id !== chapId);
  _renderChaperoneTable();
  _renderComplianceStats();
}

// ── Add Chaperone drawer ──────────────────────────────────────────────────
function _wireChapDrawer() {
  document.getElementById('ftStaffAddChaperoneBtn')?.addEventListener('click', _openChapDrawer);
  document.getElementById('ftStaffChapDrawerClose')?.addEventListener('click', _closeChapDrawer);
  document.getElementById('ftStaffChapDrawerOverlay')?.addEventListener('click', _closeChapDrawer);
  document.getElementById('ftStaffCancelChapBtn')?.addEventListener('click', _closeChapDrawer);
  document.getElementById('ftStaffChapClearBtn')?.addEventListener('click', _clearChapSelection);
  document.getElementById('ftStaffSaveChapBtn')?.addEventListener('click', _saveChaperone);

  const search = document.getElementById('ftStaffChapSearch');
  if (search) {
    search.addEventListener('input', debounce(_searchGuardians, 250));
    search.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('ftStaffChapResults').style.display = 'none'; });
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('#ftStaffChapSearchWrap')) {
      const r = document.getElementById('ftStaffChapResults');
      if (r) r.style.display = 'none';
    }
    if (!e.target.closest('#ftStaffMgrSearchWrap')) {
      const r = document.getElementById('ftStaffMgrResults');
      if (r) r.style.display = 'none';
    }
  });
}

function _openChapDrawer() {
  _clearChapSelection();
  document.getElementById('ftStaffChapSearch').value = '';
  document.getElementById('ftStaffChapResults').style.display = 'none';
  document.getElementById('ftStaffChapIsDriver').checked = false;
  document.getElementById('ftStaffChapDrawer').classList.add('open');
  document.getElementById('ftStaffChapDrawerOverlay').classList.add('open');
  document.getElementById('ftStaffChapSearch').focus();
}

function _closeChapDrawer() {
  document.getElementById('ftStaffChapDrawer').classList.remove('open');
  document.getElementById('ftStaffChapDrawerOverlay').classList.remove('open');
  _clearChapSelection();
}

function _clearChapSelection() {
  _selectedGuardian = null;
  document.getElementById('ftStaffChapSelected').style.display = 'none';
  document.getElementById('ftStaffSaveChapBtn').disabled = true;
}

async function _searchGuardians() {
  const val     = document.getElementById('ftStaffChapSearch').value.trim();
  const results = document.getElementById('ftStaffChapResults');
  if (val.length < 2) { results.style.display = 'none'; return; }

  results.innerHTML = `<div class="ft-typeahead-empty">Searching...</div>`;
  results.style.display = '';

  const { data } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, email, family_id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${val}%,last_name.ilike.%${val}%,email.ilike.%${val}%`)
    .limit(8);

  const existingIds = new Set(_chaperoneList.map(c => c.guardian_id));
  const filtered    = (data ?? []).filter(g => !existingIds.has(g.id));

  if (!filtered.length) {
    results.innerHTML = `<div class="ft-typeahead-empty">No guardians found or all already added.</div>`;
    return;
  }

  results.innerHTML = '';
  filtered.forEach(g => {
    const item = document.createElement('div');
    item.className = 'ft-typeahead-item';
    item.innerHTML = `<strong>${esc(g.first_name)} ${esc(g.last_name)}</strong><span>${esc(g.email ?? '')}</span>`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      _selectedGuardian = g;
      document.getElementById('ftStaffChapResults').style.display = 'none';
      document.getElementById('ftStaffChapSearch').value = '';
      document.getElementById('ftStaffChapSelectedName').textContent  = `${g.first_name} ${g.last_name}`;
      document.getElementById('ftStaffChapSelectedEmail').textContent = g.email ?? '';
      document.getElementById('ftStaffChapSelected').style.display = '';
      document.getElementById('ftStaffSaveChapBtn').disabled = false;
    });
    results.appendChild(item);
  });
}

async function _saveChaperone() {
  if (!_selectedGuardian || !_currentTrip) return;
  const btn = document.getElementById('ftStaffSaveChapBtn');
  btn.disabled = true;

  const { error } = await supabase.from('field_trip_chaperones').insert({
    school_id:           _profile.school_id,
    field_trip_id:       _currentTrip.id,
    guardian_id:         _selectedGuardian.id,
    is_driver:           document.getElementById('ftStaffChapIsDriver').checked,
    added_by_profile_id: _profile.id,
  });

  if (error) {
    alert(error.code === '23505' ? 'This guardian is already added.' : 'Failed to add chaperone.');
    btn.disabled = false;
    return;
  }

  _closeChapDrawer();
  await _loadChaperones();
}

// ── Students ──────────────────────────────────────────────────────────────
async function _loadStudents() {
  const tbody = document.getElementById('ftStaffStudTableBody');
  if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:32px 0;">Loading...</td></tr>`;

  const grades = _currentTrip.grade_levels ?? [];
  let q = supabase
    .from('students')
    .select('id, first_name, last_name, grade_level, homeroom_teacher_id, employees!left(first_name, last_name)')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .order('last_name');
  if (grades.length) q = q.in('grade_level', grades);

  const [{ data: students, error: sErr }, { data: ftStudents }] = await Promise.all([
    q,
    supabase.from('field_trip_students').select('student_id, attending').eq('field_trip_id', _currentTrip.id),
  ]);

  if (sErr) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:32px 0;">Failed to load.</td></tr>`;
    return;
  }

  const overrides = new Map((ftStudents ?? []).map(r => [r.student_id, r.attending]));
  _studentList = (students ?? []).map(s => ({ ...s, attending: overrides.has(s.id) ? overrides.get(s.id) : true }));
  _renderStudentTable();
}

function _renderStudentTable() {
  const tbody = document.getElementById('ftStaffStudTableBody');
  if (!tbody) return;

  if (!_studentList.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted" style="text-align:center;padding:32px 0;">No students for selected grade levels.</td></tr>`;
    return;
  }

  const attending = _studentList.filter(s => s.attending).length;
  tbody.innerHTML = '';
  _studentList.forEach(s => {
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
    cb.addEventListener('change', () => _toggleAttendance(s.id, cb.checked, tr));
    tbody.appendChild(tr);
  });

  const summary = document.createElement('tr');
  summary.innerHTML = `<td colspan="4" style="font-size:12px;color:#6b7280;padding:10px 16px;">${attending} of ${_studentList.length} attending</td>`;
  tbody.appendChild(summary);
}

async function _toggleAttendance(studentId, attending, tr) {
  const s = _studentList.find(s => s.id === studentId);
  if (!s) return;
  s.attending = attending;

  const { error } = await supabase.from('field_trip_students').upsert({
    school_id:     _profile.school_id,
    field_trip_id: _currentTrip.id,
    student_id:    studentId,
    attending,
  }, { onConflict: 'field_trip_id,student_id' });

  if (error) { s.attending = !attending; _renderStudentTable(); return; }

  const label = tr.querySelector('label');
  if (label) {
    label.innerHTML = `
      <input type="checkbox" data-student-id="${esc(studentId)}" ${attending ? 'checked' : ''}>
      ${attending ? 'Attending' : '<span style="color:#9ca3af;">Not attending</span>'}
    `;
    label.querySelector('input').addEventListener('change', e => _toggleAttendance(studentId, e.target.checked, tr));
  }
}

// ── Trip create/edit drawer ───────────────────────────────────────────────
function _wireTripDrawer() {
  document.getElementById('ftStaffTripDrawerClose')?.addEventListener('click', _closeTripDrawer);
  document.getElementById('ftStaffTripDrawerOverlay')?.addEventListener('click', _closeTripDrawer);
  document.getElementById('ftStaffCancelTripDrawerBtn')?.addEventListener('click', _closeTripDrawer);
  document.getElementById('ftStaffSaveTripBtn')?.addEventListener('click', _saveTrip);
  _buildGradeCheckboxes();

  const mgrSearch = document.getElementById('ftStaffDrawerMgrSearch');
  if (mgrSearch) {
    mgrSearch.addEventListener('input', debounce(_searchDrawerManagers, 250));
    mgrSearch.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('ftStaffDrawerMgrResults').style.display = 'none'; });
  }
}

function _buildGradeCheckboxes() {
  const wrap = document.getElementById('ftStaffDrawerGrades');
  if (!wrap || wrap.children.length) return;
  const grades = _schoolConfig?.grade_levels ?? GRADE_ORDER;
  grades.forEach(g => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;';
    label.innerHTML = `<input type="checkbox" value="${esc(g)}" style="width:14px;height:14px;"> ${esc(g)}`;
    wrap.appendChild(label);
  });
}

function _openTripDrawer(trip) {
  _drawerManagers = trip ? _managers.map(m => ({ ...m })) : [];
  _renderDrawerMgrChips();
  document.getElementById('ftStaffDrawerTitle').textContent      = trip ? 'Edit Trip' : 'New Trip';
  document.getElementById('ftStaffDrawerTripId').value           = trip?.id ?? '';
  document.getElementById('ftStaffDrawerName').value             = trip?.name ?? '';
  document.getElementById('ftStaffDrawerDest').value             = trip?.destination ?? '';
  document.getElementById('ftStaffDrawerDate').value             = trip?.start_date ?? '';
  document.getElementById('ftStaffDrawerEndDate').value          = trip?.end_date ?? '';
  document.getElementById('ftStaffDrawerDepart').value           = trip?.depart_at ?? '';
  document.getElementById('ftStaffDrawerReturn').value           = trip?.return_at ?? '';
  document.getElementById('ftStaffDrawerMaxChap').value          = trip?.max_chaperones ?? '';
  document.getElementById('ftStaffDrawerDrivers').checked        = trip?.drivers_needed ?? false;
  document.getElementById('ftStaffDrawerNotes').value            = trip?.notes ?? '';

  const selected = new Set(trip?.grade_levels ?? []);
  document.querySelectorAll('#ftStaffDrawerGrades input[type="checkbox"]').forEach(cb => {
    cb.checked = selected.has(cb.value);
  });

  document.getElementById('ftStaffTripDrawer').classList.add('open');
  document.getElementById('ftStaffTripDrawerOverlay').classList.add('open');
  document.getElementById('ftStaffDrawerName').focus();
}

function _closeTripDrawer() {
  document.getElementById('ftStaffTripDrawer').classList.remove('open');
  document.getElementById('ftStaffTripDrawerOverlay').classList.remove('open');
}

async function _saveTrip() {
  const id        = document.getElementById('ftStaffDrawerTripId').value;
  const name      = document.getElementById('ftStaffDrawerName').value.trim();
  const startDate = document.getElementById('ftStaffDrawerDate').value;
  const endDate   = document.getElementById('ftStaffDrawerEndDate').value;

  if (!name)      { alert('Trip name is required.'); return; }
  if (!startDate) { alert('Start date is required.'); return; }
  if (endDate && endDate < startDate) { alert('End date cannot be before start date.'); return; }

  const grades  = [...document.querySelectorAll('#ftStaffDrawerGrades input:checked')].map(cb => cb.value);
  const payload = {
    school_id:      _profile.school_id,
    name,
    destination:    document.getElementById('ftStaffDrawerDest').value.trim() || null,
    start_date:     startDate,
    end_date:       endDate || null,
    depart_at:      document.getElementById('ftStaffDrawerDepart').value  || null,
    return_at:      document.getElementById('ftStaffDrawerReturn').value  || null,
    grade_levels:   grades,
    drivers_needed: document.getElementById('ftStaffDrawerDrivers').checked,
    max_chaperones: document.getElementById('ftStaffDrawerMaxChap').value ? parseInt(document.getElementById('ftStaffDrawerMaxChap').value, 10) : null,
    notes:          document.getElementById('ftStaffDrawerNotes').value.trim() || null,
  };

  const btn = document.getElementById('ftStaffSaveTripBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  let error;
  if (id) {
    ({ error } = await supabase.from('field_trips').update(payload).eq('id', id));
    if (!error) {
      const idx = _tripCache.findIndex(t => t.id === id);
      if (idx >= 0) _tripCache[idx] = { ..._tripCache[idx], ...payload };
      if (_currentTrip?.id === id) { _currentTrip = { ..._currentTrip, ...payload }; _renderTripHeader(_currentTrip); }
      // Always include the current user so we can satisfy RLS even if
      // they were never inserted as a manager on this trip.
      const editorEntry = { profile_id: _profile.id };
      const allEditMgrs = _drawerManagers.some(m => m.profile_id === _profile.id)
        ? _drawerManagers
        : [editorEntry, ..._drawerManagers];

      const { error: mgrErr } = await supabase.from('field_trip_managers').upsert(
        allEditMgrs.map(m => ({ field_trip_id: id, profile_id: m.profile_id, added_by: _profile.id })),
        { onConflict: 'field_trip_id,profile_id' }
      );
      if (mgrErr) console.error('field_trip_managers upsert failed:', mgrErr);

      // Delete managers removed in the drawer (excluding the current user)
      const keptIds = new Set(allEditMgrs.map(m => m.profile_id));
      const removed = _managers.filter(m => !keptIds.has(m.profile_id) && m.profile_id !== _profile.id);
      if (removed.length) {
        await supabase.from('field_trip_managers')
          .delete()
          .eq('field_trip_id', id)
          .in('profile_id', removed.map(m => m.profile_id));
      }
      await _loadManagers(id);
    }
  } else {
    const { data, error: insertErr } = await supabase
      .from('field_trips').insert({ ...payload, created_by_profile_id: _profile.id }).select().single();
    error = insertErr;
    if (!error && data) {
      _tripCache.unshift(data);
      // Auto-add creator + drawer managers
      const allMgrs = [{ profile_id: _profile.id }, ..._drawerManagers];
      const unique  = [...new Map(allMgrs.map(m => [m.profile_id, m])).values()];
      await supabase.from('field_trip_managers').upsert(
        unique.map(m => ({ field_trip_id: data.id, profile_id: m.profile_id, added_by: _profile.id })),
        { onConflict: 'field_trip_id,profile_id' }
      );
      _currentTrip = data;
      await _loadManagers(data.id);
    }
  }

  btn.disabled = false; btn.textContent = 'Save Trip';
  if (error) { alert('Failed to save trip.'); return; }

  _closeTripDrawer();
  _renderTripList();
  _drawerManagers = [];
}

// Drawer manager typeahead (for new/edit trip)
async function _searchDrawerManagers() {
  const val     = document.getElementById('ftStaffDrawerMgrSearch')?.value.trim();
  const results = document.getElementById('ftStaffDrawerMgrResults');
  if (!results) return;
  if (!val || val.length < 2) { results.style.display = 'none'; return; }

  results.innerHTML = `<div class="ft-typeahead-empty">Searching...</div>`;
  results.style.display = '';

  const { data } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('school_id', _profile.school_id)
    .eq('can_login', true)
    .or(`display_name.ilike.%${val}%,email.ilike.%${val}%`)
    .limit(8);

  const existingIds = new Set(_drawerManagers.map(m => m.profile_id));
  const filtered    = (data ?? []).filter(p => !existingIds.has(p.id));

  if (!filtered.length) { results.innerHTML = `<div class="ft-typeahead-empty">No staff found.</div>`; return; }

  results.innerHTML = '';
  filtered.forEach(p => {
    const item = document.createElement('div');
    item.className = 'ft-typeahead-item';
    item.innerHTML = `<strong>${esc(p.display_name ?? p.email)}</strong><span>${esc(p.email ?? '')}</span>`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      _drawerManagers.push({ profile_id: p.id, name: p.display_name ?? p.email ?? '', email: p.email ?? '' });
      _renderDrawerMgrChips();
      document.getElementById('ftStaffDrawerMgrSearch').value = '';
      results.style.display = 'none';
    });
    results.appendChild(item);
  });
}

function _renderDrawerMgrChips() {
  const wrap = document.getElementById('ftStaffDrawerMgrChips');
  if (!wrap) return;
  wrap.innerHTML = _drawerManagers.map((m, i) => `
    <span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:999px;padding:2px 10px;font-size:12px;color:#15803d;">
      ${esc(m.name)}
      <button data-di="${i}" style="background:none;border:none;cursor:pointer;padding:0;color:#86efac;font-size:14px;line-height:1;">&times;</button>
    </span>`).join('');
  wrap.querySelectorAll('[data-di]').forEach(btn => {
    btn.addEventListener('click', () => {
      _drawerManagers.splice(Number(btn.dataset.di), 1);
      _renderDrawerMgrChips();
    });
  });
}

// Wire the manager search on the detail view (add manager inline)
export function wireDetailManagerSearch() {
  const mgrSearch = document.getElementById('ftStaffMgrSearch');
  if (mgrSearch) {
    mgrSearch.addEventListener('input', debounce(_searchManagerProfiles, 250));
    mgrSearch.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('ftStaffMgrResults').style.display = 'none'; });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function _fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':');
  const hr   = parseInt(h, 10);
  return `${hr % 12 || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

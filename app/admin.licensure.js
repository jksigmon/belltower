import { supabase } from './admin.supabase.js?v=2';
import { initPage } from './admin.auth.js?v=2';
import { debounce, esc, showToast } from './admin.shared.js?v=3';

/* ─────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────── */
let currentProfile = null;
let campusLookup   = {};
let employeeLookup = {};  // id → "Last, First"
let allLicenses    = [];  // cached for export
let editingId      = null;
let currentFilesByLicense = {};  // license id → current { file_path, file_name }

const PAGE_SIZE = 50;
let licPage  = 0;
let auditPage = 0;

let allCeus               = [];   // cached for CEUs tab export
let editingCeuId          = null;
let ceuReturnLicenseId    = null; // license id to reopen the license drawer for after the CEU drawer closes
let lockedCeuEmployeeId   = null;
let lockedCeuLicenseId    = null;
let currentLicenseCeus    = [];   // CEU entries for the license currently open in the drawer
let currentEditingLicense = null; // full license row while the license drawer is open in edit mode
let ceuLicensesForStaff   = {};   // employee id → cached staff_licenses rows, for the CEU drawer's license select

/* Flatpickr instances */
let fpIssue   = null;
let fpExp     = null;
let fpCeuDate = null;

/* ─────────────────────────────────────────────────────
   CEU CATEGORY TARGETS (NC: 8 CEUs / 80 clock hours per
   5-year CPL renewal cycle, split by role — see
   staff_licenses.category / .grade_authorization)
───────────────────────────────────────────────────── */
const CEU_CATEGORY_LABELS = {
  literacy:                 'Literacy',
  content:                  'Content',
  digital_learning:         'Digital Learning',
  administration:           'Administration',
  professional_discipline:  'Professional Discipline',
  general_other:            'General / Other',
};
const CEU_TOTAL_TARGET = 8;

const EDIT_ICON_SVG  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
const TRASH_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
const FILE_ICON_SVG  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

// Returns { category: targetCEUs } summing to CEU_TOTAL_TARGET, or null when
// the license's category/grade authorization don't map to a known NC profile
// (e.g. substitute licenses, or a teaching license with no grade band set —
// NC's literacy requirement hinges on that).
function ceuTargetProfile(lic) {
  if (lic.category === 'admin')   return { administration: 3, general_other: 3, digital_learning: 2 };
  if (lic.category === 'support') return { professional_discipline: 3, general_other: 3, digital_learning: 2 };
  if (lic.category === 'teaching') {
    if (lic.grade_authorization === 'K-6' || lic.grade_authorization === 'K-12') {
      return { literacy: 3, content: 3, digital_learning: 2 };
    }
    if (lic.grade_authorization === '6-9' || lic.grade_authorization === '9-12') {
      return { content: 3, general_other: 3, digital_learning: 2 };
    }
    return null;
  }
  return null;
}

function suggestedCeuCategory(lic) {
  const profile = ceuTargetProfile(lic);
  return profile ? Object.keys(profile)[0] : 'general_other';
}

// CEUs only count toward the license's *current* 5-year cycle.
function cycleStartDate(expirationDate) {
  if (!expirationDate) return null;
  const d = new Date(expirationDate);
  d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

/* ─────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────── */
async function init() {
  const profile = await initPage({ requiredCap: 'can_manage_licensure' });
  if (!profile) return;

  currentProfile = profile;

  await Promise.all([loadCampuses(), loadEmployees()]);
  populateCampusSelects();
  populateStaffSelect();
  wireEvents();
  initDatePickers();

  const empParam = new URLSearchParams(window.location.search).get('employee');
  if (empParam && employeeLookup[empParam]) {
    const searchEl = document.getElementById('licSearch');
    if (searchEl) searchEl.value = employeeLookup[empParam];
    await setView('licenses');
  } else {
    await setView('overview');
  }
}

/* ─────────────────────────────────────────────────────
   DATA LOADERS
───────────────────────────────────────────────────── */
async function loadCampuses() {
  const { data } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', currentProfile.school_id)
    .order('name');

  campusLookup = {};
  (data || []).forEach(c => { campusLookup[c.id] = c.name; });
}

async function loadEmployees() {
  const { data } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .eq('school_id', currentProfile.school_id)
    .eq('active', true)
    .order('last_name');

  employeeLookup = {};
  (data || []).forEach(e => {
    employeeLookup[e.id] = `${e.last_name}, ${e.first_name}`;
  });
}

/* ─────────────────────────────────────────────────────
   COMPLIANCE DASHBOARD
───────────────────────────────────────────────────── */
async function loadCompliance() {
  const today  = new Date().toISOString().slice(0, 10);
  const day30  = offsetDate(30);
  const day60  = offsetDate(60);
  const day90  = offsetDate(90);
  const school = currentProfile.school_id;

  const [total, exp30, exp60, exp90, expired, provisional] = await Promise.all([
    supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', school).eq('status', 'active'),
    supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', school).lte('expiration_date', day30).gte('expiration_date', today)
      .neq('status', 'expired'),
    supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', school).lte('expiration_date', day60).gte('expiration_date', today)
      .neq('status', 'expired'),
    supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', school).lte('expiration_date', day90).gte('expiration_date', today)
      .neq('status', 'expired'),
    supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', school).lt('expiration_date', today),
    supabase.from('staff_licenses').select('id', { count: 'exact', head: true })
      .eq('school_id', school).eq('is_provisional', true),
  ]);

  setText('statTotal',      total.count      ?? 0);
  setText('stat30',         exp30.count      ?? 0);
  setText('stat60',         exp60.count      ?? 0);
  setText('stat90',         exp90.count      ?? 0);
  setText('statExpired',    expired.count    ?? 0);
  setText('statProvisional',provisional.count ?? 0);

  renderOverviewHeader(expired.count ?? 0, exp30.count ?? 0);
  renderOverviewQuickActions();

  await Promise.all([
    loadAttentionAndUpcoming(today),
    loadRecentActivity(),
  ]);

  document.getElementById('dashGrid')?.classList.add('loaded');
}

function renderOverviewHeader(expiredCount, expiring30Count) {
  const asOf = document.getElementById('ovAsOfDate');
  if (asOf) asOf.textContent = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const pill    = document.getElementById('ovStatusPill');
  const banner  = document.getElementById('ovStatusBanner');
  const icon    = document.getElementById('ovStatusIcon');
  const title   = document.getElementById('ovStatusTitle');
  const sub     = document.getElementById('ovStatusSub');
  if (!banner) return;

  banner.classList.remove('lic-status-ok', 'lic-status-urgent', 'lic-status-critical');

  if (expiredCount > 0) {
    banner.classList.add('lic-status-critical');
    if (pill) { pill.textContent = 'Needs attention'; pill.className = 'badge badge-expired'; }
    if (title) title.textContent = `${expiredCount} license${expiredCount === 1 ? '' : 's'} expired`;
    if (sub) sub.textContent = 'These need immediate renewal to stay compliant.';
    if (icon) icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
  } else if (expiring30Count > 0) {
    banner.classList.add('lic-status-urgent');
    if (pill) { pill.textContent = 'Needs attention'; pill.className = 'badge badge-expiring'; }
    if (title) title.textContent = `${expiring30Count} license${expiring30Count === 1 ? '' : 's'} expiring within 30 days`;
    if (sub) sub.textContent = 'Renewals should be started soon to avoid a lapse.';
    if (icon) icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
  } else {
    banner.classList.add('lic-status-ok');
    if (pill) { pill.textContent = 'All systems normal'; pill.className = 'badge badge-active'; }
    if (title) title.textContent = 'No urgent expirations';
    if (sub) sub.textContent = "You're all caught up! No licenses expire in the next 30 days.";
    if (icon) icon.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  }
}

function renderOverviewQuickActions() {
  const row = document.getElementById('ovQuickActions');
  if (!row) return;

  const actions = [
    { label: 'Add License',   sub: 'Add a new license',       icon: 'plus',          bg: '#dbeafe', fg: '#2563eb', onClick: () => openAddModal() },
    { label: 'Add CEU',       sub: 'Record CEU activity',      icon: 'graduation-cap', bg: '#dcfce7', fg: '#15803d', onClick: () => openAddCeuModal() },
    { label: 'Export Report', sub: 'Download compliance data', icon: 'file-text',      bg: '#f1f5f9', fg: '#475569', onClick: async () => {
      // allLicenses is only populated once the All Licenses tab has loaded --
      // a school reached straight from Overview would otherwise export nothing.
      if (!allLicenses.length) await loadLicenses();
      exportLicenses();
    } },
    { label: 'View Audit Log',sub: 'See recent changes',       icon: 'history',        bg: '#ffedd5', fg: '#c2410c', onClick: () => { history.pushState(null, '', '#audit'); setView('audit'); } },
  ];

  row.innerHTML = actions.map((a, i) => `
    <button type="button" class="lic-qa-tile" data-qa-index="${i}">
      <span class="lic-qa-icon" style="background:${a.bg};color:${a.fg};"><i data-lucide="${a.icon}"></i></span>
      <span class="lic-qa-text">
        <span class="lic-qa-title">${esc(a.label)}</span>
        <span class="lic-qa-sub">${esc(a.sub)}</span>
      </span>
      <svg class="lic-qa-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </button>
  `).join('');

  row.querySelectorAll('[data-qa-index]').forEach(btn => {
    btn.addEventListener('click', () => actions[Number(btn.dataset.qaIndex)].onClick());
  });

  if (window.lucide) lucide.createIcons({ el: row });
}

// Needs Attention = expired or expiring within 30 days (the same threshold
// the status banner uses); Upcoming Expirations = the 31-90 day window
// beyond that. Genuinely threshold-based, not a fixed row count -- an
// all-clear school should see an empty, reassuring panel, not padding.
async function loadAttentionAndUpcoming(today) {
  const day90 = offsetDate(90);

  const { data, error } = await supabase
    .from('staff_licenses')
    .select('id, employee_id, license_type, license_area, expiration_date, status')
    .eq('school_id', currentProfile.school_id)
    .not('status', 'in', '(revoked,suspended)')
    .lte('expiration_date', day90)
    .order('expiration_date', { ascending: true })
    .limit(100);

  if (error) { console.error(error); return; }

  const rows      = data ?? [];
  const attention = rows.filter(lic => daysBetween(today, lic.expiration_date) <= 30);
  const upcoming  = rows.filter(lic => daysBetween(today, lic.expiration_date) > 30);

  setText('attnCount', attention.length);
  setText('upcomingCount', upcoming.length);

  renderOverviewRows('attnList', attention, today, true);
  renderOverviewRows('upcomingList', upcoming, today, false);
}

function renderOverviewRows(containerId, rows, today, isAttention) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!rows.length) {
    container.innerHTML = `<div class="lic-empty">${isAttention ? 'All caught up — no licenses need attention.' : 'Nothing expiring in the next 90 days.'}</div>`;
    return;
  }

  container.innerHTML = rows.map(lic => {
    const daysLeft   = daysBetween(today, lic.expiration_date);
    const isExpired  = daysLeft < 0;
    const daysLabel  = isExpired ? `${Math.abs(daysLeft)} days overdue` : `${daysLeft} days`;
    const badge      = isAttention
      ? (isExpired ? statusBadge('expired') : `<span class="badge badge-expiring">License expiring soon</span>`)
      : statusBadge(lic.status);

    return `
      <a class="lic-attn-row" href="/app/licensure.html?employee=${esc(lic.employee_id)}#licenses">
        <div class="lic-card-av">${esc(initialsFor(lic.employee_id))}</div>
        <div class="lic-attn-body">
          <div class="lic-attn-name">${esc(employeeLookup[lic.employee_id] ?? '—')}</div>
          <div class="lic-attn-meta">${esc(lic.license_type)}${lic.license_area ? ' · ' + esc(lic.license_area) : ''}</div>
        </div>
        ${badge}
        <div class="lic-attn-expiry">
          <div class="lic-attn-date">${formatDate(lic.expiration_date)}</div>
          <div class="lic-attn-days">${daysLabel}</div>
        </div>
        <svg class="lic-attn-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </a>`;
  }).join('');
}

function initialsFor(employeeId) {
  const nameParts = (employeeLookup[employeeId] ?? '').split(',');
  return [nameParts[1]?.trim()[0], nameParts[0]?.trim()[0]].filter(Boolean).join('').toUpperCase() || '?';
}

async function loadRecentActivity() {
  const container = document.getElementById('recentActivityList');
  if (!container) return;

  const rows = await fetchMergedAuditRows(5);
  if (!rows.length) {
    container.innerHTML = '<div class="lic-empty">No activity yet.</div>';
    return;
  }

  const dotColor = { created: '#16a34a', updated: '#2563eb', deleted: '#dc2626', renewed: '#16a34a', verified: '#2563eb' };

  container.innerHTML = rows.map(r => {
    const recordWord = r.record_type === 'ceu' ? 'CEU' : 'License';
    return `
      <div class="lic-activity-row">
        <span class="lic-activity-dot" style="background:${dotColor[r.change_type] ?? '#94a3b8'};"></span>
        <div class="lic-card-av lic-activity-av">${esc(initialsFor(r.employee_id))}</div>
        <div class="lic-activity-body">
          <span class="lic-activity-name">${esc(employeeLookup[r.employee_id] ?? '—')}</span>
          <span class="lic-activity-action">${recordWord} ${esc(r.change_type)}</span>
        </div>
        <span class="lic-activity-time">${formatRelativeShort(r.changed_at)}</span>
      </div>`;
  }).join('');
}

function formatRelativeShort(ts) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return `Today, ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + time;
}

// Shared by loadAuditLog() (full table) and loadRecentActivity() (Overview
// preview) so the two-table merge/sort logic only lives in one place.
async function fetchMergedAuditRows(limit) {
  const [licRes, ceuRes] = await Promise.all([
    supabase
      .from('staff_license_history')
      .select('id, employee_id, changed_at, change_type, field_changes, changed_by')
      .eq('school_id', currentProfile.school_id)
      .order('changed_at', { ascending: false })
      .limit(limit),
    supabase
      .from('staff_license_ceu_history')
      .select('id, employee_id, changed_at, change_type, field_changes, changed_by')
      .eq('school_id', currentProfile.school_id)
      .order('changed_at', { ascending: false })
      .limit(limit),
  ]);

  if (licRes.error || ceuRes.error) {
    console.error(licRes.error || ceuRes.error);
    return [];
  }

  return [
    ...(licRes.data || []).map(r => ({ ...r, record_type: 'license' })),
    ...(ceuRes.data || []).map(r => ({ ...r, record_type: 'ceu' })),
  ].sort((a, b) => new Date(b.changed_at) - new Date(a.changed_at)).slice(0, limit);
}

/* ─────────────────────────────────────────────────────
   ALL LICENSES TAB
───────────────────────────────────────────────────── */
async function loadLicenses() {
  const search  = document.getElementById('licSearch')?.value.trim().toLowerCase() ?? '';
  const status  = document.getElementById('licStatusFilter')?.value ?? '';
  const type    = document.getElementById('licTypeFilter')?.value ?? '';
  const campus  = document.getElementById('licCampusFilter')?.value ?? '';
  const expiry  = document.getElementById('licExpiryFilter')?.value ?? '';
  const today   = new Date().toISOString().slice(0, 10);

  let query = supabase
    .from('staff_licenses')
    .select(`
      id, employee_id, campus_id,
      license_number, state, license_type, license_class, category,
      license_area, grade_authorization,
      issue_date, expiration_date,
      status, is_provisional, provisional_type,
      renewal_status, verified, alert_muted,
      notes, role_applicability
    `)
    .eq('school_id', currentProfile.school_id)
    .order('expiration_date', { ascending: true });

  if (status) query = query.eq('status', status);
  if (type)   query = query.eq('license_type', type);
  if (campus) query = query.eq('campus_id', campus);

  if (expiry === 'expired') {
    query = query.lt('expiration_date', today);
  } else if (expiry) {
    query = query.lte('expiration_date', offsetDate(parseInt(expiry))).gte('expiration_date', today);
  }

  const { data, error } = await query;
  if (error) {
    const container = document.getElementById('licenseTableBody');
    if (container) container.innerHTML = `<div class="lic-empty" style="color:#dc2626;">Failed to load licenses. Please try again.</div>`;
    console.error(error);
    return;
  }

  let rows = data || [];

  if (search) {
    rows = rows.filter(r => {
      const name = (employeeLookup[r.employee_id] ?? '').toLowerCase();
      return name.includes(search)
        || (r.license_area ?? '').toLowerCase().includes(search)
        || (r.license_number ?? '').toLowerCase().includes(search);
    });
  }

  allLicenses = rows;

  // Look up which of these licenses have a current attachment, so the list
  // can offer a one-click "open attachment" without going through the drawer.
  currentFilesByLicense = {};
  const ids = rows.map(r => r.id);
  if (ids.length) {
    const { data: files } = await supabase
      .from('staff_license_files')
      .select('license_id, file_path, file_name')
      .eq('school_id', currentProfile.school_id)
      .eq('is_current', true)
      .in('license_id', ids);
    (files ?? []).forEach(f => { currentFilesByLicense[f.license_id] = f; });
  }

  renderLicenseTable(rows);
}

function renderLicenseTable(rows) {
  const container = document.getElementById('licenseTableBody');
  const today = new Date().toISOString().slice(0, 10);

  if (!rows.length) {
    container.innerHTML = '<div class="lic-empty">No licenses found.</div>';
    return;
  }

  container.innerHTML = '';
  rows.forEach(lic => {
    const daysLeft   = lic.expiration_date ? daysBetween(today, lic.expiration_date) : null;
    const isExpired  = daysLeft !== null && daysLeft < 0;
    const isUrgent   = !isExpired && daysLeft !== null && daysLeft <= 30;
    const isWarn     = !isExpired && !isUrgent && daysLeft !== null && daysLeft <= 90;

    const borderCls  = isExpired ? 'lic-card-expired' : isUrgent ? 'lic-card-urgent' : isWarn ? 'lic-card-warn' : 'lic-card-ok';
    const daysCls    = isExpired ? 'lic-days-expired' : isUrgent ? 'lic-days-urgent' : isWarn ? 'lic-days-warn' : 'lic-days-ok';
    const daysLabel  = daysLeft === null ? '' : isExpired ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d away`;

    const nameParts  = (employeeLookup[lic.employee_id] ?? '').split(',');
    const initials   = [nameParts[1]?.trim()[0], nameParts[0]?.trim()[0]].filter(Boolean).join('').toUpperCase() || '?';

    const meta = [
      lic.license_type + (lic.license_class ? ` (${lic.license_class})` : ''),
      lic.license_area,
      lic.grade_authorization,
      lic.license_number ? `#${lic.license_number}` : null,
    ].filter(Boolean).join(' · ');

    const flags = [
      lic.verified        ? `<span class="lic-flag lic-flag-ok">✓ Verified</span>` : '',
      lic.is_provisional  ? `<span class="lic-flag lic-flag-warn">Provisional</span>` : '',
      lic.alert_muted     ? `<span class="lic-flag lic-flag-muted">Muted</span>` : '',
    ].filter(Boolean).join('');

    const card = document.createElement('div');
    card.className = `lic-card ${borderCls}`;
    card.innerHTML = `
      <div class="lic-card-av">${esc(initials)}</div>
      <div class="lic-card-body">
        <div class="lic-card-name">${esc(employeeLookup[lic.employee_id] ?? '—')}</div>
        <div class="lic-card-meta">${esc(meta) || '—'}</div>
        ${flags ? `<div class="lic-card-flags">${flags}</div>` : ''}
      </div>
      <div class="lic-card-expiry">
        <div class="lic-card-date">${formatDate(lic.expiration_date)}</div>
        ${daysLabel ? `<div class="lic-card-days ${daysCls}">${esc(daysLabel)}</div>` : ''}
      </div>
      <div class="lic-card-status">${statusBadge(lic.status)}</div>
      <div class="lic-card-actions">
        ${currentFilesByLicense[lic.id] ? `<button class="lic-btn-icon lic-btn-attach openAttachBtn" data-id="${lic.id}" title="Open attachment: ${esc(currentFilesByLicense[lic.id].file_name)}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>` : ''}
        <button class="lic-btn-icon editLicBtn" data-id="${lic.id}" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="lic-btn-icon lic-btn-danger deleteLicBtn" data-id="${lic.id}" title="Delete">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.openAttachBtn').forEach(btn =>
    btn.addEventListener('click', () => openLicenseAttachment(btn.dataset.id))
  );
  container.querySelectorAll('.editLicBtn').forEach(btn =>
    btn.addEventListener('click', () => openEditModal(btn.dataset.id))
  );
  container.querySelectorAll('.deleteLicBtn').forEach(btn =>
    btn.addEventListener('click', () => deleteLicense(btn.dataset.id))
  );
}

// Open the current attachment for a license straight from its row. The blank
// tab is opened synchronously on the click so the popup blocker treats it as a
// user-initiated action; we then point it at the signed URL once it resolves.
async function openLicenseAttachment(licenseId) {
  const file = currentFilesByLicense[licenseId];
  if (!file) return;

  const win = window.open('', '_blank');
  if (win) win.opener = null;
  const { data, error } = await supabase.storage
    .from('license-files')
    .createSignedUrl(file.file_path, 3600);

  if (error || !data?.signedUrl) {
    if (win) win.close();
    console.error('Could not open attachment', error);
    showToast('Could not open attachment.', 'error');
    return;
  }

  if (win) win.location = data.signedUrl;
  else window.open(data.signedUrl, '_blank', 'noopener');  // fallback if blocked
}

/* ─────────────────────────────────────────────────────
   AUDIT LOG TAB
───────────────────────────────────────────────────── */
async function loadAuditLog() {
  const search = document.getElementById('auditSearch')?.value.trim().toLowerCase() ?? '';

  let rows = await fetchMergedAuditRows(200);

  if (!rows.length) {
    const tbody = document.getElementById('auditTableBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="lic-empty">No audit history yet.</td></tr>';
    return;
  }

  // Resolve changed_by user_ids → display names
  const changerIds = [...new Set(rows.map(r => r.changed_by).filter(Boolean))];
  const changerLookup = {};
  if (changerIds.length) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, display_name')
      .in('user_id', changerIds);
    (profiles ?? []).forEach(p => { changerLookup[p.user_id] = p.display_name ?? p.user_id; });
  }

  // Resolve license_id values inside CEU-history diffs → readable labels.
  // campus_id (the other FK-valued diff field) already has campusLookup
  // available from init() regardless of which tab is active.
  const licenseIds = new Set();
  rows.forEach(r => {
    const v = r.field_changes?.license_id;
    if (v?.old) licenseIds.add(v.old);
    if (v?.new) licenseIds.add(v.new);
  });
  const licenseLabelLookup = {};
  if (licenseIds.size) {
    const { data: licenses } = await supabase
      .from('staff_licenses')
      .select('id, license_type, license_area')
      .in('id', [...licenseIds]);
    (licenses ?? []).forEach(l => {
      licenseLabelLookup[l.id] = l.license_type + (l.license_area ? ' — ' + l.license_area : '');
    });
  }

  const tbody = document.getElementById('auditTableBody');

  if (search) {
    rows = rows.filter(r => {
      const name = (employeeLookup[r.employee_id] ?? '').toLowerCase();
      const changer = (changerLookup[r.changed_by] ?? '').toLowerCase();
      return name.includes(search) || r.change_type.toLowerCase().includes(search) || changer.includes(search);
    });
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="lic-empty">No audit history yet.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  rows.forEach(r => {
    const changerProfile = changerLookup[r.changed_by] ?? '—';
    const details = r.field_changes
      ? Object.entries(r.field_changes)
          .map(([k, v]) => `${esc(prettyFieldName(k))}: ${esc(formatFieldValue(k, v.old, licenseLabelLookup))} → ${esc(formatFieldValue(k, v.new, licenseLabelLookup))}`)
          .join(', ')
      : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(r.changed_at)}</td>
      <td>${esc(employeeLookup[r.employee_id] ?? '—')}</td>
      <td>${r.record_type === 'ceu' ? 'CEU' : 'License'}</td>
      <td><span class="badge badge-${changeTypeBadge(r.change_type)}">${esc(r.change_type)}</span></td>
      <td>${esc(changerProfile)}</td>
      <td>${details}</td>
    `;
    tbody.appendChild(tr);
  });
}

/* ─────────────────────────────────────────────────────
   MODAL — ADD
───────────────────────────────────────────────────── */
function openAddModal() {
  editingId = null;
  currentEditingLicense = null;
  document.getElementById('licenseModalTitle').textContent = 'Add License';
  document.getElementById('staffSelectRow').style.display = '';
  document.getElementById('saveLicenseBtn').textContent = 'Save License';
  document.getElementById('ceuPanelSection').style.display = 'none';
  resetForm();
  window.openDrawer?.('licenseDrawer');
}

function openEditModal(id) {
  const lic = allLicenses.find(l => l.id === id);
  if (!lic) return;

  editingId = id;
  currentEditingLicense = lic;
  document.getElementById('licenseModalTitle').textContent = 'Edit License';
  document.getElementById('staffSelectRow').style.display = 'none';
  document.getElementById('saveLicenseBtn').textContent = 'Update License';

  document.getElementById('licNumber').value         = lic.license_number ?? '';
  document.getElementById('licState').value          = lic.state ?? 'NC';
  document.getElementById('licType').value           = lic.license_type ?? '';
  document.getElementById('licClass').value          = lic.license_class ?? '';
  document.getElementById('licCategory').value       = lic.category ?? 'teaching';
  document.getElementById('licArea').value           = lic.license_area ?? '';
  document.getElementById('licGrade').value          = lic.grade_authorization ?? '';
  document.getElementById('licStatus').value         = lic.status ?? 'active';
  document.getElementById('licRenewalStatus').value  = lic.renewal_status ?? 'not_started';
  document.getElementById('licProvisional').checked  = lic.is_provisional ?? false;
  document.getElementById('licProvisionalType').value = lic.provisional_type ?? 'emergency';
  document.getElementById('licCampus').value         = lic.campus_id ?? '';
  document.getElementById('licVerified').checked     = lic.verified ?? false;
  document.getElementById('licAlertMuted').checked   = lic.alert_muted ?? false;
  document.getElementById('licNotes').value          = lic.notes ?? '';

  if (fpIssue) fpIssue.setDate(lic.issue_date ?? null, true);
  if (fpExp)   fpExp.setDate(lic.expiration_date ?? null, true);

  toggleProvisionalRow(lic.is_provisional);

  // Role checkboxes
  const roles = lic.role_applicability ?? [];
  document.querySelectorAll('.role-checks input[type=checkbox]').forEach(cb => {
    cb.checked = roles.includes(cb.value);
  });

  resetFileSection();
  loadLicenseFiles(id);

  document.getElementById('ceuPanelSection').style.display = '';
  loadLicenseCeuPanel(id, lic);

  window.openDrawer?.('licenseDrawer');
}

function resetForm() {
  ['licNumber','licArea','licClass','licNotes'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('licState').value         = 'NC';
  document.getElementById('licType').value          = '';
  document.getElementById('licCategory').value      = 'teaching';
  document.getElementById('licGrade').value         = '';
  document.getElementById('licStatus').value        = 'active';
  document.getElementById('licRenewalStatus').value = 'not_started';
  document.getElementById('licProvisional').checked = false;
  document.getElementById('licCampus').value        = '';
  document.getElementById('licVerified').checked    = false;
  document.getElementById('licAlertMuted').checked  = false;
  document.getElementById('licStaff').value         = '';
  if (fpIssue) fpIssue.clear();
  if (fpExp)   fpExp.clear();
  toggleProvisionalRow(false);
  document.querySelectorAll('.role-checks input[type=checkbox]').forEach(cb => { cb.checked = false; });
  resetFileSection();
}

/* ─────────────────────────────────────────────────────
   SAVE / DELETE
───────────────────────────────────────────────────── */
// Stamps verified_by/verified_at the moment `verified` actually flips, and
// clears them on the way back to unverified -- left untouched on saves where
// verified doesn't change, so a later edit of some other field doesn't
// overwrite who originally verified it.
function applyVerificationStamp(payload, wasVerified) {
  if (payload.verified && !wasVerified) {
    payload.verified_by = currentProfile.user_id;
    payload.verified_at = new Date().toISOString();
  } else if (!payload.verified && wasVerified) {
    payload.verified_by = null;
    payload.verified_at = null;
  }
  return payload;
}

async function saveLicense() {
  const isEdit   = !!editingId;
  const schoolId = currentProfile.school_id;
  const old      = isEdit ? allLicenses.find(l => l.id === editingId) : null;

  const employeeId = isEdit ? old?.employee_id : document.getElementById('licStaff').value;

  if (!employeeId) { showToast('Please select a staff member.', 'warn'); return; }

  const licType = document.getElementById('licType').value;
  if (!licType) { showToast('License type is required.', 'warn'); return; }

  const expDate = document.getElementById('licExpDate').value;
  if (!expDate) { showToast('Expiration date is required.', 'warn'); return; }

  const roleChecks = [...document.querySelectorAll('.role-checks input[type=checkbox]')]
    .filter(cb => cb.checked).map(cb => cb.value);

  const payload = {
    school_id:           schoolId,
    employee_id:         employeeId,
    license_number:      document.getElementById('licNumber').value.trim() || null,
    state:               document.getElementById('licState').value,
    license_type:        licType,
    license_class:       document.getElementById('licClass').value.trim() || null,
    category:            document.getElementById('licCategory').value,
    license_area:        document.getElementById('licArea').value.trim() || null,
    grade_authorization: document.getElementById('licGrade').value || null,
    issue_date:          document.getElementById('licIssueDate').value || null,
    expiration_date:     expDate,
    status:              document.getElementById('licStatus').value,
    renewal_status:      document.getElementById('licRenewalStatus').value,
    is_provisional:      document.getElementById('licProvisional').checked,
    provisional_type:    document.getElementById('licProvisional').checked
                           ? document.getElementById('licProvisionalType').value : null,
    campus_id:           document.getElementById('licCampus').value || null,
    role_applicability:  roleChecks,
    verified:            document.getElementById('licVerified').checked,
    alert_muted:         document.getElementById('licAlertMuted').checked,
    notes:               document.getElementById('licNotes').value.trim() || null,
  };

  const wasVerified = isEdit ? !!old?.verified : false;
  applyVerificationStamp(payload, wasVerified);
  const verificationChanged = payload.verified !== wasVerified;

  let licenseId;

  if (isEdit) {
    const changes = diffObjects(old, payload);
    const { error } = await supabase.from('staff_licenses').update(payload).eq('id', editingId);
    if (error) { console.error(error); showToast('Failed to save license.', 'error'); return; }

    // When expiration_date changes (renewal), clear the alert log so the new
    // expiration cycle sends fresh threshold alerts.
    if (old?.expiration_date !== payload.expiration_date) {
      await supabase.from('license_alert_log').delete().eq('license_id', editingId);
    }

    if (Object.keys(changes).length) {
      await writeHistory(editingId, schoolId, 'updated', changes, employeeId);
    }
    licenseId = editingId;
  } else {
    payload.created_by = currentProfile.user_id;
    const { data, error } = await supabase.from('staff_licenses').insert(payload).select().single();
    if (error) { console.error(error); showToast('Failed to save license.', 'error'); return; }
    await writeHistory(data.id, schoolId, 'created', null, employeeId);
    licenseId = data.id;
  }

  // Invalidate the cached license list for this employee so a newly added or
  // edited license shows up immediately in the CEU drawer's "Applies To
  // License" dropdown, instead of waiting for a page reload.
  delete ceuLicensesForStaff[employeeId];

  // Upload file if one was selected
  const fileInput = document.getElementById('licFileInput');
  if (fileInput?.files?.length) {
    await uploadLicenseFile(licenseId, fileInput.files[0]);
  }

  window.closeDrawer?.('licenseDrawer');
  await loadLicenses();

  if (verificationChanged) {
    supabase.functions.invoke('send_license_verification_notification', {
      body: { record_type: 'license', record_id: licenseId, verified: payload.verified }
    }).catch(err => console.error('verification notification failed', err));
  }
}

async function deleteLicense(id) {
  const lic = allLicenses.find(l => l.id === id);
  const name = lic ? (employeeLookup[lic.employee_id] ?? 'this staff member') : 'this record';
  const confirmed = await showConfirm(
    'Delete License',
    `Delete the ${lic?.license_type ?? 'license'} record for ${name}? This cannot be undone.`
  );
  if (!confirmed) return;
  if (lic) await writeHistory(id, currentProfile.school_id, 'deleted', null, lic.employee_id);
  const { error } = await supabase.from('staff_licenses').delete().eq('id', id);
  if (error) { console.error(error); showToast('Failed to delete license.', 'error'); return; }
  if (lic) delete ceuLicensesForStaff[lic.employee_id];
  await loadLicenses();
}

async function writeHistory(licenseId, schoolId, changeType, fieldChanges, employeeId) {
  const { error } = await supabase.from('staff_license_history').insert({
    license_id:    licenseId,
    employee_id:   employeeId,
    school_id:     schoolId,
    changed_by:    currentProfile.user_id,
    change_type:   changeType,
    field_changes: fieldChanges,
  });
  if (error) console.error('license history write failed', error);
}

function diffCeuObjects(oldObj, newObj) {
  const changes = {};
  const keys = ['license_id','category','title','provider','source_type','hours','completed_date','verified','notes'];
  keys.forEach(k => {
    const oldVal = JSON.stringify(oldObj[k] ?? null);
    const newVal = JSON.stringify(newObj[k] ?? null);
    if (oldVal !== newVal) changes[k] = { old: oldObj[k], new: newObj[k] };
  });
  return changes;
}

async function writeCeuHistory(ceuId, schoolId, changeType, fieldChanges, employeeId) {
  const { error } = await supabase.from('staff_license_ceu_history').insert({
    ceu_id:        ceuId,
    employee_id:   employeeId,
    school_id:     schoolId,
    changed_by:    currentProfile.user_id,
    change_type:   changeType,
    field_changes: fieldChanges,
  });
  if (error) console.error('CEU history write failed', error);
}

/* ─────────────────────────────────────────────────────
   FILE ATTACHMENTS
───────────────────────────────────────────────────── */

function resetFileSection() {
  const fileInput = document.getElementById('licFileInput');
  if (fileInput) fileInput.value = '';
  const label = document.getElementById('licFileNameLabel');
  if (label) label.textContent = 'No file chosen';
  const current = document.getElementById('licCurrentFile');
  if (current) { current.hidden = true; current.innerHTML = ''; }
  const history = document.getElementById('licFileHistory');
  if (history) { history.hidden = true; history.innerHTML = ''; }
}

async function uploadLicenseFile(licenseId, file) {
  const ts       = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path     = `${currentProfile.school_id}/${licenseId}/${ts}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from('license-files')
    .upload(path, file, { upsert: false });

  if (uploadError) {
    console.error('File upload failed', uploadError);
    showToast('File upload failed: ' + uploadError.message, 'error');
    return;
  }

  // Mark any existing files as no longer current
  await supabase
    .from('staff_license_files')
    .update({ is_current: false })
    .eq('license_id', licenseId);

  // Record the new file
  const { error: linkError } = await supabase.from('staff_license_files').insert({
    license_id:  licenseId,
    school_id:   currentProfile.school_id,
    file_path:   path,
    file_name:   file.name,
    uploaded_by: currentProfile.user_id,
    is_current:  true,
  });
  if (linkError) {
    console.error('License file link failed', linkError);
    showToast('File uploaded, but attaching it to the license failed: ' + linkError.message, 'error');
  }
}

async function loadLicenseFiles(licenseId) {
  const { data: files, error } = await supabase
    .from('staff_license_files')
    .select('id, file_name, file_path, uploaded_at, is_current')
    .eq('license_id', licenseId)
    .order('uploaded_at', { ascending: false });

  if (error || !files?.length) return;
  await renderFileSection(files);
}

async function renderFileSection(files) {
  const current = files.find(f => f.is_current);
  const history = files.filter(f => !f.is_current);

  const currentDiv = document.getElementById('licCurrentFile');
  const historyDiv = document.getElementById('licFileHistory');

  if (current && currentDiv) {
    const { data: signed } = await supabase.storage
      .from('license-files')
      .createSignedUrl(current.file_path, 3600);

    currentDiv.hidden = false;
    currentDiv.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <a href="${esc(signed?.signedUrl ?? '#')}" target="_blank" rel="noopener">${esc(current.file_name)}</a>
      <span class="muted" style="font-size:11px;margin-left:auto;">Current</span>
    `;
  }

  if (history.length && historyDiv) {
    // Generate signed URLs for history files in parallel
    const signedHistoryUrls = await Promise.all(
      history.map(f => supabase.storage.from('license-files').createSignedUrl(f.file_path, 3600))
    );

    historyDiv.hidden = false;
    historyDiv.innerHTML =
      '<div class="lic-file-history-label">Previous versions</div>' +
      history.map((f, i) => {
        const url = signedHistoryUrls[i]?.data?.signedUrl ?? '#';
        return `
          <div class="lic-file-old-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <a href="${esc(url)}" target="_blank" rel="noopener">${esc(f.file_name)}</a>
            <span style="margin-left:auto;">${formatDate(f.uploaded_at.slice(0, 10))}</span>
          </div>`;
      }).join('');
  }
}

/* ─────────────────────────────────────────────────────
   CEUs — TAB (all staff, cross-license)
───────────────────────────────────────────────────── */
async function loadCeus() {
  const search         = document.getElementById('ceuSearch')?.value.trim().toLowerCase() ?? '';
  const category        = document.getElementById('ceuCategoryFilter')?.value ?? '';
  const verifiedFilter  = document.getElementById('ceuVerifiedFilter')?.value ?? '';

  let query = supabase
    .from('staff_license_ceus')
    .select(`
      id, license_id, employee_id, category, title, provider, source_type,
      hours, ceu_amount, completed_date, verified, file_path, file_name, notes,
      staff_licenses ( license_type, license_area )
    `)
    .eq('school_id', currentProfile.school_id)
    .order('completed_date', { ascending: false });

  if (category) query = query.eq('category', category);
  if (verifiedFilter === 'verified')   query = query.eq('verified', true);
  if (verifiedFilter === 'unverified') query = query.eq('verified', false);

  const { data, error } = await query;
  if (error) {
    const container = document.getElementById('ceuTableBody');
    if (container) container.innerHTML = `<div class="lic-empty" style="color:#dc2626;">Failed to load CEU records. Please try again.</div>`;
    console.error(error);
    return;
  }

  let rows = data || [];
  if (search) {
    rows = rows.filter(r => {
      const name = (employeeLookup[r.employee_id] ?? '').toLowerCase();
      return name.includes(search)
        || (r.title ?? '').toLowerCase().includes(search)
        || (r.provider ?? '').toLowerCase().includes(search);
    });
  }

  allCeus = rows;
  renderCeuTable(rows);
}

function renderCeuTable(rows) {
  const container = document.getElementById('ceuTableBody');

  if (!rows.length) {
    container.innerHTML = '<div class="lic-empty">No CEU records found.</div>';
    return;
  }

  container.innerHTML = '';
  rows.forEach(c => {
    const nameParts = (employeeLookup[c.employee_id] ?? '').split(',');
    const initials  = [nameParts[1]?.trim()[0], nameParts[0]?.trim()[0]].filter(Boolean).join('').toUpperCase() || '?';
    const licLabel  = c.staff_licenses
      ? c.staff_licenses.license_type + (c.staff_licenses.license_area ? ' · ' + c.staff_licenses.license_area : '')
      : '—';

    const card = document.createElement('div');
    card.className = 'ceu-card';
    card.innerHTML = `
      <div class="lic-card-av">${esc(initials)}</div>
      <div class="ceu-card-body">
        <div class="ceu-card-title">${esc(employeeLookup[c.employee_id] ?? '—')} · ${esc(c.title)}</div>
        <div class="ceu-card-meta">
          <span class="ceu-cat ceu-cat-${c.category}">${esc(CEU_CATEGORY_LABELS[c.category] ?? c.category)}</span>
          &nbsp;${esc(licLabel)}${c.provider ? ' · ' + esc(c.provider) : ''}
        </div>
      </div>
      <div class="ceu-card-amount">
        <div class="ceu-card-ceus">${Number(c.ceu_amount).toFixed(1)} CEU ${c.verified ? '<span class="verified-check" title="Verified">✓</span>' : ''}</div>
        <div class="ceu-card-date">${formatDate(c.completed_date)}</div>
      </div>
      <div class="ceu-card-actions">
        <button class="lic-btn-icon editCeuRowBtn" data-id="${c.id}" title="Edit">${EDIT_ICON_SVG}</button>
        <button class="lic-btn-icon lic-btn-danger deleteCeuRowBtn" data-id="${c.id}" title="Delete">${TRASH_ICON_SVG}</button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.editCeuRowBtn').forEach(btn =>
    btn.addEventListener('click', () => openEditCeuModal(btn.dataset.id))
  );
  container.querySelectorAll('.deleteCeuRowBtn').forEach(btn =>
    btn.addEventListener('click', () => deleteCeu(btn.dataset.id))
  );
}

function exportCeus() {
  if (!allCeus.length) { showToast('No CEU records to export.', 'warn'); return; }

  const today = new Date().toISOString().slice(0, 10);
  const rows = allCeus.map(c => ({
    'Staff Member':    employeeLookup[c.employee_id] ?? '',
    'License':         c.staff_licenses ? (c.staff_licenses.license_type + (c.staff_licenses.license_area ? ' - ' + c.staff_licenses.license_area : '')) : '',
    'Category':        CEU_CATEGORY_LABELS[c.category] ?? c.category,
    'Title':           c.title,
    'Provider':        c.provider ?? '',
    'Source':          c.source_type,
    'Hours':           c.hours,
    'CEUs':            c.ceu_amount,
    'Completed Date':  c.completed_date,
    'Verified':        c.verified ? 'Yes' : 'No',
    'Notes':           c.notes ?? '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'CEUs');
  XLSX.writeFile(wb, `ceu-export-${today}.xlsx`);
}

/* ─────────────────────────────────────────────────────
   CEUs — PROGRESS PANEL (embedded in the license drawer)
───────────────────────────────────────────────────── */
async function loadLicenseCeuPanel(licenseId, lic) {
  const body = document.getElementById('ceuPanelBody');
  if (body) body.innerHTML = '<div class="lic-empty" style="padding:16px 0;">Loading…</div>';

  const { data, error } = await supabase
    .from('staff_license_ceus')
    .select('id, license_id, employee_id, category, title, provider, source_type, hours, ceu_amount, completed_date, verified, file_path, file_name, notes')
    .eq('license_id', licenseId)
    .order('completed_date', { ascending: false });

  if (error) {
    console.error(error);
    if (body) body.innerHTML = '<div class="lic-empty" style="color:#dc2626;">Failed to load CEU entries.</div>';
    return;
  }

  currentLicenseCeus = data || [];
  renderCeuPanel(lic, currentLicenseCeus);
}

function renderCeuPanel(lic, ceus) {
  const body = document.getElementById('ceuPanelBody');
  if (!body) return;

  const start   = cycleStartDate(lic.expiration_date);
  const inCycle = start ? ceus.filter(c => c.completed_date >= start) : ceus;
  const profile = ceuTargetProfile(lic);
  const total   = inCycle.reduce((sum, c) => sum + Number(c.ceu_amount), 0);

  let html = `<div class="ceu-progress-total">CEU Progress (this cycle) <span>${total.toFixed(1)} / ${profile ? CEU_TOTAL_TARGET : '—'}</span></div>`;

  if (profile) {
    html += Object.entries(profile).map(([cat, target]) => {
      const earned = inCycle.filter(c => c.category === cat).reduce((s, c) => s + Number(c.ceu_amount), 0);
      const pct    = Math.min(100, (earned / target) * 100);
      const short  = earned < target;
      return `
        <div class="ceu-progress-row">
          <div class="ceu-progress-row-head"><span>${esc(CEU_CATEGORY_LABELS[cat])}</span><span>${earned.toFixed(1)} / ${target}</span></div>
          <div class="ceu-progress-bar-track"><div class="ceu-progress-bar-fill ${short ? 'short' : ''}" style="width:${pct}%;"></div></div>
        </div>`;
    }).join('');
  } else {
    const hint = lic.category === 'teaching' ? ' and Grade Authorization' : '';
    html += `<div class="ceu-no-profile">Set Category${hint} above to see the NC category breakdown.</div>`;
  }

  if (ceus.length) {
    html += '<div class="ceu-entry-list">' + ceus.map(c => `
      <div class="ceu-entry-row">
        <span class="ceu-cat ceu-cat-${c.category}">${esc(CEU_CATEGORY_LABELS[c.category] ?? c.category)}</span>
        <span class="ceu-entry-title">${esc(c.title)}</span>
        <span class="ceu-entry-ceus">${Number(c.ceu_amount).toFixed(1)} CEU</span>
        ${c.verified ? '<span class="verified-check" title="Verified">✓</span>' : ''}
        <button type="button" class="lic-btn-icon editCeuPanelBtn" data-id="${c.id}" title="Edit">${EDIT_ICON_SVG}</button>
        <button type="button" class="lic-btn-icon lic-btn-danger deleteCeuPanelBtn" data-id="${c.id}" title="Delete">${TRASH_ICON_SVG}</button>
      </div>`).join('') + '</div>';
  } else {
    html += '<div class="lic-empty" style="padding:12px 0;">No CEU entries logged yet.</div>';
  }

  body.innerHTML = html;

  body.querySelectorAll('.editCeuPanelBtn').forEach(btn =>
    btn.addEventListener('click', () => openEditCeuModal(btn.dataset.id, { returnLicenseId: lic.id }))
  );
  body.querySelectorAll('.deleteCeuPanelBtn').forEach(btn =>
    btn.addEventListener('click', () => deleteCeu(btn.dataset.id, lic.id))
  );
}

/* ─────────────────────────────────────────────────────
   CEUs — ENTRY DRAWER (add / edit)
───────────────────────────────────────────────────── */
function resetCeuForm() {
  document.getElementById('ceuTitle').value        = '';
  document.getElementById('ceuProvider').value     = '';
  document.getElementById('ceuCategory').value     = 'literacy';
  document.getElementById('ceuSourceType').value   = 'lea_inservice';
  document.getElementById('ceuHours').value        = '';
  document.getElementById('ceuVerified').checked   = false;
  document.getElementById('ceuNotes').value        = '';
  document.getElementById('ceuStaff').value        = '';
  document.getElementById('ceuLicense').innerHTML  = '<option value="">Select staff member first…</option>';
  if (fpCeuDate) fpCeuDate.clear();
  updateCeuHoursLabel();
  resetCeuFileSection();
}

function resetCeuFileSection() {
  const fileInput = document.getElementById('ceuFileInput');
  if (fileInput) fileInput.value = '';
  const label = document.getElementById('ceuFileNameLabel');
  if (label) label.textContent = 'No file chosen';
  const current = document.getElementById('ceuCurrentFile');
  if (current) { current.hidden = true; current.innerHTML = ''; }
}

function updateCeuHoursLabel() {
  const src   = document.getElementById('ceuSourceType').value;
  const label = document.getElementById('ceuHoursLabel');
  label.innerHTML = src === 'college_credit'
    ? 'Semester Credits <span class="required">*</span>'
    : 'Clock Hours <span class="required">*</span>';
  updateCeuAmountPreview();
}

function updateCeuAmountPreview() {
  const src     = document.getElementById('ceuSourceType').value;
  const hours   = parseFloat(document.getElementById('ceuHours').value);
  const preview = document.getElementById('ceuAmountPreview');
  if (!preview) return;
  if (!hours || hours <= 0) { preview.textContent = ''; return; }
  const ceu = src === 'college_credit' ? hours * 1.5 : hours / 10;
  preview.textContent = `= ${ceu.toFixed(1)} CEU${ceu === 1 ? '' : 's'}`;
}

async function populateCeuLicenseOptions(employeeId, preselectLicenseId) {
  const sel = document.getElementById('ceuLicense');
  if (!sel) return;
  if (!employeeId) { sel.innerHTML = '<option value="">Select staff member first…</option>'; return; }

  if (!ceuLicensesForStaff[employeeId]) {
    const { data } = await supabase
      .from('staff_licenses')
      .select('id, license_type, license_area, category, grade_authorization, expiration_date')
      .eq('school_id', currentProfile.school_id)
      .eq('employee_id', employeeId)
      .order('expiration_date', { ascending: true });
    ceuLicensesForStaff[employeeId] = data || [];
  }

  const licenses = ceuLicensesForStaff[employeeId];
  sel.innerHTML = '<option value="">No linked license (general CEU)</option>' + licenses.map(l =>
    `<option value="${l.id}">${esc(l.license_type)}${l.license_area ? ' — ' + esc(l.license_area) : ''}</option>`
  ).join('');
  if (preselectLicenseId) sel.value = preselectLicenseId;
}

function openAddCeuModal({ licenseId = null, employeeId = null } = {}) {
  editingCeuId        = null;
  ceuReturnLicenseId  = licenseId;
  lockedCeuEmployeeId = employeeId;
  lockedCeuLicenseId  = licenseId;

  document.getElementById('ceuModalTitle').textContent = 'Add CEU Entry';
  document.getElementById('saveCeuBtn').textContent    = 'Save Entry';
  resetCeuForm();

  const lockRows = !!(licenseId && employeeId);
  document.getElementById('ceuStaffSelectRow').style.display   = lockRows ? 'none' : '';
  document.getElementById('ceuLicenseSelectRow').style.display = lockRows ? 'none' : '';

  if (lockRows) {
    document.getElementById('ceuStaff').value = employeeId;
    populateCeuLicenseOptions(employeeId, licenseId);
    if (currentEditingLicense) document.getElementById('ceuCategory').value = suggestedCeuCategory(currentEditingLicense);
  }

  window.closeDrawer?.('licenseDrawer');
  window.openDrawer?.('ceuDrawer');
}

async function openEditCeuModal(id, { returnLicenseId = null } = {}) {
  const entry = allCeus.find(c => c.id === id) || currentLicenseCeus.find(c => c.id === id);
  if (!entry) return;

  editingCeuId        = id;
  ceuReturnLicenseId  = returnLicenseId;
  lockedCeuEmployeeId = entry.employee_id ?? currentEditingLicense?.employee_id;
  // entry.license_id may legitimately be null (a general, unlinked CEU) --
  // don't let `??` fall through to currentEditingLicense in that case, or
  // editing a general CEU opened from the cross-license CEUs tab could
  // silently re-link it.
  lockedCeuLicenseId  = entry.license_id;

  document.getElementById('ceuModalTitle').textContent = 'Edit CEU Entry';
  document.getElementById('saveCeuBtn').textContent    = 'Update Entry';
  document.getElementById('ceuStaffSelectRow').style.display   = 'none';
  // Unlike the staff field, the license link stays editable in edit mode --
  // this is how a general CEU (added before any license existed, or before
  // one was verified) gets linked to a license after the fact.
  document.getElementById('ceuLicenseSelectRow').style.display = '';
  await populateCeuLicenseOptions(lockedCeuEmployeeId, entry.license_id);

  document.getElementById('ceuTitle').value       = entry.title ?? '';
  document.getElementById('ceuProvider').value    = entry.provider ?? '';
  document.getElementById('ceuCategory').value    = entry.category;
  document.getElementById('ceuSourceType').value  = entry.source_type;
  document.getElementById('ceuHours').value       = entry.hours;
  document.getElementById('ceuVerified').checked  = entry.verified;
  document.getElementById('ceuNotes').value       = entry.notes ?? '';
  if (fpCeuDate) fpCeuDate.setDate(entry.completed_date, true);
  updateCeuHoursLabel();

  resetCeuFileSection();
  if (entry.file_path) {
    const { data: signed } = await supabase.storage.from('ceu-files').createSignedUrl(entry.file_path, 3600);
    const current = document.getElementById('ceuCurrentFile');
    current.hidden = false;
    current.innerHTML = `${FILE_ICON_SVG}<a href="${esc(signed?.signedUrl ?? '#')}" target="_blank" rel="noopener">${esc(entry.file_name)}</a>`;
  }

  window.closeDrawer?.('licenseDrawer');
  window.openDrawer?.('ceuDrawer');
}

async function closeCeuDrawerAndReturn() {
  window.closeDrawer?.('ceuDrawer');
  if (ceuReturnLicenseId) await openEditModal(ceuReturnLicenseId);
}

async function saveCeu() {
  const isEdit     = !!editingCeuId;
  const schoolId   = currentProfile.school_id;
  const old        = isEdit ? (allCeus.find(c => c.id === editingCeuId) || currentLicenseCeus.find(c => c.id === editingCeuId)) : null;
  const employeeId = lockedCeuEmployeeId || document.getElementById('ceuStaff').value;
  // The license select is hidden (and its value stale/irrelevant) only when
  // adding a CEU from a license's own drawer panel -- there, lockedCeuLicenseId
  // must win outright rather than falling through to the hidden select's
  // leftover value. Every other case (top-level add, and all edits) reads the
  // select directly, since edit mode now leaves it open for re-linking a
  // general CEU to a license (or changing which one) after the fact.
  const licenseLocked = document.getElementById('ceuLicenseSelectRow').style.display === 'none';
  const licenseId = licenseLocked ? lockedCeuLicenseId : (document.getElementById('ceuLicense').value || null);

  if (!employeeId) { showToast('Please select a staff member.', 'warn'); return; }

  const title = document.getElementById('ceuTitle').value.trim();
  if (!title) { showToast('Title is required.', 'warn'); return; }

  const hours = parseFloat(document.getElementById('ceuHours').value);
  if (!hours || hours <= 0) { showToast('Enter a valid number of hours/credits.', 'warn'); return; }

  const completedDate = document.getElementById('ceuCompletedDate').value;
  if (!completedDate) { showToast('Completed date is required.', 'warn'); return; }

  const payload = {
    school_id:      schoolId,
    license_id:     licenseId,
    employee_id:    employeeId,
    category:       document.getElementById('ceuCategory').value,
    title,
    provider:       document.getElementById('ceuProvider').value.trim() || null,
    source_type:    document.getElementById('ceuSourceType').value,
    hours,
    completed_date: completedDate,
    verified:       document.getElementById('ceuVerified').checked,
    notes:          document.getElementById('ceuNotes').value.trim() || null,
  };

  const wasVerified = isEdit ? !!old?.verified : false;
  applyVerificationStamp(payload, wasVerified);
  const verificationChanged = payload.verified !== wasVerified;

  let ceuId;
  if (isEdit) {
    const changes = diffCeuObjects(old, payload);
    const { error } = await supabase.from('staff_license_ceus').update(payload).eq('id', editingCeuId);
    if (error) { console.error(error); showToast('Failed to save CEU entry.', 'error'); return; }
    if (Object.keys(changes).length) {
      await writeCeuHistory(editingCeuId, schoolId, 'updated', changes, employeeId);
    }
    ceuId = editingCeuId;
  } else {
    payload.created_by = currentProfile.user_id;
    const { data, error } = await supabase.from('staff_license_ceus').insert(payload).select().single();
    if (error) { console.error(error); showToast('Failed to save CEU entry.', 'error'); return; }
    await writeCeuHistory(data.id, schoolId, 'created', null, employeeId);
    ceuId = data.id;
  }

  const fileInput = document.getElementById('ceuFileInput');
  if (fileInput?.files?.length) {
    await uploadCeuFile(ceuId, fileInput.files[0]);
  }

  window.closeDrawer?.('ceuDrawer');

  if (ceuReturnLicenseId) {
    await openEditModal(ceuReturnLicenseId);
  } else {
    await loadCeus();
  }

  if (verificationChanged) {
    supabase.functions.invoke('send_license_verification_notification', {
      body: { record_type: 'ceu', record_id: ceuId, verified: payload.verified }
    }).catch(err => console.error('verification notification failed', err));
  }
}

async function deleteCeu(id, returnLicenseId = null) {
  const confirmed = await showConfirm('Delete CEU Entry', 'Delete this CEU entry? This cannot be undone.');
  if (!confirmed) return;

  const entry = allCeus.find(c => c.id === id) || currentLicenseCeus.find(c => c.id === id);
  if (entry) await writeCeuHistory(id, currentProfile.school_id, 'deleted', null, entry.employee_id);

  const { error } = await supabase.from('staff_license_ceus').delete().eq('id', id);
  if (error) { console.error(error); showToast('Failed to delete CEU entry.', 'error'); return; }

  if (returnLicenseId) {
    await loadLicenseCeuPanel(returnLicenseId, currentEditingLicense);
  } else {
    await loadCeus();
  }
}

async function uploadCeuFile(ceuId, file) {
  const ts       = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path     = `${currentProfile.school_id}/${ceuId}/${ts}-${safeName}`;

  const { error: uploadError } = await supabase.storage
    .from('ceu-files')
    .upload(path, file, { upsert: false });

  if (uploadError) {
    console.error('CEU file upload failed', uploadError);
    showToast('File upload failed: ' + uploadError.message, 'error');
    return;
  }

  const { error: linkError } = await supabase.from('staff_license_ceus')
    .update({ file_path: path, file_name: file.name })
    .eq('id', ceuId);
  if (linkError) {
    console.error('CEU file link failed', linkError);
    showToast('File uploaded, but attaching it to the entry failed: ' + linkError.message, 'error');
  }
}

/* ─────────────────────────────────────────────────────
   EXPORT
───────────────────────────────────────────────────── */
function exportLicenses() {
  if (!allLicenses.length) { showToast('No licenses to export.', 'warn'); return; }

  const today = new Date().toISOString().slice(0, 10);
  const rows = allLicenses.map(l => ({
    'Staff Member':       employeeLookup[l.employee_id] ?? '',
    'License Number':     l.license_number ?? '',
    'State':              l.state,
    'License Type':       l.license_type,
    'License Class':      l.license_class ?? '',
    'Category':           l.category,
    'License Area':       l.license_area ?? '',
    'Grade Authorization':l.grade_authorization ?? '',
    'Issue Date':         l.issue_date ?? '',
    'Expiration Date':    l.expiration_date ?? '',
    'Days Until Expiry':  l.expiration_date ? daysBetween(today, l.expiration_date) : '',
    'Status':             l.status,
    'Renewal Status':     l.renewal_status,
    'Provisional':        l.is_provisional ? 'Yes' : 'No',
    'Provisional Type':   l.provisional_type ?? '',
    'Campus':             campusLookup[l.campus_id] ?? 'All',
    'Roles':              (l.role_applicability ?? []).join(', '),
    'Verified':           l.verified ? 'Yes' : 'No',
    'Alert Muted':        l.alert_muted ? 'Yes' : 'No',
    'Notes':              l.notes ?? '',
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Licenses');
  XLSX.writeFile(wb, `licensure-export-${today}.xlsx`);
}

/* ─────────────────────────────────────────────────────
   VIEW ROUTING
───────────────────────────────────────────────────── */
async function setView(view) {
  document.querySelectorAll('.lic-view').forEach(s => s.style.display = 'none');
  document.querySelectorAll('nav a[data-view]').forEach(a => {
    a.classList.toggle('active', a.dataset.view === view);
  });

  const section = document.getElementById(view);
  if (section) section.style.display = '';

  if (view === 'overview') await loadCompliance();
  if (view === 'licenses')   await loadLicenses();
  if (view === 'ceus')       await loadCeus();
  if (view === 'audit')      await loadAuditLog();
}

/* ─────────────────────────────────────────────────────
   POPULATE SELECTS
───────────────────────────────────────────────────── */
function populateCampusSelects() {
  const entries = Object.entries(campusLookup);
  ['licCampus', 'licCampusFilter'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">All campuses</option>';
    entries.forEach(([cid, name]) => {
      const opt = document.createElement('option');
      opt.value = cid;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  });
}

function populateStaffSelect() {
  ['licStaff', 'ceuStaff'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">Select staff member…</option>';
    Object.entries(employeeLookup)
      .sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([empId, name]) => {
        const opt = document.createElement('option');
        opt.value = empId;
        opt.textContent = name;
        sel.appendChild(opt);
      });
  });
}

/* ─────────────────────────────────────────────────────
   DATE PICKERS
───────────────────────────────────────────────────── */
function initDatePickers() {
  fpIssue   = flatpickr('#licIssueDate',      { dateFormat: 'Y-m-d', allowInput: true });
  fpExp     = flatpickr('#licExpDate',        { dateFormat: 'Y-m-d', allowInput: true });
  fpCeuDate = flatpickr('#ceuCompletedDate',  { dateFormat: 'Y-m-d', allowInput: true, maxDate: 'today' });
}

/* ─────────────────────────────────────────────────────
   EVENT WIRING
───────────────────────────────────────────────────── */
function wireEvents() {
  // Nav tabs
  document.querySelectorAll('nav a[data-view]').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault();
      history.pushState(null, '', a.getAttribute('href'));
      setView(a.dataset.view);
    });
  });

  // Sign out
  document.getElementById('signOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });

  // ── Overview dashboard ──
  document.getElementById('ovAddLicenseBtn')?.addEventListener('click', openAddModal);

  // Stat tiles drill into All Licenses, pre-applying the matching expiry
  // filter where one exists (Total Active and Provisional have no matching
  // filter option, so they just switch tabs).
  document.querySelectorAll('#ovStatGrid [data-ov-link]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      const expiry = el.dataset.ovExpiry;
      const sel = document.getElementById('licExpiryFilter');
      if (sel) sel.value = expiry ?? '';
      history.pushState(null, '', '#licenses');
      setView('licenses');
    });
  });

  const goToLicenses = e => { e.preventDefault(); history.pushState(null, '', '#licenses'); setView('licenses'); };
  document.getElementById('ovViewUpcomingBtn')?.addEventListener('click', goToLicenses);
  document.getElementById('attnViewAllLink')?.addEventListener('click', goToLicenses);
  document.getElementById('upcomingViewAllLink')?.addEventListener('click', goToLicenses);
  document.getElementById('recentActivityLink')?.addEventListener('click', e => {
    e.preventDefault();
    history.pushState(null, '', '#audit');
    setView('audit');
  });

  // Add license
  document.getElementById('addLicenseBtn')?.addEventListener('click', openAddModal);

  // Export
  document.getElementById('exportLicensesBtn')?.addEventListener('click', exportLicenses);

  // Drawer close
  document.getElementById('closeLicenseModal')?.addEventListener('click', () => window.closeDrawer?.('licenseDrawer'));
  document.getElementById('cancelLicenseBtn')?.addEventListener('click', () => window.closeDrawer?.('licenseDrawer'));

  // Save
  document.getElementById('saveLicenseBtn')?.addEventListener('click', saveLicense);

  // Provisional toggle
  document.getElementById('licProvisional')?.addEventListener('change', e => {
    toggleProvisionalRow(e.target.checked);
  });

  // Live-refresh the CEU progress panel when Category/Grade change on an
  // open license, since the NC target profile depends on both.
  document.getElementById('licCategory')?.addEventListener('change', e => {
    if (!currentEditingLicense) return;
    currentEditingLicense = { ...currentEditingLicense, category: e.target.value };
    renderCeuPanel(currentEditingLicense, currentLicenseCeus);
  });
  document.getElementById('licGrade')?.addEventListener('change', e => {
    if (!currentEditingLicense) return;
    currentEditingLicense = { ...currentEditingLicense, grade_authorization: e.target.value };
    renderCeuPanel(currentEditingLicense, currentLicenseCeus);
  });

  // File choose button
  document.getElementById('licFileChooseBtn')?.addEventListener('click', () => {
    document.getElementById('licFileInput')?.click();
  });
  document.getElementById('licFileInput')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    const label = document.getElementById('licFileNameLabel');
    if (label) label.textContent = file ? file.name : 'No file chosen';
  });

  // Filters — debounced reload
  const debounced = debounce(() => loadLicenses(), 300);
  ['licSearch','licStatusFilter','licTypeFilter','licCampusFilter','licExpiryFilter']
    .forEach(id => document.getElementById(id)?.addEventListener('input', debounced));

  document.getElementById('auditSearch')?.addEventListener('input',
    debounce(() => loadAuditLog(), 300)
  );

  // ── CEUs ──
  document.getElementById('addCeuBtn')?.addEventListener('click', () => openAddCeuModal());
  document.getElementById('addCeuFromLicenseBtn')?.addEventListener('click', () => {
    if (!currentEditingLicense) return;
    openAddCeuModal({ licenseId: currentEditingLicense.id, employeeId: currentEditingLicense.employee_id });
  });
  document.getElementById('exportCeusBtn')?.addEventListener('click', exportCeus);

  document.getElementById('closeCeuModal')?.addEventListener('click', closeCeuDrawerAndReturn);
  document.getElementById('cancelCeuBtn')?.addEventListener('click', closeCeuDrawerAndReturn);
  document.getElementById('saveCeuBtn')?.addEventListener('click', saveCeu);

  document.getElementById('ceuStaff')?.addEventListener('change', e => {
    populateCeuLicenseOptions(e.target.value);
  });
  document.getElementById('ceuLicense')?.addEventListener('change', e => {
    // In edit mode ceuStaffSelectRow is hidden and its value is stale (left
    // over from whatever the add-flow last set it to) -- lockedCeuEmployeeId
    // is the source of truth there, same as saveCeu() uses.
    const employeeId = lockedCeuEmployeeId || document.getElementById('ceuStaff').value;
    const lic = (ceuLicensesForStaff[employeeId] || []).find(l => l.id === e.target.value);
    document.getElementById('ceuCategory').value = lic ? suggestedCeuCategory(lic) : 'general_other';
  });
  document.getElementById('ceuSourceType')?.addEventListener('change', updateCeuHoursLabel);
  document.getElementById('ceuHours')?.addEventListener('input', updateCeuAmountPreview);

  document.getElementById('ceuFileChooseBtn')?.addEventListener('click', () => {
    document.getElementById('ceuFileInput')?.click();
  });
  document.getElementById('ceuFileInput')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    const label = document.getElementById('ceuFileNameLabel');
    if (label) label.textContent = file ? file.name : 'No file chosen';
  });

  const ceuDebounced = debounce(() => loadCeus(), 300);
  ['ceuSearch','ceuCategoryFilter','ceuVerifiedFilter']
    .forEach(id => document.getElementById(id)?.addEventListener('input', ceuDebounced));

  // Hash-based routing on load
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace('#', '') || 'overview';
    setView(view);
  });
}

/* ─────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────── */
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function toggleProvisionalRow(show) {
  document.getElementById('provisionalTypeRow').style.display = show ? '' : 'none';
}

function offsetDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function formatDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${m}/${day}/${y}`;
}

function formatDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
}

function statusBadge(status) {
  const map = {
    active:          'badge-active',
    expiring:        'badge-expiring',
    expired:         'badge-expired',
    pending_renewal: 'badge-pending',
    suspended:       'badge-suspended',
    revoked:         'badge-revoked',
  };
  return `<span class="badge ${map[status] ?? ''}">${status?.replace('_', ' ') ?? '—'}</span>`;
}

function renewalBadge(status) {
  if (!status || status === 'not_started') return '—';
  const cls = status === 'submitted' ? 'badge-active' : 'badge-pending';
  return `<span class="badge ${cls}">${status.replace('_', ' ')}</span>`;
}

function changeTypeBadge(type) {
  return { created: 'active', updated: 'pending', deleted: 'expired', renewed: 'active', verified: 'pending' }[type] ?? 'pending';
}

const AUDIT_FIELD_LABELS = {
  campus_id:           'Campus',
  license_id:          'License',
  license_number:      'License #',
  license_type:        'License Type',
  license_area:        'License Area',
  grade_authorization: 'Grade Authorization',
  issue_date:          'Issue Date',
  expiration_date:     'Expiration Date',
  renewal_status:      'Renewal Status',
  is_provisional:      'Provisional',
  provisional_type:    'Provisional Type',
  role_applicability:  'Roles',
  alert_muted:         'Alerts Muted',
  source_type:         'Source',
  completed_date:      'Completed Date',
};

function prettyFieldName(key) {
  return AUDIT_FIELD_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Audit log diffs store whatever raw value each field held -- readable for
// most (text, dates, enums), but campus_id/license_id are foreign keys and
// print as bare UUIDs without a lookup translation.
function formatFieldValue(key, value, licenseLabelLookup) {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'campus_id')  return campusLookup[value] ?? value;
  if (key === 'license_id') return licenseLabelLookup[value] ?? value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return value;
}

function showConfirm(title, message, okLabel = 'Delete') {
  return new Promise(resolve => {
    const modal  = document.getElementById('licConfirmModal');
    const okBtn  = document.getElementById('licConfirmOk');
    const canBtn = document.getElementById('licConfirmCancel');
    document.getElementById('licConfirmTitle').textContent = title;
    document.getElementById('licConfirmMsg').textContent   = message;
    okBtn.textContent = okLabel;
    modal.classList.add('open');

    const done = result => {
      modal.classList.remove('open');
      resolve(result);
    };

    okBtn.addEventListener('click',  () => done(true),  { once: true });
    canBtn.addEventListener('click', () => done(false), { once: true });
    modal.addEventListener('click',  e => { if (e.target === modal) done(false); }, { once: true });
  });
}

function diffObjects(oldObj, newObj) {
  const changes = {};
  const keys = ['license_number','license_type','category','license_area','grade_authorization',
    'issue_date','expiration_date','status','renewal_status','is_provisional','provisional_type',
    'campus_id','role_applicability','verified','alert_muted','notes','state'];
  keys.forEach(k => {
    const oldVal = JSON.stringify(oldObj[k] ?? null);
    const newVal = JSON.stringify(newObj[k] ?? null);
    if (oldVal !== newVal) changes[k] = { old: oldObj[k], new: newObj[k] };
  });
  return changes;
}

/* ─────────────────────────────────────────────────────
   BOOT
───────────────────────────────────────────────────── */
init();

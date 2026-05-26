
import { supabase } from './admin.supabase.js';
import { esc } from './admin.shared.js';
import { openDrawer, closeDrawer, showToast, renderPagination, PAGE_SIZE } from './admin.compliance.utils.js';

let bgCheckCache = [];
let bgPage = 1;
let activeBgId = null;
let activeBgGuardianId = null;
let _profile = null;

// ═══════════════════════════════════════════════════════════════════════
// BACKGROUND CHECKS
// ═══════════════════════════════════════════════════════════════════════

export async function loadBgChecks(profile) {
  if (profile) _profile = profile;
  const tbody = document.getElementById('bgCheckTableBody');
  if (!tbody) return;

  const searchVal    = document.getElementById('bgSearch')?.value.trim().toLowerCase();
  const statusVal    = document.getElementById('bgStatusFilter')?.value;
  const requestorVal = document.getElementById('bgRequestorFilter')?.value;
  const showArchived = document.getElementById('bgShowArchived')?.checked ?? false;

  if (!bgCheckCache.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

    const { data, error } = await supabase
      .from('compliance_bg_check_requests')
      .select(`
        id, school_id, requestor_id, subject_first_name, subject_last_name, subject_email,
        reason, volunteer_roles, status, requested_at, submitted_at, cleared_at, expires_at,
        mvr_cleared_at, mvr_expires_at, notes, admin_note, archived_at,
        requestor:profiles!requestor_id(display_name, email)
      `)
      .eq('school_id', _profile.school_id)
      .order('requested_at', { ascending: false });

    if (error) {
      tbody.innerHTML = `<tr><td colspan="9" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
      return;
    }

    bgCheckCache = data ?? [];
    populateRequestorFilter(bgCheckCache.filter(r => !r.archived_at));
    renderBgStats();
    renderExpiryAlerts();
  }

  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '<span class="muted">—</span>';

  const filtered = bgCheckCache.filter(row => {
    if (!showArchived && row.archived_at) return false;
    if (showArchived && !row.archived_at) return false;
    const name  = `${row.subject_first_name} ${row.subject_last_name}`.toLowerCase();
    const email = (row.subject_email ?? '').toLowerCase();
    if (searchVal && !name.includes(searchVal) && !email.includes(searchVal)) return false;
    if (statusVal && row.status !== statusVal) return false;
    if (requestorVal && row.requestor_id !== requestorVal) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">${showArchived ? 'No archived records.' : 'No requests match the current filters.'}</td></tr>`;
    document.getElementById('bgPagination').style.display = 'none';
    return;
  }

  const pageItems = filtered.slice((bgPage - 1) * PAGE_SIZE, bgPage * PAGE_SIZE);

  tbody.innerHTML = '';
  pageItems.forEach(row => {
    const tr = document.createElement('tr');
    if (row.archived_at) tr.style.opacity = '0.5';
    tr.innerHTML = `
      <td><strong>${esc(row.subject_first_name)} ${esc(row.subject_last_name)}</strong>${row.archived_at ? ' <span class="bg-status-pill" style="background:#f1f5f9;color:#64748b;">Archived</span>' : ''}</td>
      <td>${row.subject_email ? esc(row.subject_email) : '<span class="muted">—</span>'}</td>
      <td>${esc(row.requestor?.display_name ?? row.requestor?.email ?? '—')}</td>
      <td style="max-width:180px;white-space:normal;">${
        row.volunteer_roles?.length
          ? row.volunteer_roles.map(r => `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:10px;font-weight:700;padding:2px 7px;display:inline-block;margin:1px;">${esc(r)}</span>`).join('')
          : row.reason ? esc(row.reason) : '<span class="muted">—</span>'
      }</td>
      <td><span class="bg-status-pill bg-status-${esc(row.status)}">${esc(row.status)}</span></td>
      <td>${fmtDate(row.cleared_at)}</td>
      <td>${fmtDate(row.expires_at)}</td>
      <td>${fmtDate(row.requested_at)}</td>
      <td><button class="btn btn-sm" data-id="${esc(row.id)}">Review</button></td>
    `;
    tr.querySelector('button[data-id]').addEventListener('click', () => openBgDrawer(row.id));
    tbody.appendChild(tr);
  });

  renderPagination('bgPagination', bgPage, filtered.length, p => { bgPage = p; loadBgChecks(); });
}

export function resetBgCache() {
  bgCheckCache = [];
}

function populateRequestorFilter(rows) {
  const sel = document.getElementById('bgRequestorFilter');
  if (!sel || sel.dataset.populated) return;

  const seen = new Map();
  rows.forEach(r => {
    if (r.requestor_id && !seen.has(r.requestor_id)) {
      seen.set(r.requestor_id, r.requestor?.display_name ?? r.requestor?.email ?? r.requestor_id);
    }
  });

  [...seen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([id, name]) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
    });

  sel.dataset.populated = 'true';
}

function renderBgStats() {
  if (!bgCheckCache.length) return;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d30   = new Date(today); d30.setDate(d30.getDate() + 30);
  const d60   = new Date(today); d60.setDate(d60.getDate() + 60);

  let active = 0, exp30 = 0, exp60 = 0, expired = 0;

  bgCheckCache.forEach(row => {
    const expDate = row.expires_at ? new Date(row.expires_at + 'T12:00:00') : null;

    if (row.status === 'expired' || (expDate && expDate < today)) {
      expired++;
    } else if (row.status === 'cleared') {
      active++;
      if (expDate) {
        if (expDate <= d30)      exp30++;
        else if (expDate <= d60) exp60++;
      }
    }
  });

  const el = id => document.getElementById(id);
  el('bgStatActive').textContent  = active;
  el('bgStatExp30').textContent   = exp30;
  el('bgStatExp60').textContent   = exp60;
  el('bgStatExpired').textContent = expired;
  el('bgExpiryStats').style.display = 'flex';

  el('bgStatExp30Card').className   = 'bg-stat-card' + (exp30   > 0 ? ' bg-stat-warn'   : '');
  el('bgStatExp60Card').className   = 'bg-stat-card' + (exp60   > 0 ? ' bg-stat-warn'   : '');
  el('bgStatExpiredCard').className = 'bg-stat-card' + (expired > 0 ? ' bg-stat-danger' : '');
}

function renderExpiryAlerts() {
  const wrap = document.getElementById('bgExpiryAlertWrap');
  const list = document.getElementById('bgExpiryAlertList');
  if (!wrap || !list) return;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d30   = new Date(today); d30.setDate(d30.getDate() + 30);
  const d90   = new Date(today); d90.setDate(d90.getDate() + 90);

  const alerts = bgCheckCache
    .filter(row => {
      const expDate = row.expires_at ? new Date(row.expires_at + 'T12:00:00') : null;
      if (row.status === 'expired') return true;
      return row.status === 'cleared' && expDate && expDate <= d90;
    })
    .sort((a, b) => (a.expires_at ?? '9999').localeCompare(b.expires_at ?? '9999'));

  if (!alerts.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  list.innerHTML = '';
  alerts.forEach(row => {
    const expDate = row.expires_at ? new Date(row.expires_at + 'T12:00:00') : null;
    const isExpired = row.status === 'expired' || (expDate && expDate < today);
    const chipClass = isExpired ? 'bg-expiry-chip--expired' : (expDate <= d30 ? 'bg-expiry-chip--soon' : 'bg-expiry-chip--warn');
    const chipText  = isExpired ? 'Expired' : (expDate <= d30 ? 'Expires soon' : 'Expiring');
    const expStr    = expDate ? expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    const roleStr   = row.volunteer_roles?.join(', ') ?? '';

    const div = document.createElement('div');
    div.className = 'bg-expiry-row';
    div.innerHTML = `
      <div class="bg-expiry-name">
        <strong>${esc(row.subject_first_name)} ${esc(row.subject_last_name)}</strong>
        ${roleStr ? `<span class="bg-expiry-roles">${esc(roleStr)}</span>` : ''}
      </div>
      <div class="bg-expiry-meta">
        ${expStr ? `<span class="muted" style="font-size:12px;">${esc(expStr)}</span>` : ''}
        <span class="bg-expiry-chip ${chipClass}">${esc(chipText)}</span>
      </div>
      <button class="btn btn-sm" style="flex-shrink:0;" data-id="${esc(row.id)}">Review</button>
    `;
    div.querySelector('button[data-id]').addEventListener('click', () => openBgDrawer(row.id));
    list.appendChild(div);
  });
}

export function wireBgFilters() {
  const resetBg = () => { bgPage = 1; loadBgChecks(); };
  document.getElementById('bgStatusFilter')?.addEventListener('change', resetBg);
  document.getElementById('bgRequestorFilter')?.addEventListener('change', resetBg);
  document.getElementById('bgSearch')?.addEventListener('input', resetBg);
  document.getElementById('bgShowArchived')?.addEventListener('change', () => { bgPage = 1; bgCheckCache = []; loadBgChecks(); });
}

// ── BG Check Detail Drawer ────────────────────────────────────────────

function openBgDrawer(id) {
  const row = bgCheckCache.find(r => r.id === id);
  if (!row) return;
  activeBgId = id;

  const statusOptions = ['pending', 'submitted', 'cleared', 'expired', 'cancelled']
    .map(s => `<option value="${s}"${row.status === s ? ' selected' : ''}>${s.charAt(0).toUpperCase() + s.slice(1)}</option>`)
    .join('');

  document.getElementById('bgDrawerBody').innerHTML = `
    <div class="bg-detail-field">
      <span class="bg-detail-label">Subject</span>
      <span class="bg-detail-value">${esc(row.subject_first_name)} ${esc(row.subject_last_name)}</span>
    </div>
    ${row.subject_email ? `<div class="bg-detail-field"><span class="bg-detail-label">Email</span><span class="bg-detail-value">${esc(row.subject_email)}</span></div>` : ''}
    <div class="bg-detail-field">
      <span class="bg-detail-label">Requested by</span>
      <span class="bg-detail-value">${esc(row.requestor?.display_name ?? row.requestor?.email ?? '—')}</span>
    </div>
    <div class="bg-detail-field">
      <span class="bg-detail-label">Requested on</span>
      <span class="bg-detail-value">${new Date(row.requested_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
    </div>
    ${row.volunteer_roles?.length ? `
      <div class="bg-detail-field">
        <span class="bg-detail-label">Volunteer roles</span>
        <span class="bg-detail-value">${row.volunteer_roles.map(r => `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:11px;font-weight:700;padding:2px 8px;margin-right:4px;">${esc(r)}</span>`).join('')}</span>
      </div>
    ` : ''}
    ${row.reason ? `<div class="bg-detail-field"><span class="bg-detail-label">Notes</span><span class="bg-detail-value">${esc(row.reason)}</span></div>` : ''}
    <hr style="border:none;border-top:1px solid var(--border);margin:20px 0 16px;">
    <div class="drawer-field" style="margin-bottom:16px;">
      <label for="bgDrawerStatus">Status</label>
      <select id="bgDrawerStatus">${statusOptions}</select>
    </div>
    <div class="drawer-row-2" style="margin-bottom:16px;">
      <div class="drawer-field">
        <label for="bgDrawerClearedAt">BG cleared</label>
        <input type="date" id="bgDrawerClearedAt" value="${row.cleared_at ? row.cleared_at.slice(0, 10) : ''}">
      </div>
      <div class="drawer-field">
        <label for="bgDrawerExpiresAt">BG expires</label>
        <input type="date" id="bgDrawerExpiresAt" value="${row.expires_at ?? ''}">
      </div>
    </div>
    <div class="drawer-row-2" style="margin-bottom:16px;">
      <div class="drawer-field">
        <label for="bgDrawerMvrClearedAt">MVR cleared</label>
        <input type="date" id="bgDrawerMvrClearedAt" value="${row.mvr_cleared_at ?? ''}">
      </div>
      <div class="drawer-field">
        <label for="bgDrawerMvrExpiresAt">MVR expires</label>
        <input type="date" id="bgDrawerMvrExpiresAt" value="${row.mvr_expires_at ?? ''}">
      </div>
    </div>
    <div class="drawer-field" style="margin-bottom:8px;">
      <label for="bgDrawerAdminNote">Admin note</label>
      <textarea id="bgDrawerAdminNote" rows="3">${esc(row.admin_note ?? '')}</textarea>
    </div>
    <div id="bgDrawerMsg" style="font-size:13px;color:var(--danger);min-height:18px;margin-top:4px;"></div>
    <div id="bgGuardianSection" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);font-size:13px;"></div>
  `;

  const archiveBtn = document.getElementById('bgDrawerArchive');
  if (archiveBtn) {
    archiveBtn.textContent = row.archived_at ? 'Unarchive this record' : 'Archive this record';
    archiveBtn.dataset.recordId = row.id;
    archiveBtn.dataset.archive  = row.archived_at ? '0' : '1';
  }

  openDrawer('bg');
  if (row.subject_email) loadBgGuardianSection(row.subject_email);
}

export async function saveBgCheck() {
  if (!activeBgId) return;
  const status       = document.getElementById('bgDrawerStatus')?.value;
  const clearedAt    = document.getElementById('bgDrawerClearedAt')?.value || null;
  const expiresAt    = document.getElementById('bgDrawerExpiresAt')?.value || null;
  const mvrClearedAt = document.getElementById('bgDrawerMvrClearedAt')?.value || null;
  const mvrExpiresAt = document.getElementById('bgDrawerMvrExpiresAt')?.value || null;
  const adminNote    = document.getElementById('bgDrawerAdminNote')?.value.trim() || null;
  const msgEl        = document.getElementById('bgDrawerMsg');

  const saveBtn = document.getElementById('bgDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const update = { status, admin_note: adminNote, expires_at: expiresAt, mvr_cleared_at: mvrClearedAt, mvr_expires_at: mvrExpiresAt };
  update.cleared_at = status === 'cleared' ? (clearedAt || new Date().toISOString().slice(0, 10)) : null;

  const { error } = await supabase
    .from('compliance_bg_check_requests')
    .update(update)
    .eq('id', activeBgId)
    .eq('school_id', _profile.school_id);

  if (error) {
    saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    msgEl.textContent = `Save failed: ${esc(error.message)}`;
    return;
  }

  if (activeBgGuardianId) {
    const dlExpiresAt  = document.getElementById('bgDrawerDlExpiresAt')?.value || null;
    const insExpiresAt = document.getElementById('bgDrawerInsExpiresAt')?.value || null;
    const canChaperone = document.getElementById('bgDrawerCanChaperone')?.checked ?? true;
    const canDrive     = document.getElementById('bgDrawerCanDrive')?.checked ?? true;

    await supabase.from('guardians')
      .update({ dl_expires_at: dlExpiresAt, insurance_expires_at: insExpiresAt, can_chaperone: canChaperone, can_drive: canDrive })
      .eq('id', activeBgGuardianId)
      .eq('school_id', _profile.school_id);
  }

  saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
  closeDrawer('bg');
  showToast('Background check updated');
  bgCheckCache = [];
  await loadBgChecks();
}

export function onBgArchiveClick() {
  const btn     = document.getElementById('bgDrawerArchive');
  const id      = btn?.dataset.recordId;
  const archive = btn?.dataset.archive === '1';
  if (id) archiveBgCheck(id, archive);
}

async function archiveBgCheck(id, archive) {
  const { error } = await supabase
    .from('compliance_bg_check_requests')
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { alert('Failed: ' + error.message); return; }
  closeDrawer('bg');
  showToast(archive ? 'Record archived' : 'Record unarchived');
  bgCheckCache = [];
  bgPage = 1;
  await loadBgChecks();
}

async function loadBgGuardianSection(email) {
  const section = document.getElementById('bgGuardianSection');
  if (!section) return;
  activeBgGuardianId = null;
  section.innerHTML = '<p class="muted" style="font-size:12px;">Looking up guardian record…</p>';

  const { data: guardians } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, dl_expires_at, insurance_expires_at, can_chaperone, can_drive')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .ilike('email', email)
    .limit(1);

  const g = guardians?.[0];
  if (!g) {
    section.innerHTML = '<p class="muted" style="font-size:12px;">No guardian record found for this email.</p>';
    return;
  }
  activeBgGuardianId = g.id;

  section.innerHTML = `
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">
      Guardian: ${esc(g.first_name)} ${esc(g.last_name)}
    </div>
    <div class="drawer-row-2" style="margin-bottom:14px;">
      <div class="drawer-field">
        <label for="bgDrawerDlExpiresAt">DL expires</label>
        <input type="date" id="bgDrawerDlExpiresAt" value="${g.dl_expires_at ?? ''}">
      </div>
      <div class="drawer-field">
        <label for="bgDrawerInsExpiresAt">Insurance expires</label>
        <input type="date" id="bgDrawerInsExpiresAt" value="${g.insurance_expires_at ?? ''}">
      </div>
    </div>
    <div style="display:flex;gap:20px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;">
        <input type="checkbox" id="bgDrawerCanChaperone" ${g.can_chaperone !== false ? 'checked' : ''}> May chaperone
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;">
        <input type="checkbox" id="bgDrawerCanDrive" ${g.can_drive !== false ? 'checked' : ''}> May drive
      </label>
    </div>
  `;
}

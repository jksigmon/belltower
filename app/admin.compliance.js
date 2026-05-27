import { supabase } from './admin.supabase.js';
import { initPage } from './admin.auth.js';
import { esc } from './admin.shared.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let currentProfile = null;

const VOLUNTEER_BASE = `${window.location.origin}/volunteer.html?form=`;
const PAGE_SIZE = 25;

// ── Shared pagination renderer ────────────────────────────────────────
function renderPagination(containerId, currentPage, totalItems, onPageChange) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  const from = Math.min((currentPage - 1) * PAGE_SIZE + 1, totalItems);
  const to   = Math.min(currentPage * PAGE_SIZE, totalItems);

  const info = document.createElement('span');
  info.className = 'pagination-info';
  info.textContent = totalItems === 0
    ? 'No results'
    : totalPages <= 1
      ? `${totalItems} record${totalItems !== 1 ? 's' : ''}`
      : `${from}–${to} of ${totalItems}`;
  container.appendChild(info);
  container.style.display = '';

  if (totalPages <= 1) return;

  const controls = document.createElement('div');
  controls.className = 'pagination-controls';

  function makeBtn(label, targetPage, disabled) {
    const btn = document.createElement('button');
    btn.innerHTML = label;
    btn.className = 'pagination-btn' + (targetPage === currentPage ? ' pagination-active' : '');
    btn.disabled = disabled;
    if (!disabled && targetPage !== currentPage) btn.onclick = () => onPageChange(targetPage);
    return btn;
  }

  controls.appendChild(makeBtn('&#8249;', currentPage - 1, currentPage === 1));

  const delta = 2;
  let pages = new Set([1, totalPages]);
  for (let i = Math.max(2, currentPage - delta); i <= Math.min(totalPages - 1, currentPage + delta); i++) pages.add(i);
  pages = [...pages].sort((a, b) => a - b);

  let prev = 0;
  pages.forEach(p => {
    if (p - prev > 1) { const e = document.createElement('span'); e.className = 'pagination-ellipsis'; e.textContent = '…'; controls.appendChild(e); }
    controls.appendChild(makeBtn(p, p, false));
    prev = p;
  });

  controls.appendChild(makeBtn('&#8250;', currentPage + 1, currentPage === totalPages));
  container.appendChild(controls);
}

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  const profile = await initPage({ requiredCap: 'can_manage_compliance' });
  if (!profile) return;
  currentProfile = profile;

  wireDrawers();
  wireFilters();
  wireSettings();

  document.getElementById('signOut')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = '/login.html';
  });

  document.getElementById('sideNav')?.classList.remove('hidden');
  window.addEventListener('hashchange', () => setActive(location.hash || '#bg-checks'));

  setActive(location.hash || '#bg-checks');
}

// ── Nav routing ───────────────────────────────────────────────────────
function setActive(hash) {
  const VALID = ['#bg-checks', '#templates', '#agreements', '#settings'];
  const target = VALID.includes(hash) ? hash : '#bg-checks';

  history.replaceState(null, '', target);

  const subtitleMap = {
    '#bg-checks':  'Background Checks',
    '#templates':  'Form Templates',
    '#agreements': 'Agreements',
    '#settings':   'Settings',
  };
  const subtitle = document.getElementById('pageSubtitle');
  if (subtitle) subtitle.textContent = subtitleMap[target] ?? 'Compliance';

  document.querySelectorAll('#sideNav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === target);
  });

  document.querySelectorAll('main section').forEach(s => {
    s.style.display = 'none';
  });

  const section = document.querySelector(target);
  if (section) section.style.display = 'block';

  const key = target.slice(1);
  if (key === 'bg-checks') {
    bgCheckCache = [];
    const rSel = document.getElementById('bgRequestorFilter');
    if (rSel) { rSel.dataset.populated = ''; rSel.querySelectorAll('option:not([value=""])').forEach(o => o.remove()); }
    loadBgChecks();
  }
  if (key === 'templates')  loadTemplates();
  if (key === 'agreements') { resetAgreementCache(); loadAgreements(); }
  if (key === 'settings')   { loadSettings(); loadGrants(); }
}

// ═══════════════════════════════════════════════════════════════════════
// BACKGROUND CHECKS
// ═══════════════════════════════════════════════════════════════════════
let bgCheckCache = [];
let bgPage = 1;

async function loadBgChecks() {
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
      .eq('school_id', currentProfile.school_id)
      .order('requested_at', { ascending: false })
      .limit(1000);

    if (error) {
      tbody.innerHTML = `<tr><td colspan="9" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
      return;
    }

    bgCheckCache = data ?? [];
    if (bgCheckCache.length === 1000) {
      console.warn('BG check list hit the 1000-record cap — some records may not be shown.');
    }
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

function populateRequestorFilter(rows) {
  const sel = document.getElementById('bgRequestorFilter');
  if (!sel || sel.dataset.populated) return;

  const seen = new Map();
  rows.forEach(r => {
    if (r.requestor_id && !seen.has(r.requestor_id)) {
      seen.set(r.requestor_id, r.requestor?.display_name ?? r.requestor?.email ?? r.requestor_id);
    }
  });

  // Sort by display name
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

  el('bgStatExp30Card').className  = 'bg-stat-card' + (exp30  > 0 ? ' bg-stat-warn'   : '');
  el('bgStatExp60Card').className  = 'bg-stat-card' + (exp60  > 0 ? ' bg-stat-warn'   : '');
  el('bgStatExpiredCard').className = 'bg-stat-card' + (expired > 0 ? ' bg-stat-danger' : '');
}

function renderExpiryAlerts() {
  const wrap = document.getElementById('bgExpiryAlertWrap');
  const list = document.getElementById('bgExpiryAlertList');
  if (!wrap || !list) return;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d90   = new Date(today); d90.setDate(d90.getDate() + 90);

  const alerts = bgCheckCache
    .filter(row => {
      if (row.archived_at) return false;
      const expDate = row.expires_at ? new Date(row.expires_at + 'T12:00:00') : null;
      // Only alert on 'expired' status if expires_at hasn't been extended past today
      if (row.status === 'expired') return !expDate || expDate <= today;
      return row.status === 'cleared' && expDate && expDate <= d90;
    })
    .sort((a, b) => (a.expires_at ?? '9999').localeCompare(b.expires_at ?? '9999'));

  if (!alerts.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  list.innerHTML = '';
  alerts.forEach(row => {
    const expDate  = row.expires_at ? new Date(row.expires_at + 'T12:00:00') : null;
    const daysLeft = expDate ? Math.ceil((expDate - today) / 86_400_000) : null;

    let chipClass, chipText;
    if (daysLeft === null)      { chipClass = ''; chipText = 'No expiry set'; }
    else if (daysLeft < 0)      { chipClass = 'bg-expiry-expired'; chipText = `Expired ${Math.abs(daysLeft)}d ago`; }
    else if (daysLeft === 0)    { chipClass = 'bg-expiry-expired'; chipText = 'Expires today'; }
    else if (daysLeft <= 30)    { chipClass = 'bg-expiry-urgent';  chipText = `${daysLeft}d left`; }
    else if (daysLeft <= 60)    { chipClass = 'bg-expiry-warn';    chipText = `${daysLeft}d left`; }
    else                        { chipClass = 'bg-expiry-soon';    chipText = `${daysLeft}d left`; }

    const roleStr = row.volunteer_roles?.length
      ? row.volunteer_roles.join(', ')
      : (row.reason ?? '');

    const expStr = expDate
      ? expDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

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

function wireFilters() {
  const resetBg = () => { bgPage = 1; loadBgChecks(); };
  document.getElementById('bgStatusFilter')?.addEventListener('change', resetBg);
  document.getElementById('bgRequestorFilter')?.addEventListener('change', resetBg);
  document.getElementById('bgSearch')?.addEventListener('input', resetBg);
  document.getElementById('bgShowArchived')?.addEventListener('change', () => { bgPage = 1; bgCheckCache = []; loadBgChecks(); });

  const resetAgr = () => { agrPage = 1; resetAgreementCache(); loadAgreements(); };
  document.getElementById('agreementSearch')?.addEventListener('input', resetAgr);
  document.getElementById('agreementTemplateFilter')?.addEventListener('change', resetAgr);
  document.getElementById('agreementLinkFilter')?.addEventListener('change', resetAgr);
  document.getElementById('agrShowArchived')?.addEventListener('change', resetAgr);
}

function renderBgChecks() {
  loadBgChecks();
}

// BG Check Detail Drawer
let activeBgId = null;
let activeBgGuardianId = null;

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

async function saveBgCheck() {
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
    .eq('school_id', currentProfile.school_id);

  if (error) {
    saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    msgEl.textContent = `Save failed: ${esc(error.message)}`;
    return;
  }

  // Save guardian clearance fields if a guardian was found for this email
  if (activeBgGuardianId) {
    const dlExpiresAt  = document.getElementById('bgDrawerDlExpiresAt')?.value || null;
    const insExpiresAt = document.getElementById('bgDrawerInsExpiresAt')?.value || null;
    const canChaperone = document.getElementById('bgDrawerCanChaperone')?.checked ?? true;
    const canDrive     = document.getElementById('bgDrawerCanDrive')?.checked ?? true;

    await supabase.from('guardians')
      .update({ dl_expires_at: dlExpiresAt, insurance_expires_at: insExpiresAt, can_chaperone: canChaperone, can_drive: canDrive })
      .eq('id', activeBgGuardianId)
      .eq('school_id', currentProfile.school_id);
  }

  saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
  closeDrawer('bg');
  showToast('Background check updated');
  bgCheckCache = [];
  await loadBgChecks();
}

function onBgArchiveClick() {
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
    .eq('school_id', currentProfile.school_id);
  if (error) { alert('Failed: ' + error.message); return; }
  closeDrawer('bg');
  showToast(archive ? 'Record archived' : 'Record unarchived');
  bgCheckCache = [];
  bgPage = 1;
  await loadBgChecks();
}

async function archiveAgreement(id, archive) {
  const { error } = await supabase
    .from('compliance_agreements')
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('school_id', currentProfile.school_id);
  if (error) { alert('Failed: ' + error.message); return; }
  showToast(archive ? 'Agreement archived' : 'Agreement unarchived');
  resetAgreementCache();
  await loadAgreements();
}

async function loadBgGuardianSection(email) {
  const section = document.getElementById('bgGuardianSection');
  if (!section) return;
  activeBgGuardianId = null;
  section.innerHTML = '<p class="muted" style="font-size:12px;">Looking up guardian record…</p>';

  const { data: guardians } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, dl_expires_at, insurance_expires_at, can_chaperone, can_drive')
    .eq('school_id', currentProfile.school_id)
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

// ═══════════════════════════════════════════════════════════════════════
// FORM TEMPLATES
// ═══════════════════════════════════════════════════════════════════════
let templateCache = [];
let activeTemplateId = null;
let templateLinks = {};

async function loadTemplates() {
  const container = document.getElementById('templateListWrap');
  if (!container) return;
  container.innerHTML = '<p class="muted" style="padding:20px 0;">Loading…</p>';

  const { data, error } = await supabase
    .from('compliance_form_templates')
    .select('id, title, description, body_html, active, required_for_chaperones, content_hash, created_at')
    .eq('school_id', currentProfile.school_id)
    .order('created_at', { ascending: false });

  if (error) {
    container.innerHTML = `<p class="status-danger">Failed to load: ${esc(error.message)}</p>`;
    return;
  }

  templateCache = data ?? [];

  if (!templateCache.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px 0;">
        <p class="muted">No form templates yet.</p>
        <button class="btn btn-primary" id="newTemplateBtn2" style="margin-top:12px;">Create your first template</button>
      </div>`;
    document.getElementById('newTemplateBtn2')?.addEventListener('click', () => openTemplateDrawer(null));
    return;
  }

  container.innerHTML = templateCache.map(t => `
    <div class="template-card" data-id="${esc(t.id)}">
      <div class="template-card-header">
        <strong>${esc(t.title)}</strong>
        <span class="badge ${t.active ? 'badge-active' : 'badge-suspended'}">${t.active ? 'Active' : 'Inactive'}</span>
        ${t.required_for_chaperones ? `<span class="badge" style="background:#eff6ff;color:#1d4ed8;">Field trips</span>` : ''}
      </div>
      ${t.description ? `<p class="muted" style="font-size:13px;margin:4px 0 0;">${esc(t.description)}</p>` : ''}
      <div class="template-card-actions">
        <button class="btn" data-action="edit" data-id="${esc(t.id)}" style="font-size:12px;padding:4px 12px;">Edit template</button>
        <button class="btn" data-action="links" data-id="${esc(t.id)}" style="font-size:12px;padding:4px 12px;">Manage links</button>
      </div>
      <div class="template-links-wrap" id="links-${esc(t.id)}" style="display:none;"></div>
    </div>
  `).join('');

  container.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => openTemplateDrawer(btn.dataset.id));
  });
  container.querySelectorAll('[data-action="links"]').forEach(btn => {
    btn.addEventListener('click', () => toggleTemplateLinks(btn.dataset.id));
  });
}

function openTemplateDrawer(id) {
  activeTemplateId = id;
  const t = id ? templateCache.find(x => x.id === id) : null;

  document.getElementById('tplDrawerTitle').textContent = t ? 'Edit Template' : 'New Template';
  document.getElementById('tplTitle').value       = t?.title ?? '';
  document.getElementById('tplDescription').value = t?.description ?? '';
  document.getElementById('tplBodyHtml').value    = t?.body_html ?? '';
  document.getElementById('tplActive').checked                  = t ? t.active : true;
  document.getElementById('tplRequiredForChaperones').checked   = t?.required_for_chaperones ?? false;
  document.getElementById('tplDrawerMsg').textContent = '';

  if (id) {
    document.getElementById('tplDeleteWrap').style.display = '';
  } else {
    document.getElementById('tplDeleteWrap').style.display = 'none';
  }

  openDrawer('tpl');
}

async function saveTemplate() {
  const title       = document.getElementById('tplTitle').value.trim();
  const description = document.getElementById('tplDescription').value.trim() || null;
  const bodyHtml    = document.getElementById('tplBodyHtml').value;
  const active      = document.getElementById('tplActive').checked;
  const msgEl       = document.getElementById('tplDrawerMsg');

  if (!title) { msgEl.textContent = 'Title is required.'; return; }

  const saveBtn = document.getElementById('tplDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  // Compute content hash for audit pinning
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-256', encoder.encode(bodyHtml));
  const contentHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  const requiredForChaperones = document.getElementById('tplRequiredForChaperones').checked;
  const payload = { title, description, body_html: bodyHtml, active, required_for_chaperones: requiredForChaperones, content_hash: contentHash };

  let error;
  if (activeTemplateId) {
    ({ error } = await supabase
      .from('compliance_form_templates')
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq('id', activeTemplateId)
      .eq('school_id', currentProfile.school_id));
  } else {
    ({ error } = await supabase
      .from('compliance_form_templates')
      .insert({ ...payload, school_id: currentProfile.school_id, created_by: currentProfile.id }));
  }

  saveBtn.disabled = false; saveBtn.textContent = 'Save Template';

  if (error) { msgEl.textContent = `Save failed: ${esc(error.message)}`; return; }

  closeDrawer('tpl');
  showToast(activeTemplateId ? 'Template updated' : 'Template created');
  await loadTemplates();
}

async function deleteTemplate() {
  if (!activeTemplateId) return;
  if (!confirm('Delete this template? Any existing form links and agreements will remain in the database, but the template will no longer be usable.')) return;

  const { error } = await supabase
    .from('compliance_form_templates')
    .update({ active: false })
    .eq('id', activeTemplateId)
    .eq('school_id', currentProfile.school_id);

  if (error) { alert(`Failed: ${error.message}`); return; }

  closeDrawer('tpl');
  showToast('Template deactivated');
  await loadTemplates();
}

// Template links panel
async function toggleTemplateLinks(templateId) {
  const wrap = document.getElementById(`links-${templateId}`);
  if (!wrap) return;

  if (wrap.style.display !== 'none') {
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = '';
  wrap.innerHTML = '<p class="muted" style="font-size:13px;padding:8px 0;">Loading links…</p>';

  const { data, error } = await supabase
    .from('compliance_form_links')
    .select('id, token, label, expires_at, active, created_at')
    .eq('template_id', templateId)
    .order('created_at', { ascending: false });

  if (error) {
    wrap.innerHTML = `<p class="status-danger" style="font-size:13px;">Failed: ${esc(error.message)}</p>`;
    return;
  }

  templateLinks[templateId] = data ?? [];

  wrap.innerHTML = `
    <div style="padding:12px 0 4px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <strong style="font-size:13px;">Form Links</strong>
        <button class="btn btn-primary btn-sm" data-action="new-link" data-tid="${esc(templateId)}">+ New link</button>
      </div>
      ${!data?.length ? '<p class="muted" style="font-size:13px;">No links yet. Create one to start sharing the form.</p>' :
        data.map(link => `
          <div class="link-row" data-lid="${esc(link.id)}">
            <div style="flex:1;min-width:0;">
              <span style="font-size:13px;font-weight:600;">${esc(link.label || 'Untitled link')}</span>
              <span class="badge ${link.active ? 'badge-active' : 'badge-suspended'}" style="margin-left:6px;">${link.active ? 'Active' : 'Inactive'}</span>
              ${link.expires_at ? `<span class="muted" style="font-size:11px;margin-left:6px;">Expires ${link.expires_at}</span>` : ''}
            </div>
            <button class="btn btn-sm" data-action="copy-link" data-token="${esc(link.token)}">Copy URL</button>
            <button class="btn btn-sm" data-action="deactivate-link" data-lid="${esc(link.id)}" data-active="${link.active}">${link.active ? 'Deactivate' : 'Activate'}</button>
          </div>
        `).join('')
      }
    </div>
  `;

  wrap.querySelector('[data-action="new-link"]')?.addEventListener('click', () => openNewLinkDrawer(templateId));

  wrap.querySelectorAll('[data-action="copy-link"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = `${VOLUNTEER_BASE}${btn.dataset.token}`;
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy URL'; }, 2000);
      });
    });
  });

  wrap.querySelectorAll('[data-action="deactivate-link"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const newActive = btn.dataset.active === 'true' ? false : true;
      const { error } = await supabase
        .from('compliance_form_links')
        .update({ active: newActive })
        .eq('id', btn.dataset.lid);
      if (error) { alert(error.message); return; }
      wrap.style.display = 'none'; // force closed so next call reopens with fresh data
      await toggleTemplateLinks(templateId);
    });
  });
}

let activeLinkTemplateId = null;

function openNewLinkDrawer(templateId) {
  activeLinkTemplateId = templateId;
  document.getElementById('linkLabel').value     = '';
  document.getElementById('linkExpiresAt').value = '';
  document.getElementById('linkDrawerMsg').textContent = '';
  openDrawer('link');
}

async function createLink() {
  const label     = document.getElementById('linkLabel').value.trim() || null;
  const expiresAt = document.getElementById('linkExpiresAt').value || null;
  const msgEl     = document.getElementById('linkDrawerMsg');

  const saveBtn = document.getElementById('linkDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Creating…';

  // Generate a cryptographically random 32-char token
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);

  const { error } = await supabase
    .from('compliance_form_links')
    .insert({
      school_id:   currentProfile.school_id,
      template_id: activeLinkTemplateId,
      token,
      label,
      expires_at:  expiresAt || null,
      active:      true,
      created_by:  currentProfile.id,
    });

  saveBtn.disabled = false; saveBtn.textContent = 'Create Link';

  if (error) { msgEl.textContent = `Failed: ${esc(error.message)}`; return; }

  const url = `${VOLUNTEER_BASE}${token}`;
  closeDrawer('link');
  showToast('Link created');

  // Auto-copy the new URL
  navigator.clipboard.writeText(url).then(() => showToast(`URL copied: ${url}`)).catch(() => {});

  await toggleTemplateLinks(activeLinkTemplateId);
}

// ═══════════════════════════════════════════════════════════════════════
// AGREEMENTS
// ═══════════════════════════════════════════════════════════════════════
let agreementCache = [];
let agrPage = 1;
let agreementSearchTimer = null;
let lastAgreementTemplateFilter = null;
let lastAgreementLinkFilter = null;

function resetAgreementCache() {
  agreementCache = [];
  agrPage = 1;
  lastAgreementTemplateFilter = null;
  lastAgreementLinkFilter = null;
}

async function loadAgreements() {
  const tbody = document.getElementById('agreementTableBody');
  if (!tbody) return;

  const searchVal    = document.getElementById('agreementSearch')?.value.trim().toLowerCase();
  const templateVal  = document.getElementById('agreementTemplateFilter')?.value ?? '';
  const linkVal      = document.getElementById('agreementLinkFilter')?.value ?? '';
  const showArchived = document.getElementById('agrShowArchived')?.checked ?? false;

  // Only hit the DB when server-side filters changed or cache is empty
  const filtersChanged = templateVal !== lastAgreementTemplateFilter || linkVal !== lastAgreementLinkFilter;

  if (!agreementCache.length || filtersChanged) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

    let query = supabase
      .from('compliance_agreements')
      .select(`
        id, signer_name, signer_email, signature_type, signed_at, expires_at, voided_at, content_hash,
        guardian_id, family_id, link_status, student_name_hint, carline_tag_hint, submitted_phone, submitted_relationship,
        submitted_data_reviewed, archived_at,
        compliance_form_templates!inner ( id, title )
      `)
      .eq('school_id', currentProfile.school_id)
      .order('signed_at', { ascending: false })
      .limit(1000);

    if (templateVal) query = query.eq('template_id', templateVal);
    if (linkVal)     query = query.eq('link_status', linkVal);

    const { data, error } = await query;
    if (error) {
      tbody.innerHTML = `<tr><td colspan="9" class="status-danger" style="text-align:center;padding:32px 0;">Failed: ${esc(error.message)}</td></tr>`;
      return;
    }

    agreementCache = data ?? [];
    if (agreementCache.length === 1000) {
      console.warn('Agreements list hit the 1000-record cap — some records may not be shown.');
    }
    lastAgreementTemplateFilter = templateVal;
    lastAgreementLinkFilter = linkVal;
  }

  const filtered = agreementCache.filter(row => {
    if (!showArchived && row.archived_at) return false;
    if (showArchived && !row.archived_at) return false;
    if (searchVal && !row.signer_name.toLowerCase().includes(searchVal) && !row.signer_email.toLowerCase().includes(searchVal)) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">${showArchived ? 'No archived agreements.' : 'No agreements found.'}</td></tr>`;
    document.getElementById('agrPagination').style.display = 'none';
    return;
  }

  populateTemplateFilter(agreementCache.filter(r => !r.archived_at));

  const pageItems = filtered.slice((agrPage - 1) * PAGE_SIZE, agrPage * PAGE_SIZE);

  tbody.innerHTML = '';
  pageItems.forEach(row => {
    const template  = row.compliance_form_templates;
    const today     = new Date().toISOString().slice(0, 10);
    const isVoided  = !!row.voided_at;
    const isExpired = row.expires_at && row.expires_at < today && !isVoided;

    const statusBadge = isVoided
      ? '<span class="badge badge-revoked">Voided</span>'
      : isExpired
        ? '<span class="badge badge-expired">Expired</span>'
        : '<span class="badge badge-active">Valid</span>';

    const linkBadge = row.link_status === 'auto_linked'
      ? '<span class="badge" style="background:#eff6ff;color:#1d4ed8;">Linked</span>'
      : row.link_status === 'manual_linked'
        ? '<span class="badge" style="background:#f0fdf4;color:#15803d;">Linked</span>'
        : '<span class="badge" style="background:#fef3c7;color:#92400e;">Unresolved</span>';

    const tr = document.createElement('tr');
    if (row.archived_at) tr.style.opacity = '0.5';
    const fmtAgrDate = d => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '<span class="muted">—</span>';
    const hasUnreviewedData = (row.submitted_phone || row.submitted_relationship) && !row.submitted_data_reviewed;
    const dataBadge = hasUnreviewedData
      ? '<span class="badge" style="background:#fef3c7;color:#92400e;cursor:pointer;" title="Unreviewed submitted data">Review</span>'
      : row.submitted_data_reviewed
        ? '<span class="badge" style="background:#f1f5f9;color:#64748b;">Reviewed</span>'
        : '<span class="muted">—</span>';

    tr.innerHTML = `
      <td>${esc(row.signer_name)}${row.archived_at ? ' <span class="bg-status-pill" style="background:#f1f5f9;color:#64748b;">Archived</span>' : ''}</td>
      <td>${esc(row.signer_email)}</td>
      <td>${esc(template?.title ?? '—')}</td>
      <td>${fmtAgrDate(row.signed_at)}</td>
      <td>${fmtAgrDate(row.expires_at)}</td>
      <td>${statusBadge}</td>
      <td>${linkBadge}</td>
      <td data-action="${hasUnreviewedData ? 'review-data' : ''}" data-id="${esc(row.id)}" style="cursor:${hasUnreviewedData ? 'pointer' : 'default'}">${dataBadge}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm" data-action="pdf" data-id="${esc(row.id)}">PDF</button>
        ${row.link_status === 'unresolved' && !row.archived_at ? `<button class="btn btn-sm" data-action="link-guardian" data-id="${esc(row.id)}" style="margin-left:4px;">Link</button>` : ''}
        ${!isVoided && !row.archived_at ? `<button class="btn btn-sm" data-action="void" data-id="${esc(row.id)}" style="margin-left:4px;color:var(--danger);">Void</button>` : ''}
        <button class="btn btn-sm" data-action="archive" data-id="${esc(row.id)}" style="margin-left:4px;color:var(--text-muted,#9ca3af);font-size:11px;">${row.archived_at ? 'Unarchive' : 'Archive'}</button>
      </td>
    `;

    tr.querySelector('[data-action="pdf"]').addEventListener('click', () => downloadAgreementPdf(row.id));
    tr.querySelector('[data-action="link-guardian"]')?.addEventListener('click', () => openLinkGuardianDrawer(row.id));
    tr.querySelector('[data-action="void"]')?.addEventListener('click', () => voidAgreement(row.id));
    tr.querySelector('[data-action="archive"]').addEventListener('click', () => archiveAgreement(row.id, !row.archived_at));
    if (hasUnreviewedData) {
      tr.querySelector('[data-action="review-data"]')?.addEventListener('click', () => openReviewDataDrawer(row.id));
    }

    tbody.appendChild(tr);
  });

  renderPagination('agrPagination', agrPage, filtered.length, p => { agrPage = p; loadAgreements(); });
}

function populateTemplateFilter(agreements) {
  const sel = document.getElementById('agreementTemplateFilter');
  if (!sel || sel.dataset.populated) return;

  const seen = new Map();
  agreements.forEach(a => {
    const t = a.compliance_form_templates;
    if (t && !seen.has(t.id)) seen.set(t.id, t.title);
  });

  seen.forEach((title, id) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = title;
    sel.appendChild(opt);
  });
  sel.dataset.populated = 'true';
}

async function downloadAgreementPdf(agreementId) {
  const btn = document.querySelector(`[data-action="pdf"][data-id="${agreementId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    const { data: { session } } = await supabase.auth.getSession();

    const res = await fetch(`${SUPABASE_URL}/functions/v1/compliance_form_pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ agreement_id: agreementId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }));
      alert(`PDF generation failed: ${err.error}`);
      return;
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    const row = agreementCache.find(r => r.id === agreementId);
    a.download = row
      ? `${row.signer_name.replace(/\s+/g, '_')}_${row.signed_at.slice(0, 10)}.pdf`
      : `agreement_${agreementId}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'PDF'; }
  }
}

async function voidAgreement(agreementId) {
  if (!confirm('Void this agreement? This cannot be undone. The signature record will remain for audit purposes.')) return;

  const { error } = await supabase
    .from('compliance_agreements')
    .update({ voided_at: new Date().toISOString(), voided_by: currentProfile.id })
    .eq('id', agreementId)
    .eq('school_id', currentProfile.school_id);

  if (error) { alert(`Failed: ${error.message}`); return; }
  showToast('Agreement voided');
  resetAgreementCache();
  await loadAgreements();
}

// ═══════════════════════════════════════════════════════════════════════
// MANUAL GUARDIAN LINK DRAWER
// ═══════════════════════════════════════════════════════════════════════
let activeLinkAgreementId  = null;
let selectedGuardianForLink = null;
let guardianSearchTimer    = null;

function openLinkGuardianDrawer(agreementId) {
  const row = agreementCache.find(r => r.id === agreementId);
  if (!row) return;
  activeLinkAgreementId  = agreementId;
  selectedGuardianForLink = null;

  // Agreement info panel
  document.getElementById('linkGuardianAgreementInfo').innerHTML = `
    <strong>${esc(row.signer_name)}</strong> &mdash; ${esc(row.signer_email)}<br>
    <span style="color:var(--text-muted);">Signed ${new Date(row.signed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
  `;

  // Submitted hints panel
  const hintsEl = document.getElementById('linkGuardianHints');
  const hints = [
    row.student_name_hint    && `Student: <strong>${esc(row.student_name_hint)}</strong>`,
    row.carline_tag_hint     && `Car tag: <strong>${esc(row.carline_tag_hint)}</strong>`,
    row.submitted_phone      && `Phone: <strong>${esc(row.submitted_phone)}</strong>`,
    row.submitted_relationship && `Relationship: <strong>${esc(row.submitted_relationship)}</strong>`,
  ].filter(Boolean);

  if (hints.length) {
    hintsEl.innerHTML = `<span style="font-weight:600;color:#92400e;">Submitted by signer:</span> ${hints.join(' &nbsp;·&nbsp; ')}`;
    hintsEl.style.display = '';
  } else {
    hintsEl.style.display = 'none';
  }

  // Reset search
  document.getElementById('linkGuardianSearch').value = '';
  document.getElementById('linkGuardianResults').innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search guardians.</div>';
  document.getElementById('linkGuardianMsg').textContent = '';
  document.getElementById('linkGuardianSave').disabled = true;

  openDrawer('linkGuardian');
}

function onGuardianSearchInput() {
  clearTimeout(guardianSearchTimer);
  guardianSearchTimer = setTimeout(searchGuardians, 280);
}

async function searchGuardians() {
  const term = document.getElementById('linkGuardianSearch')?.value.trim();
  const resultsEl = document.getElementById('linkGuardianResults');

  if (!term || term.length < 2) {
    resultsEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search guardians.</div>';
    return;
  }

  resultsEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">Searching…</div>';

  // Search by first+last name or email (ilike for case-insensitive)
  const { data, error } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, email, phone, family_id, families!inner(family_name, carline_tag_number)')
    .eq('school_id', currentProfile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(20);

  if (error) {
    resultsEl.innerHTML = `<div style="padding:16px;color:var(--danger);font-size:13px;">Search failed: ${esc(error.message)}</div>`;
    return;
  }

  if (!data?.length) {
    resultsEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">No guardians found.</div>';
    return;
  }

  resultsEl.innerHTML = '';
  data.forEach(g => {
    const family = g.families;
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.12s;';
    div.innerHTML = `
      <div>
        <div style="font-size:14px;font-weight:600;">${esc(g.first_name)} ${esc(g.last_name)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(g.email ?? '—')}${family ? ` &nbsp;·&nbsp; ${esc(family.family_name)} (tag: ${esc(family.carline_tag_number)})` : ''}</div>
      </div>
      <button class="btn btn-sm" data-gid="${esc(g.id)}" data-gname="${esc(g.first_name + ' ' + g.last_name)}" data-fid="${esc(g.family_id ?? '')}">Select</button>
    `;
    div.querySelector('button').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      selectGuardianForLink(btn.dataset.gid, btn.dataset.gname, btn.dataset.fid);
    });
    div.addEventListener('mouseenter', () => { div.style.background = '#f8fafc'; });
    div.addEventListener('mouseleave', () => { div.style.background = ''; });
    resultsEl.appendChild(div);
  });
}

function selectGuardianForLink(guardianId, guardianName, familyId) {
  selectedGuardianForLink = { guardianId, familyId: familyId || null };

  // Highlight selection in results
  document.querySelectorAll('#linkGuardianResults button[data-gid]').forEach(btn => {
    btn.textContent = btn.dataset.gid === guardianId ? '✓ Selected' : 'Select';
    btn.style.background = btn.dataset.gid === guardianId ? 'var(--primary)' : '';
    btn.style.color = btn.dataset.gid === guardianId ? '#fff' : '';
    btn.style.borderColor = btn.dataset.gid === guardianId ? 'var(--primary)' : '';
  });

  document.getElementById('linkGuardianMsg').textContent = `Selected: ${guardianName}`;
  document.getElementById('linkGuardianMsg').style.color = 'var(--success)';
  document.getElementById('linkGuardianSave').disabled = false;
}

async function saveLinkGuardian() {
  if (!activeLinkAgreementId || !selectedGuardianForLink) return;

  const saveBtn = document.getElementById('linkGuardianSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('compliance_agreements')
    .update({
      guardian_id:  selectedGuardianForLink.guardianId,
      family_id:    selectedGuardianForLink.familyId,
      link_status:  'manual_linked',
    })
    .eq('id', activeLinkAgreementId)
    .eq('school_id', currentProfile.school_id);

  saveBtn.disabled = false; saveBtn.textContent = 'Save Link';

  if (error) {
    document.getElementById('linkGuardianMsg').textContent = `Failed: ${esc(error.message)}`;
    document.getElementById('linkGuardianMsg').style.color = 'var(--danger)';
    return;
  }

  closeDrawer('linkGuardian');
  showToast('Guardian linked successfully');
  resetAgreementCache();
  await loadAgreements();
}

// ═══════════════════════════════════════════════════════════════════════
// SETTINGS — School Logo
// ═══════════════════════════════════════════════════════════════════════
async function loadSettings() {
  const preview = document.getElementById('logoPreview');
  const removeBtn = document.getElementById('logoRemoveBtn');
  if (!preview) return;

  const { data: school } = await supabase
    .from('schools')
    .select('logo_url')
    .eq('id', currentProfile.school_id)
    .single();

  if (school?.logo_url) {
    preview.src = school.logo_url;
    preview.style.display = 'block';
    if (removeBtn) removeBtn.style.display = '';
  } else {
    preview.style.display = 'none';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function wireSettings() {
  document.getElementById('logoUploadInput')?.addEventListener('change', uploadLogo);
  document.getElementById('logoRemoveBtn')?.addEventListener('click', removeLogo);
}

async function uploadLogo(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
  if (!allowed.includes(file.type)) {
    document.getElementById('logoUploadMsg').textContent = 'Please upload a PNG, JPG, WebP, or SVG image.';
    return;
  }

  const msgEl = document.getElementById('logoUploadMsg');
  msgEl.textContent = 'Uploading…';

  const ext  = file.name.split('.').pop();
  const path = `${currentProfile.school_id}/logo.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from('school-assets')
    .upload(path, file, { upsert: true, contentType: file.type });

  if (uploadErr) {
    msgEl.textContent = `Upload failed: ${uploadErr.message}`;
    return;
  }

  const { data: { publicUrl } } = supabase.storage.from('school-assets').getPublicUrl(path);

  const { error: updateErr } = await supabase
    .from('schools')
    .update({ logo_url: publicUrl })
    .eq('id', currentProfile.school_id);

  if (updateErr) {
    msgEl.textContent = `Saved file but failed to update school record: ${updateErr.message}`;
    return;
  }

  msgEl.textContent = '';
  showToast('Logo uploaded successfully');
  await loadSettings();
  e.target.value = '';
}

async function removeLogo() {
  if (!confirm('Remove the school logo?')) return;

  await supabase.from('schools').update({ logo_url: null }).eq('id', currentProfile.school_id);
  document.getElementById('logoPreview').style.display = 'none';
  document.getElementById('logoRemoveBtn').style.display = 'none';
  showToast('Logo removed');
}

// ═══════════════════════════════════════════════════════════════════════
// DRAWER SYSTEM
// ═══════════════════════════════════════════════════════════════════════
const DRAWERS = {
  bg:           { overlay: 'bgDrawerOverlay',       drawer: 'bgDrawer',           save: 'bgDrawerSave',       close: ['bgDrawerClose', 'bgDrawerCancel'] },
  tpl:          { overlay: 'tplDrawerOverlay',       drawer: 'tplDrawer',          save: 'tplDrawerSave',      close: ['tplDrawerClose', 'tplDrawerCancel'] },
  link:         { overlay: 'linkDrawerOverlay',      drawer: 'linkDrawer',         save: 'linkDrawerSave',     close: ['linkDrawerClose', 'linkDrawerCancel'] },
  linkGuardian: { overlay: 'linkGuardianOverlay',    drawer: 'linkGuardianDrawer', save: 'linkGuardianSave',   close: ['linkGuardianClose', 'linkGuardianCancel'] },
  grant:        { overlay: 'grantDrawerOverlay',     drawer: 'grantDrawer',        save: 'grantDrawerSave',    close: ['grantDrawerClose', 'grantDrawerCancel'] },
  reviewData:   { overlay: 'reviewDataOverlay',      drawer: 'reviewDataDrawer',   save: null,                 close: ['reviewDataClose'] },
};

function wireDrawers() {
  Object.entries(DRAWERS).forEach(([key, cfg]) => {
    document.getElementById(cfg.overlay)?.addEventListener('click', () => closeDrawer(key));
    cfg.close.forEach(id => document.getElementById(id)?.addEventListener('click', () => closeDrawer(key)));
  });

  document.getElementById('bgDrawerSave')?.addEventListener('click',      saveBgCheck);
  document.getElementById('bgDrawerArchive')?.addEventListener('click',   onBgArchiveClick);
  document.getElementById('tplDrawerSave')?.addEventListener('click',     saveTemplate);
  document.getElementById('tplDrawerDelete')?.addEventListener('click',   deleteTemplate);
  document.getElementById('linkDrawerSave')?.addEventListener('click',    createLink);
  document.getElementById('linkGuardianSave')?.addEventListener('click',  saveLinkGuardian);
  document.getElementById('newTemplateBtn')?.addEventListener('click',    () => openTemplateDrawer(null));
  document.getElementById('linkGuardianSearch')?.addEventListener('input', onGuardianSearchInput);

  // Phase B: grants
  document.getElementById('newGrantBtn')?.addEventListener('click',       openGrantDrawer);
  document.getElementById('grantDrawerSave')?.addEventListener('click',   saveGrant);
  document.getElementById('grantStaffSearch')?.addEventListener('input',  onGrantStaffSearchInput);

  // Phase C: review submitted data
  document.getElementById('reviewDataApply')?.addEventListener('click',   applySubmittedData);
  document.getElementById('reviewDataDismiss')?.addEventListener('click', dismissSubmittedData);
}

function openDrawer(key) {
  const { overlay, drawer } = DRAWERS[key];
  const ol = document.getElementById(overlay);
  const dr = document.getElementById(drawer);
  ol.style.display = ''; dr.style.display = '';
  ol.removeAttribute('aria-hidden');
  requestAnimationFrame(() => { ol.classList.add('open'); dr.classList.add('open'); });
  dr.querySelector('input, select, textarea, button')?.focus();
}

function closeDrawer(key) {
  const { overlay, drawer } = DRAWERS[key];
  const ol = document.getElementById(overlay);
  const dr = document.getElementById(drawer);
  ol.classList.remove('open'); dr.classList.remove('open');
  ol.setAttribute('aria-hidden', 'true');
  setTimeout(() => { ol.style.display = 'none'; dr.style.display = 'none'; }, 250);
  if (key === 'bg')           { activeBgId = null; activeBgGuardianId = null; }
  if (key === 'tpl')          activeTemplateId = null;
  if (key === 'link')         activeLinkTemplateId = null;
  if (key === 'linkGuardian') { activeLinkAgreementId = null; selectedGuardianForLink = null; }
  if (key === 'grant')        { selectedGranteeProfile = null; }
  if (key === 'reviewData')   { activeReviewAgreementId = null; }
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE B — COMPLIANCE REPORT GRANTS
// ═══════════════════════════════════════════════════════════════════════
let grantCache = [];
let selectedGranteeProfile = null;
let grantStaffSearchTimer  = null;
let grantTeacherCache      = [];

async function loadGrants() {
  const tbody = document.getElementById('grantTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:24px 0;">Loading…</td></tr>';

  const { data, error } = await supabase
    .from('compliance_report_grants')
    .select(`
      id,
      grantee:profiles!grantee_id ( id, display_name, email ),
      teacher:employees!teacher_id ( id, first_name, last_name ),
      grantor:profiles!granted_by  ( display_name, email ),
      granted_at
    `)
    .eq('school_id', currentProfile.school_id)
    .order('granted_at', { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="status-danger" style="text-align:center;padding:24px 0;">Failed: ${esc(error.message)}</td></tr>`;
    return;
  }

  grantCache = data ?? [];

  if (!grantCache.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted" style="text-align:center;padding:24px 0;">No grants yet.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  grantCache.forEach(row => {
    const tr = document.createElement('tr');
    const grantee  = row.grantee;
    const teacher  = row.teacher;
    const grantor  = row.grantor;
    tr.innerHTML = `
      <td>${esc(grantee?.display_name ?? grantee?.email ?? '—')}</td>
      <td>${teacher ? `${esc(teacher.first_name)} ${esc(teacher.last_name)}` : '<span class="muted">—</span>'}</td>
      <td>${esc(grantor?.display_name ?? grantor?.email ?? '—')}</td>
      <td><button class="btn btn-sm" data-id="${esc(row.id)}" style="color:var(--danger);">Revoke</button></td>
    `;
    tr.querySelector('button[data-id]').addEventListener('click', () => revokeGrant(row.id));
    tbody.appendChild(tr);
  });
}

async function revokeGrant(grantId) {
  if (!confirm('Revoke this access grant?')) return;
  const { error } = await supabase
    .from('compliance_report_grants')
    .delete()
    .eq('id', grantId)
    .eq('school_id', currentProfile.school_id);
  if (error) { alert(`Failed: ${error.message}`); return; }
  showToast('Grant revoked');
  await loadGrants();
}

async function openGrantDrawer() {
  selectedGranteeProfile = null;

  document.getElementById('grantStaffSearch').value = '';
  document.getElementById('grantStaffResults').innerHTML =
    '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search.</div>';
  document.getElementById('grantDrawerMsg').textContent = '';
  document.getElementById('grantDrawerSave').disabled = true;

  // Load teachers for select
  if (!grantTeacherCache.length) {
    const { data } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('school_id', currentProfile.school_id)
      .eq('active', true)
      .order('last_name');
    grantTeacherCache = data ?? [];
  }

  const sel = document.getElementById('grantTeacherSelect');
  sel.innerHTML = '<option value="">Select a teacher…</option>';
  grantTeacherCache.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = `${t.last_name}, ${t.first_name}`;
    sel.appendChild(opt);
  });

  openDrawer('grant');
}

function onGrantStaffSearchInput() {
  clearTimeout(grantStaffSearchTimer);
  grantStaffSearchTimer = setTimeout(searchGrantStaff, 280);
}

async function searchGrantStaff() {
  const term = document.getElementById('grantStaffSearch')?.value.trim();
  const resultsEl = document.getElementById('grantStaffResults');

  if (!term || term.length < 2) {
    resultsEl.innerHTML = '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">Type a name or email to search.</div>';
    return;
  }

  resultsEl.innerHTML = '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">Searching…</div>';

  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('school_id', currentProfile.school_id)
    .or(`display_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(15);

  if (error) {
    resultsEl.innerHTML = `<div style="padding:12px 14px;color:var(--danger);font-size:13px;">Search failed: ${esc(error.message)}</div>`;
    return;
  }

  if (!data?.length) {
    resultsEl.innerHTML = '<div style="padding:12px 14px;text-align:center;color:var(--text-muted);font-size:13px;">No staff found.</div>';
    return;
  }

  resultsEl.innerHTML = '';
  data.forEach(p => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.12s;';
    div.innerHTML = `
      <div>
        <div style="font-size:14px;font-weight:600;">${esc(p.display_name ?? p.email)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${esc(p.email)}</div>
      </div>
      <button class="btn btn-sm" data-pid="${esc(p.id)}" data-pname="${esc(p.display_name ?? p.email)}">Select</button>
    `;
    div.querySelector('button').addEventListener('click', (e) => {
      const btn = e.currentTarget;
      selectGrantee(btn.dataset.pid, btn.dataset.pname);
    });
    div.addEventListener('mouseenter', () => { div.style.background = '#f8fafc'; });
    div.addEventListener('mouseleave', () => { div.style.background = ''; });
    resultsEl.appendChild(div);
  });
}

function selectGrantee(profileId, profileName) {
  selectedGranteeProfile = profileId;

  document.querySelectorAll('#grantStaffResults button[data-pid]').forEach(btn => {
    btn.textContent = btn.dataset.pid === profileId ? '✓ Selected' : 'Select';
    btn.style.background    = btn.dataset.pid === profileId ? 'var(--primary)' : '';
    btn.style.color         = btn.dataset.pid === profileId ? '#fff' : '';
    btn.style.borderColor   = btn.dataset.pid === profileId ? 'var(--primary)' : '';
  });

  const msg = document.getElementById('grantDrawerMsg');
  msg.textContent = `Selected: ${profileName}`;
  msg.style.color = 'var(--success, #15803d)';
  document.getElementById('grantDrawerSave').disabled = false;
}

async function saveGrant() {
  if (!selectedGranteeProfile) return;
  const teacherId = document.getElementById('grantTeacherSelect')?.value;
  const msgEl     = document.getElementById('grantDrawerMsg');

  if (!teacherId) {
    msgEl.textContent = 'Please select a teacher.';
    msgEl.style.color = 'var(--danger)';
    return;
  }

  const saveBtn = document.getElementById('grantDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('compliance_report_grants')
    .insert({
      school_id:  currentProfile.school_id,
      grantee_id: selectedGranteeProfile,
      teacher_id: teacherId,
      granted_by: currentProfile.id,
    });

  saveBtn.disabled = false; saveBtn.textContent = 'Save Grant';

  if (error) {
    msgEl.textContent = error.code === '23505' ? 'This grant already exists.' : `Failed: ${esc(error.message)}`;
    msgEl.style.color = 'var(--danger)';
    return;
  }

  closeDrawer('grant');
  showToast('Access granted');
  await loadGrants();
}

// ═══════════════════════════════════════════════════════════════════════
// PHASE C — REVIEW SUBMITTED DATA
// ═══════════════════════════════════════════════════════════════════════
let activeReviewAgreementId = null;

function openReviewDataDrawer(agreementId) {
  const row = agreementCache.find(r => r.id === agreementId);
  if (!row) return;
  activeReviewAgreementId = agreementId;

  document.getElementById('reviewDataAgreementInfo').innerHTML = `
    <strong>${esc(row.signer_name)}</strong> &mdash; ${esc(row.signer_email)}<br>
    <span style="color:var(--text-muted);">Signed ${new Date(row.signed_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
    ${row.guardian_id ? '' : '<br><span style="font-size:12px;color:#92400e;">Not linked to a guardian record — apply will be skipped.</span>'}
  `;

  const fields = [];
  if (row.submitted_phone) {
    fields.push(`
      <div class="bg-detail-field">
        <span class="bg-detail-label">Submitted phone</span>
        <span class="bg-detail-value">${esc(row.submitted_phone)}</span>
      </div>
    `);
  }
  if (row.submitted_relationship) {
    fields.push(`
      <div class="bg-detail-field">
        <span class="bg-detail-label">Submitted relationship</span>
        <span class="bg-detail-value">${esc(row.submitted_relationship)}</span>
      </div>
    `);
  }

  document.getElementById('reviewDataFields').innerHTML = fields.join('') ||
    '<p class="muted" style="font-size:13px;">No additional data to review.</p>';

  const applyBtn = document.getElementById('reviewDataApply');
  applyBtn.disabled = !row.guardian_id;
  applyBtn.title    = row.guardian_id ? '' : 'Guardian must be linked before applying data';

  document.getElementById('reviewDataMsg').textContent = '';
  openDrawer('reviewData');
}

async function applySubmittedData() {
  if (!activeReviewAgreementId) return;
  const row = agreementCache.find(r => r.id === activeReviewAgreementId);
  if (!row?.guardian_id) return;

  const applyBtn  = document.getElementById('reviewDataApply');
  const dismissBtn = document.getElementById('reviewDataDismiss');
  applyBtn.disabled = true; applyBtn.textContent = 'Applying…';
  dismissBtn.disabled = true;

  // Only phone maps to a guardian column; relationship is context only
  const update = {};
  if (row.submitted_phone) update.phone = row.submitted_phone;

  if (!Object.keys(update).length) {
    // Nothing to apply — just mark as reviewed
    await dismissSubmittedData();
    return;
  }

  const { error: guardianErr } = await supabase
    .from('guardians')
    .update(update)
    .eq('id', row.guardian_id)
    .eq('school_id', currentProfile.school_id);

  if (guardianErr) {
    document.getElementById('reviewDataMsg').textContent = `Failed to update guardian: ${esc(guardianErr.message)}`;
    applyBtn.disabled = false; applyBtn.textContent = 'Apply to guardian record';
    dismissBtn.disabled = false;
    return;
  }

  // Mark agreement as reviewed
  await supabase
    .from('compliance_agreements')
    .update({ submitted_data_reviewed: true })
    .eq('id', activeReviewAgreementId)
    .eq('school_id', currentProfile.school_id);

  closeDrawer('reviewData');
  showToast('Guardian record updated');
  resetAgreementCache();
  await loadAgreements();
}

async function dismissSubmittedData() {
  if (!activeReviewAgreementId) return;

  const { error } = await supabase
    .from('compliance_agreements')
    .update({ submitted_data_reviewed: true })
    .eq('id', activeReviewAgreementId)
    .eq('school_id', currentProfile.school_id);

  if (error) { alert(`Failed: ${error.message}`); return; }

  closeDrawer('reviewData');
  showToast('Marked as reviewed');
  resetAgreementCache();
  await loadAgreements();
}

// ── Toast ─────────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.classList.add('hidden'), 250); }, 3000);
}

init();

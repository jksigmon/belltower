
import { supabase } from './admin.supabase.js?v=2';
import { esc, fmtShortDate, dbError, todayISO } from './admin.shared.js?v=3';
import {
  openDrawer, closeDrawer, showToast, renderPagination,
  createBulkSelection, applyVolunteerStatusFilters, PAGE_SIZE,
} from './admin.compliance.utils.js';
import { VOLUNTEER_ROLES, credentialStatus } from './compliance.roles.js?v=2';
import { openVolunteerDrawerForRow, populateVolunteerRoleFilters, downloadCSV } from './admin.compliance.volunteers.js';

let _profile          = null;
let attPage            = 1;
let attStatusFilter    = '';   // '', 'expired', 'expiring_30', 'expiring_60', 'missing_bg'
let attSelectAllMatching = false;
let attMatchingTotal    = 0;

const attSelection = createBulkSelection({ barId: 'attBulkBar', countId: 'attBulkCount' });

export function resetAttentionView() {
  attPage = 1;
  attSelection.clear();
  attSelectAllMatching = false;
}

function attFilters() {
  return {
    search:     document.getElementById('attSearch')?.value.trim() || '',
    role:       document.getElementById('attRoleFilter')?.value || '',
    credential: document.getElementById('attCredentialFilter')?.value || '',
  };
}

export async function loadAttention(profile) {
  if (profile) _profile = profile;
  const tbody = document.getElementById('attTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

  populateVolunteerRoleFilters();
  await loadAttentionStats();

  const filters = attFilters();
  let query = baseAttentionQuery(filters, { withCount: true });
  query = query.order('bg_expires_at', { ascending: true, nullsFirst: true })
    .range((attPage - 1) * PAGE_SIZE, attPage * PAGE_SIZE - 1);

  const { data, count, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  const rows = data ?? [];
  attMatchingTotal = count ?? rows.length;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">Nothing needs attention right now.</td></tr>';
    document.getElementById('attPagination').style.display = 'none';
    document.getElementById('attSelectAllBar').style.display = 'none';
    attSelection.updateBar();
    return;
  }

  attSelection.prune(new Set(rows.map(r => r.id)));

  tbody.innerHTML = '';
  rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(row.first_name)} ${esc(row.last_name)}</strong></td>
      <td style="max-width:160px;white-space:normal;">${(row.volunteer_roles ?? []).map(r => `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:10px;font-weight:700;padding:2px 7px;display:inline-block;margin:1px;">${esc(VOLUNTEER_ROLES[r]?.label ?? r)}</span>`).join('') || '<span class="muted">—</span>'}</td>
      <td>${urgencyChip(row, 'bg')}</td>
      <td>${urgencyChip(row, 'mvr')}</td>
      <td>${urgencyChip(row, 'dl')}</td>
      <td>${urgencyChip(row, 'insurance')}</td>
      <td>${nextExpiryText(row)}</td>
      <td><button class="btn btn-sm" data-id="${esc(row.id)}">Edit</button></td>
      <td><input type="checkbox" class="att-row-check" data-id="${esc(row.id)}" ${attSelection.has(row.id) ? 'checked' : ''}></td>
    `;
    tr.querySelector('button[data-id]').addEventListener('click', () => openVolunteerDrawerForRow(row, () => loadAttention(), _profile));
    tr.querySelector('.att-row-check').addEventListener('change', e => attSelection.set(row.id, e.target.checked));
    tbody.appendChild(tr);
  });

  renderPagination('attPagination', attPage, attMatchingTotal, p => { attPage = p; loadAttention(); });
  attSelection.updateBar();
  attSelection.wireSelectAll('attSelectAllCheckbox', rows.map(r => r.id), () => loadAttention());
  updateSelectAllMatchingBar(rows.length);
}

// Shared by the paginated list, "select all matching", and CSV export --
// one predicate builder so they can never drift apart. `columns` must be
// set here (not chained afterward) -- supabase-js's query builder only
// accepts one .select() call per query.
function baseAttentionQuery(filters, { withCount = false, columns = '*' } = {}) {
  let query = supabase
    .from('compliance_volunteer_status')
    .select(columns, withCount ? { count: 'exact' } : undefined)
    .eq('school_id', _profile.school_id)
    .is('archived_at', null);
  query = applyVolunteerStatusFilters(query, { ...filters, status: attStatusFilter || undefined });
  if (!attStatusFilter) query = query.neq('worst_status', 'ok');
  return query;
}

async function loadAttentionStats() {
  const filters = attFilters();
  const countOnly = status => {
    let q = supabase
      .from('compliance_volunteer_status')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', _profile.school_id)
      .is('archived_at', null);
    q = applyVolunteerStatusFilters(q, { ...filters, status });
    return q;
  };
  const allQuery = (() => {
    let q = supabase
      .from('compliance_volunteer_status')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', _profile.school_id)
      .is('archived_at', null)
      .neq('worst_status', 'ok');
    return applyVolunteerStatusFilters(q, filters);
  })();

  const [all, expired, exp30, exp60, missing] = await Promise.all([
    allQuery,
    countOnly('expired'),
    countOnly('expiring_30'),
    countOnly('expiring_60'),
    countOnly('missing_bg'),
  ]);

  const set = (id, r) => { const el = document.getElementById(id); if (el) el.textContent = r.count ?? 0; };
  set('attCountAll', all);
  set('attCountExpired', expired);
  set('attCountExp30', exp30);
  set('attCountExp60', exp60);
  set('attCountMissing', missing);
}

function updateSelectAllMatchingBar(pageCount) {
  const bar = document.getElementById('attSelectAllBar');
  if (!bar) return;
  const allOnPageSelected = pageCount > 0 && attSelection.size() === pageCount &&
    document.getElementById('attSelectAllCheckbox')?.checked;
  if (attSelectAllMatching || !allOnPageSelected || attMatchingTotal <= pageCount) {
    bar.style.display = 'none';
    return;
  }
  document.getElementById('attPageCount').textContent = pageCount;
  document.getElementById('attMatchingCount').textContent = attMatchingTotal;
  bar.style.display = 'flex';
}

function urgencyChip(row, cred) {
  const status = credentialStatus(row, cred);
  if (status === 'ok') return '<span class="muted">—</span>';
  if (status === 'missing') return '<span class="bg-expiry-chip bg-expiry-warn">Missing</span>';

  const expiresCol = cred === 'bg' ? 'bg_expires_at' : cred === 'mvr' ? 'mvr_expires_at' : cred === 'dl' ? 'dl_expires_at' : 'insurance_expires_at';
  const dateStr = row[expiresCol] ? fmtShortDate(row[expiresCol]) : '';
  return `<span class="bg-expiry-chip bg-expiry-expired">Expired ${esc(dateStr)}</span>`;
}

function nextExpiryText(row) {
  if (!row.next_expiry) return '<span class="muted">—</span>';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(row.next_expiry + 'T12:00:00');
  const days = Math.round((exp - today) / 86400000);
  const label = days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'Today' : `in ${days}d`;
  const cls = days < 0 ? 'bg-expiry-expired' : days <= 30 ? 'bg-expiry-urgent' : days <= 60 ? 'bg-expiry-warn' : 'bg-expiry-soon';
  return `<span class="bg-expiry-chip ${cls}">${esc(label)}</span>`;
}

export function wireAttentionFilters() {
  const reset = () => { attPage = 1; attSelectAllMatching = false; loadAttention(); };
  document.getElementById('attSearch')?.addEventListener('input', reset);
  document.getElementById('attRoleFilter')?.addEventListener('change', reset);
  document.getElementById('attCredentialFilter')?.addEventListener('change', reset);

  document.querySelectorAll('.att-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      attStatusFilter = btn.dataset.status || '';
      document.querySelectorAll('.att-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      reset();
    });
  });

  document.getElementById('attSelectAllMatchingBtn')?.addEventListener('click', () => {
    attSelectAllMatching = true;
    document.getElementById('attSelectAllBar').style.display = 'none';
    attSelection.updateBar();
    const count = document.getElementById('attBulkCount');
    if (count) count.textContent = `${attMatchingTotal} selected (all matching filters)`;
    document.getElementById('attBulkBar').style.display = 'flex';
  });

  document.getElementById('attBulkArchiveBtn')?.addEventListener('click', bulkArchive);
  document.getElementById('attMarkRenewedBtn')?.addEventListener('click', openRenewDrawer);
  document.getElementById('attExportBtn')?.addEventListener('click', exportCSV);
}

// Resolves the current selection to a concrete id list -- either the
// checked rows, or (when "select all matching" was chosen) every id
// that matches the active filters, fetched fresh right before acting so
// the bulk action always lands on what's actually on screen.
async function resolveSelectedIds() {
  if (!attSelectAllMatching) return attSelection.ids();
  const { data, error } = await baseAttentionQuery(attFilters(), { columns: 'id' }).limit(5000);
  if (error) { dbError(error, 'Failed to resolve selection'); return []; }
  return (data ?? []).map(r => r.id);
}

function clearSelectionState() {
  attSelection.clear();
  attSelectAllMatching = false;
}

async function bulkArchive() {
  const ids = await resolveSelectedIds();
  if (!ids.length) return;
  if (!confirm(`Archive ${ids.length} volunteer${ids.length === 1 ? '' : 's'}?`)) return;

  const { error } = await supabase
    .from('compliance_volunteers')
    .update({ archived_at: new Date().toISOString() })
    .in('id', ids)
    .eq('school_id', _profile.school_id);

  if (error) { dbError(error, 'Archive failed'); return; }
  showToast(`${ids.length} volunteer${ids.length === 1 ? '' : 's'} archived`);
  clearSelectionState();
  await loadAttention();
}

function openRenewDrawer() {
  document.getElementById('attRenewClearedAt').value = todayISO();
  document.getElementById('attRenewMsg').textContent = '';
  openDrawer('attRenew');
}

export async function saveRenew() {
  const clearedAt = document.getElementById('attRenewClearedAt')?.value;
  const msgEl = document.getElementById('attRenewMsg');
  if (!clearedAt) { msgEl.textContent = 'Pick a date.'; return; }

  const [y, m, d] = clearedAt.split('-');
  const expiresAt = `${parseInt(y, 10) + 1}-${m}-${d}`;

  const ids = await resolveSelectedIds();
  if (!ids.length) { msgEl.textContent = 'Nothing selected.'; return; }

  const saveBtn = document.getElementById('attRenewSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Applying…';

  const { error } = await supabase
    .from('compliance_volunteers')
    .update({ bg_cleared_at: clearedAt, bg_expires_at: expiresAt, mvr_cleared_at: clearedAt, mvr_expires_at: expiresAt })
    .in('id', ids)
    .eq('school_id', _profile.school_id);

  saveBtn.disabled = false; saveBtn.textContent = 'Apply';

  if (error) { msgEl.textContent = `Failed: ${esc(error.message)}`; return; }

  closeDrawer('attRenew');
  showToast(`${ids.length} volunteer${ids.length === 1 ? '' : 's'} marked renewed`);
  clearSelectionState();
  await loadAttention();
}

async function exportCSV() {
  const { data, error } = await baseAttentionQuery(attFilters())
    .order('bg_expires_at', { ascending: true, nullsFirst: true })
    .limit(5000);
  if (error) { dbError(error, 'Export failed'); return; }

  const header = ['First name', 'Last name', 'Roles', 'BG cleared', 'BG expires', 'MVR cleared', 'MVR expires', 'DL expires', 'Insurance expires', 'Next expiry'];
  const rows = (data ?? []).map(r => [
    r.first_name, r.last_name, (r.volunteer_roles ?? []).join('; '),
    r.bg_cleared_at ?? '', r.bg_expires_at ?? '', r.mvr_cleared_at ?? '', r.mvr_expires_at ?? '',
    r.dl_expires_at ?? '', r.insurance_expires_at ?? '', r.next_expiry ?? '',
  ]);
  downloadCSV('needs-attention.csv', header, rows);
}

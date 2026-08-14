
import { supabase } from './admin.supabase.js?v=2';
import { esc, fmtShortDate, dbError, debounce } from './admin.shared.js?v=3';
import { openDrawer, closeDrawer, showToast, renderPagination, PAGE_SIZE } from './admin.compliance.utils.js';
import { VOLUNTEER_ROLES, roleCheckboxGridHTML } from './compliance.roles.js?v=2';

let _profile        = null;
let reqPage          = 1;
let reqPageRows      = new Map(); // id -> row, current page only
let volunteerIndex   = null;      // matchKey -> { id, first_name, last_name } for the whole school
let activeRequest    = null;      // request row currently open in the resolve drawer
let resolvedVolunteer = null;     // the volunteer the resolve drawer will link to

// ═══════════════════════════════════════════════════════════════════════
// REQUESTS INBOX
// ═══════════════════════════════════════════════════════════════════════

export function resetRequestsView() {
  reqPage = 1;
  volunteerIndex = null;
}

// Mirrors public.compliance_volunteer_match_key() closely enough for a
// client-side suggestion -- strips "(...)" nickname annotations, keys
// off the first *word* of the first name. Not used for anything that
// writes data on its own; resolving a request always goes through an
// explicit save, so an imperfect suggestion here just means the admin
// has to use the search box instead of the one-click suggestion.
function matchKey(firstName, lastName) {
  const norm = s => (s ?? '').replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  const last = norm(lastName).toLowerCase();
  const first = norm(firstName).toLowerCase().split(' ')[0] ?? '';
  return `${last}|${first}`;
}

async function loadVolunteerIndex() {
  if (volunteerIndex) return volunteerIndex;
  const { data } = await supabase
    .from('compliance_volunteers')
    .select('id, first_name, last_name')
    .eq('school_id', _profile.school_id)
    .is('archived_at', null);
  volunteerIndex = new Map();
  (data ?? []).forEach(v => volunteerIndex.set(matchKey(v.first_name, v.last_name), v));
  return volunteerIndex;
}

function reqFilters() {
  return {
    search: document.getElementById('reqSearch')?.value.trim() || '',
    status: document.getElementById('reqStatusFilter')?.value || '',
  };
}

export async function loadRequests(profile) {
  if (profile) _profile = profile;
  const tbody = document.getElementById('reqTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

  await loadVolunteerIndex();

  const filters = reqFilters();
  let query = supabase
    .from('compliance_bg_check_requests')
    .select('id, subject_first_name, subject_last_name, subject_email, reason, status, requested_at, volunteer_roles, volunteer_id, requestor:profiles!requestor_id(display_name, email)', { count: 'exact' })
    .eq('school_id', _profile.school_id)
    .is('archived_at', null);

  query = filters.status ? query.eq('status', filters.status) : query.in('status', ['pending', 'submitted']);
  if (filters.search) {
    const term = `%${filters.search}%`;
    query = query.or(`subject_first_name.ilike.${term},subject_last_name.ilike.${term},subject_email.ilike.${term}`);
  }

  query = query.order('requested_at', { ascending: false })
    .range((reqPage - 1) * PAGE_SIZE, reqPage * PAGE_SIZE - 1);

  const { data, count, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  const rows = data ?? [];
  reqPageRows = new Map(rows.map(r => [r.id, r]));

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:32px 0;">No requests match the current filters.</td></tr>';
    document.getElementById('reqPagination').style.display = 'none';
    return;
  }

  tbody.innerHTML = '';
  rows.forEach(row => {
    const tr = document.createElement('tr');
    const match = row.volunteer_id ? null : volunteerIndex.get(matchKey(row.subject_first_name, row.subject_last_name));
    tr.innerHTML = `
      <td><strong>${esc(row.subject_first_name)} ${esc(row.subject_last_name)}</strong>${row.subject_email ? `<br><span class="muted" style="font-size:12px;">${esc(row.subject_email)}</span>` : ''}</td>
      <td>${esc(row.requestor?.display_name ?? row.requestor?.email ?? '—')}</td>
      <td style="max-width:160px;white-space:normal;">${(row.volunteer_roles ?? []).map(r => `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:10px;font-weight:700;padding:2px 7px;display:inline-block;margin:1px;">${esc(VOLUNTEER_ROLES[r]?.label ?? r)}</span>`).join('') || '<span class="muted">—</span>'}</td>
      <td style="max-width:160px;white-space:normal;">${row.reason ? esc(row.reason) : '<span class="muted">—</span>'}</td>
      <td>${row.volunteer_id ? '<span class="bg-status-pill bg-status-cleared">Linked</span>' : match ? `<span class="bg-status-pill bg-status-pending">Matches ${esc(match.first_name)} ${esc(match.last_name)}</span>` : '<span class="muted">No match</span>'}</td>
      <td><span class="bg-status-pill bg-status-${esc(row.status)}">${esc(row.status)}</span></td>
      <td>${fmtShortDate(row.requested_at)}</td>
      <td style="white-space:nowrap;">
        ${['pending', 'submitted'].includes(row.status) ? `<button class="btn btn-sm" data-resolve="${esc(row.id)}">Resolve</button>` : ''}
        ${row.status === 'pending' ? `<button class="btn btn-sm" data-sent="${esc(row.id)}">Mark Sent</button>` : ''}
        ${['pending', 'submitted'].includes(row.status) ? `<button class="btn btn-sm" data-decline="${esc(row.id)}" style="color:var(--danger);">Decline</button>` : ''}
      </td>
    `;
    tr.querySelector('[data-resolve]')?.addEventListener('click', () => openResolveDrawer(row.id));
    tr.querySelector('[data-sent]')?.addEventListener('click', () => markSent(row.id));
    tr.querySelector('[data-decline]')?.addEventListener('click', () => declineRequest(row.id));
    tbody.appendChild(tr);
  });

  renderPagination('reqPagination', reqPage, count ?? rows.length, p => { reqPage = p; loadRequests(); });
}

export function wireRequestFilters() {
  const reset = debounce(() => { reqPage = 1; loadRequests(); }, 250);
  document.getElementById('reqSearch')?.addEventListener('input', reset);
  document.getElementById('reqStatusFilter')?.addEventListener('change', () => { reqPage = 1; loadRequests(); });
  document.getElementById('reqAddRecordBtn')?.addEventListener('click', openAddRequestDrawer);

  // The resolve drawer's date inputs are static markup (unlike the
  // volunteer drawer's, which are rebuilt on every open), so this only
  // needs wiring once here -- wiring it inside openResolveDrawer() would
  // stack a duplicate 'change' listener on every open.
  wireExpireAutoFill('resolveClearedAt', 'resolveExpiresAt');
  wireExpireAutoFill('resolveMvrClearedAt', 'resolveMvrExpiresAt');
}

async function markSent(id) {
  const { error } = await supabase
    .from('compliance_bg_check_requests')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { dbError(error, 'Failed'); return; }
  showToast('Marked as sent');
  await loadRequests();
}

async function declineRequest(id) {
  if (!confirm('Decline this request?')) return;
  const { error } = await supabase
    .from('compliance_bg_check_requests')
    .update({ status: 'declined' })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { dbError(error, 'Failed'); return; }
  showToast('Request declined');
  await loadRequests();
}

// ── Add Request drawer (manager-logged walk-in) ────────────────────────
function openAddRequestDrawer() {
  document.getElementById('reqAddFirstName').value = '';
  document.getElementById('reqAddLastName').value = '';
  document.getElementById('reqAddEmail').value = '';
  document.getElementById('reqAddReason').value = '';
  document.getElementById('reqAddDrawerMsg').textContent = '';
  document.getElementById('reqAddRoleGrid').innerHTML = roleCheckboxGridHTML('reqAddRole');
  openDrawer('reqAdd');
}

export async function saveAddRequest() {
  const msgEl = document.getElementById('reqAddDrawerMsg');
  const firstName = document.getElementById('reqAddFirstName')?.value.trim();
  const lastName  = document.getElementById('reqAddLastName')?.value.trim();
  const roles     = [...document.querySelectorAll('input[name="reqAddRole"]:checked')].map(el => el.value);

  if (!firstName || !lastName) { msgEl.textContent = 'First and last name are required.'; return; }
  if (!roles.length) { msgEl.textContent = 'Select at least one role.'; return; }

  const saveBtn = document.getElementById('reqAddDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  const { error } = await supabase
    .from('compliance_bg_check_requests')
    .insert({
      school_id: _profile.school_id,
      requestor_id: null,
      subject_first_name: firstName,
      subject_last_name: lastName,
      subject_email: document.getElementById('reqAddEmail')?.value.trim() || null,
      volunteer_roles: roles,
      reason: document.getElementById('reqAddReason')?.value.trim() || null,
      status: 'pending',
    });

  saveBtn.disabled = false; saveBtn.textContent = 'Log Request';

  if (error) { msgEl.textContent = `Failed: ${esc(error.message)}`; return; }

  closeDrawer('reqAdd');
  showToast('Request logged');
  await loadRequests();
}

// ── Resolve Request drawer ──────────────────────────────────────────────
async function openResolveDrawer(id) {
  const row = reqPageRows.get(id);
  if (!row) return;
  activeRequest = row;
  resolvedVolunteer = null;

  document.getElementById('resolveRequestInfo').innerHTML = `
    <strong>${esc(row.subject_first_name)} ${esc(row.subject_last_name)}</strong>${row.subject_email ? ` &mdash; ${esc(row.subject_email)}` : ''}<br>
    <span class="muted">Requested by ${esc(row.requestor?.display_name ?? row.requestor?.email ?? '—')} · ${fmtShortDate(row.requested_at)}</span>
    ${row.reason ? `<br><span class="muted">${esc(row.reason)}</span>` : ''}
  `;

  document.getElementById('resolveClearedAt').value = '';
  document.getElementById('resolveExpiresAt').value = '';
  document.getElementById('resolveMvrClearedAt').value = '';
  document.getElementById('resolveMvrExpiresAt').value = '';
  document.getElementById('resolveDrawerMsg').textContent = '';
  document.getElementById('resolveVolunteerSearch').value = '';
  document.getElementById('resolveVolunteerResults').style.display = 'none';

  let suggested = null;
  if (row.volunteer_id) {
    const { data } = await supabase.from('compliance_volunteers').select('id, first_name, last_name').eq('id', row.volunteer_id).maybeSingle();
    suggested = data;
  } else {
    suggested = (await loadVolunteerIndex()).get(matchKey(row.subject_first_name, row.subject_last_name)) ?? null;
  }
  setResolvedVolunteer(suggested, suggested ? (row.volunteer_id ? 'Already linked.' : 'Suggested match — change it below if this is wrong.') : 'No roster match found — a new volunteer record will be created.');

  openDrawer('resolve');
}

function setResolvedVolunteer(volunteer, hint) {
  resolvedVolunteer = volunteer;
  const chip = document.getElementById('resolveVolunteerChip');
  chip.innerHTML = volunteer
    ? `<span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:999px;padding:2px 10px;font-size:12px;color:#15803d;">${esc(volunteer.first_name)} ${esc(volunteer.last_name)}</span>`
    : '<span class="muted" style="font-size:12px;">No volunteer selected — one will be created on save.</span>';
  document.getElementById('resolveVolunteerHint').textContent = hint ?? '';
}

let resolveSearchTimer = null;
export function onResolveVolunteerSearchInput() {
  clearTimeout(resolveSearchTimer);
  resolveSearchTimer = setTimeout(searchResolveVolunteers, 280);
}

async function searchResolveVolunteers() {
  const term = document.getElementById('resolveVolunteerSearch')?.value.trim();
  const resultsEl = document.getElementById('resolveVolunteerResults');
  if (!term || term.length < 2) { resultsEl.style.display = 'none'; return; }

  resultsEl.innerHTML = '<div class="ft-typeahead-empty">Searching…</div>';
  resultsEl.style.display = '';

  const { data, error } = await supabase
    .from('compliance_volunteers')
    .select('id, first_name, last_name, email')
    .eq('school_id', _profile.school_id)
    .is('archived_at', null)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(10);

  if (error) { resultsEl.innerHTML = `<div class="ft-typeahead-empty">Search failed: ${esc(error.message)}</div>`; return; }
  if (!data?.length) { resultsEl.innerHTML = '<div class="ft-typeahead-empty">No volunteers found.</div>'; return; }

  resultsEl.innerHTML = '';
  data.forEach(v => {
    const item = document.createElement('div');
    item.className = 'ft-typeahead-item';
    item.innerHTML = `<strong>${esc(v.first_name)} ${esc(v.last_name)}</strong>${v.email ? `<span>${esc(v.email)}</span>` : ''}`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      setResolvedVolunteer(v, 'Manually selected.');
      document.getElementById('resolveVolunteerSearch').value = '';
      resultsEl.style.display = 'none';
    });
    resultsEl.appendChild(item);
  });
}

function wireExpireAutoFill(clearedId, expiresId) {
  const clearedEl = document.getElementById(clearedId);
  const expiresEl = document.getElementById(expiresId);
  if (!clearedEl || !expiresEl) return;
  clearedEl.addEventListener('change', () => {
    if (expiresEl.value) return;
    const val = clearedEl.value;
    if (!val) return;
    const [y, m, d] = val.split('-');
    expiresEl.value = `${parseInt(y, 10) + 1}-${m}-${d}`;
  });
}

export async function saveResolve() {
  const msgEl = document.getElementById('resolveDrawerMsg');
  const clearedAt = document.getElementById('resolveClearedAt')?.value || null;
  const expiresAt = document.getElementById('resolveExpiresAt')?.value || null;
  const mvrClearedAt = document.getElementById('resolveMvrClearedAt')?.value || null;
  const mvrExpiresAt = document.getElementById('resolveMvrExpiresAt')?.value || null;

  if (!clearedAt) { msgEl.textContent = 'Enter a BG cleared date.'; return; }

  const saveBtn = document.getElementById('resolveDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  let volunteerId = resolvedVolunteer?.id ?? null;

  if (!volunteerId) {
    const { data, error } = await supabase
      .from('compliance_volunteers')
      .insert({
        school_id: _profile.school_id,
        first_name: activeRequest.subject_first_name,
        last_name: activeRequest.subject_last_name,
        email: activeRequest.subject_email,
        volunteer_roles: activeRequest.volunteer_roles ?? [],
      })
      .select('id')
      .single();

    if (error && error.code === '23505') {
      // Someone else created a matching volunteer between the drawer
      // opening and now -- fall back to linking that one instead of
      // failing the save outright.
      const existing = await supabase
        .from('compliance_volunteers')
        .select('id')
        .eq('school_id', _profile.school_id)
        .ilike('first_name', activeRequest.subject_first_name)
        .ilike('last_name', activeRequest.subject_last_name)
        .is('archived_at', null)
        .maybeSingle();
      volunteerId = existing.data?.id ?? null;
    } else if (error) {
      saveBtn.disabled = false; saveBtn.textContent = 'Mark Cleared';
      msgEl.textContent = `Failed to create volunteer: ${esc(error.message)}`;
      return;
    } else {
      volunteerId = data.id;
    }
  }

  if (!volunteerId) {
    saveBtn.disabled = false; saveBtn.textContent = 'Mark Cleared';
    msgEl.textContent = 'Could not resolve a volunteer record.';
    return;
  }

  // Union this request's roles into the volunteer's role list rather
  // than overwriting it -- the same person can accumulate roles across
  // multiple separate requests over time.
  const { data: volunteer } = await supabase
    .from('compliance_volunteers')
    .select('volunteer_roles')
    .eq('id', volunteerId)
    .single();
  const mergedRoles = Array.from(new Set([...(volunteer?.volunteer_roles ?? []), ...(activeRequest.volunteer_roles ?? [])]));

  const volUpdate = { bg_cleared_at: clearedAt, bg_expires_at: expiresAt, volunteer_roles: mergedRoles };
  if (mvrClearedAt) { volUpdate.mvr_cleared_at = mvrClearedAt; volUpdate.mvr_expires_at = mvrExpiresAt; }

  const { error: volErr } = await supabase
    .from('compliance_volunteers')
    .update(volUpdate)
    .eq('id', volunteerId)
    .eq('school_id', _profile.school_id);

  if (volErr) {
    saveBtn.disabled = false; saveBtn.textContent = 'Mark Cleared';
    msgEl.textContent = `Failed to update volunteer: ${esc(volErr.message)}`;
    return;
  }

  const { error: reqErr } = await supabase
    .from('compliance_bg_check_requests')
    .update({
      status: 'cleared', cleared_at: clearedAt, expires_at: expiresAt,
      mvr_cleared_at: mvrClearedAt, mvr_expires_at: mvrExpiresAt,
      volunteer_id: volunteerId,
    })
    .eq('id', activeRequest.id)
    .eq('school_id', _profile.school_id);

  saveBtn.disabled = false; saveBtn.textContent = 'Mark Cleared';

  if (reqErr) { msgEl.textContent = `Failed to update request: ${esc(reqErr.message)}`; return; }

  closeDrawer('resolve');
  showToast('Request resolved');
  activeRequest = null;
  volunteerIndex = null; // the roster just changed
  await loadRequests();
}

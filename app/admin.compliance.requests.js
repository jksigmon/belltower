
import { supabase } from './admin.supabase.js?v=2';
import { esc, fmtShortDate, dbError, debounce, getAvatarColor } from './admin.shared.js?v=3';
import { openDrawer, closeDrawer, showToast, renderPagination, createBulkSelection, PAGE_SIZE } from './admin.compliance.utils.js';
import { VOLUNTEER_ROLES, roleCheckboxGridHTML } from './compliance.roles.js?v=2';
import { downloadCSV } from './admin.compliance.volunteers.js';

const reqSelection = createBulkSelection({ barId: 'reqBulkBar', countId: 'reqBulkCount', label: 'selected' });

let _profile        = null;
let reqPage          = 1;
let reqPageRows      = new Map(); // id -> row, current page only
let volunteerIndex   = null;      // matchKey -> { id, first_name, last_name } for the whole school
let activeRequest    = null;      // request row currently open in the resolve drawer
let resolvedVolunteer = null;     // the volunteer the resolve drawer will link to
let resolvedGuardian  = null;     // the guardian record to stamp onto that volunteer, if any

// ═══════════════════════════════════════════════════════════════════════
// REQUESTS INBOX
// ═══════════════════════════════════════════════════════════════════════

export function resetRequestsView() {
  reqPage = 1;
  volunteerIndex = null;
  reqSelection.clear();
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
    .select('id, first_name, last_name, guardian_id, email')
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
    sort: document.getElementById('reqSortSelect')?.value || 'newest',
  };
}

export async function loadRequests(profile) {
  if (profile) _profile = profile;
  const tbody = document.getElementById('reqTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

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

  query = query.order('requested_at', { ascending: filters.sort === 'oldest' })
    .range((reqPage - 1) * PAGE_SIZE, reqPage * PAGE_SIZE - 1);

  const { data, count, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  const rows = data ?? [];
  reqPageRows = new Map(rows.map(r => [r.id, r]));
  reqSelection.prune(new Set(rows.map(r => r.id)));

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">No requests match the current filters.</td></tr>';
    document.getElementById('reqPagination').style.display = 'none';
    reqSelection.updateBar();
    return;
  }

  tbody.innerHTML = '';
  rows.forEach(row => {
    const tr = document.createElement('tr');
    const match = row.volunteer_id ? null : volunteerIndex.get(matchKey(row.subject_first_name, row.subject_last_name));
    const name = `${row.subject_first_name} ${row.subject_last_name}`;
    const initials = ((row.subject_first_name?.[0] ?? '') + (row.subject_last_name?.[0] ?? '')).toUpperCase();
    tr.innerHTML = `
      <td>
        <div style="display:flex;align-items:center;gap:8px;">
          <div class="admin-table-avatar" style="background:${getAvatarColor(name)};">${esc(initials)}</div>
          <div><strong>${esc(row.subject_first_name)} ${esc(row.subject_last_name)}</strong>${row.subject_email ? `<br><span class="muted" style="font-size:12px;">${esc(row.subject_email)}</span>` : ''}</div>
        </div>
      </td>
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
        ${['declined', 'cancelled'].includes(row.status) ? `<button class="btn btn-sm" data-restore="${esc(row.id)}">Restore</button>` : ''}
      </td>
      <td>${row.status === 'pending' ? `<input type="checkbox" class="req-row-check" data-id="${esc(row.id)}" ${reqSelection.has(row.id) ? 'checked' : ''}>` : ''}</td>
    `;
    tr.querySelector('[data-resolve]')?.addEventListener('click', () => openResolveDrawer(row.id));
    tr.querySelector('[data-sent]')?.addEventListener('click', () => markSent(row.id));
    tr.querySelector('[data-decline]')?.addEventListener('click', () => declineRequest(row.id));
    tr.querySelector('[data-restore]')?.addEventListener('click', () => restoreRequest(row.id));
    const checkbox = tr.querySelector('.req-row-check');
    if (checkbox) checkbox.addEventListener('change', () => reqSelection.set(row.id, checkbox.checked));
    tbody.appendChild(tr);
  });

  renderPagination('reqPagination', reqPage, count ?? rows.length, p => { reqPage = p; loadRequests(); });
  reqSelection.updateBar();
  reqSelection.wireSelectAll(
    'reqSelectAllCheckbox',
    rows.filter(r => r.status === 'pending').map(r => r.id),
    () => loadRequests(),
  );
}

export function wireRequestFilters() {
  const reset = debounce(() => { reqPage = 1; loadRequests(); }, 250);
  document.getElementById('reqSearch')?.addEventListener('input', reset);
  document.getElementById('reqStatusFilter')?.addEventListener('change', () => { reqPage = 1; loadRequests(); });
  document.getElementById('reqSortSelect')?.addEventListener('change', () => { reqPage = 1; loadRequests(); });
  document.getElementById('reqAddRecordBtn')?.addEventListener('click', openAddRequestDrawer);
  document.getElementById('reqAutoMatchBtn')?.addEventListener('click', openGuardianMatchReview);
  document.getElementById('reqExportBtn')?.addEventListener('click', exportRequestsCSV);
  document.getElementById('reqBulkMarkSentBtn')?.addEventListener('click', bulkMarkSent);

  // The resolve drawer's date inputs are static markup (unlike the
  // volunteer drawer's, which are rebuilt on every open), so this only
  // needs wiring once here -- wiring it inside openResolveDrawer() would
  // stack a duplicate 'change' listener on every open.
  wireExpireAutoFill('resolveClearedAt', 'resolveExpiresAt');
  wireExpireAutoFill('resolveMvrClearedAt', 'resolveMvrExpiresAt');
}

// Exports the currently filtered requests as a CSV of first/last name,
// email, and phone. Phone (and email, as a fallback) only comes through
// when a request is linked to a guardian record -- normally indirectly,
// through a resolved compliance_volunteers row (what Auto-Match Guardians
// and the manual Resolve drawer both produce), but a direct guardian_id
// on the request itself (e.g. a bulk historical import) is honored too.
// Requests with neither link have no phone number anywhere to export.
async function exportRequestsCSV() {
  const filters = reqFilters();
  const { data: school } = await supabase.from('schools').select('name').eq('id', _profile.school_id).single();

  let query = supabase
    .from('compliance_bg_check_requests')
    .select('subject_first_name, subject_last_name, subject_email, volunteer_id, guardian_id')
    .eq('school_id', _profile.school_id)
    .is('archived_at', null)
    .order('subject_last_name', { ascending: true })
    .order('subject_first_name', { ascending: true })
    .limit(5000);

  query = filters.status ? query.eq('status', filters.status) : query.in('status', ['pending', 'submitted']);
  if (filters.search) {
    const term = `%${filters.search}%`;
    query = query.or(`subject_first_name.ilike.${term},subject_last_name.ilike.${term},subject_email.ilike.${term}`);
  }

  const { data, error } = await query;
  if (error) { dbError(error, 'Export failed'); return; }
  const rows = data ?? [];

  const volunteerIds = [...new Set(rows.filter(r => !r.guardian_id && r.volunteer_id).map(r => r.volunteer_id))];
  const volunteerGuardianMap = new Map();
  if (volunteerIds.length) {
    const { data: vols } = await supabase
      .from('compliance_volunteers')
      .select('id, guardian_id')
      .in('id', volunteerIds);
    (vols ?? []).forEach(v => { if (v.guardian_id) volunteerGuardianMap.set(v.id, v.guardian_id); });
  }

  const guardianIds = [...new Set(rows.map(r => r.guardian_id || volunteerGuardianMap.get(r.volunteer_id)).filter(Boolean))];
  const guardianMap = new Map();
  if (guardianIds.length) {
    const { data: guardians } = await supabase.from('guardians').select('id, email, phone').in('id', guardianIds);
    (guardians ?? []).forEach(g => guardianMap.set(g.id, g));
  }

  const header = ['First name', 'Last name', 'Email', 'Phone'];
  const csvRows = rows.map(r => {
    const guardian = guardianMap.get(r.guardian_id || volunteerGuardianMap.get(r.volunteer_id));
    return [r.subject_first_name, r.subject_last_name, r.subject_email || guardian?.email || '', guardian?.phone || ''];
  });
  const filenamePrefix = school?.name ? `${school.name} ` : '';
  downloadCSV(`${filenamePrefix}Background Check Requests.csv`, header, csvRows);
}

// ── Guardian Auto-Match (preview & review before writing) ───────────────
// Finds candidate guardian matches by exact email (preferred) or exact
// first+last name, but never writes anything until the admin reviews and
// confirms individual matches in a drawer -- auto-linking contact records
// silently is easy to get wrong on a common name, so this mirrors the
// review-before-apply pattern already used for guardian intake data
// elsewhere in this module (see admin.compliance.forms.js).
let guardianMatchCandidates = [];

async function openGuardianMatchReview() {
  const btn = document.getElementById('reqAutoMatchBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Matching…'; }

  try {
    const result = await computeGuardianMatchCandidates();
    if (!result) return; // error already surfaced via dbError

    if (!result.matches.length) {
      showToast(result.ambiguous ? `No confident matches found (${result.ambiguous} skipped — ambiguous)` : 'No matches found');
      return;
    }

    guardianMatchCandidates = result.matches;
    renderGuardianMatchReview(result.matches, result.ambiguous);
    openDrawer('guardianMatch');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Auto-Match Guardians'; }
  }
}

async function computeGuardianMatchCandidates() {
  const { data: requests, error: reqErr } = await supabase
    .from('compliance_bg_check_requests')
    .select('id, subject_first_name, subject_last_name, subject_email, volunteer_id, volunteer_roles')
    .eq('school_id', _profile.school_id)
    .is('archived_at', null);
  if (reqErr) { dbError(reqErr, 'Auto-match failed'); return null; }
  if (!requests?.length) return { matches: [], ambiguous: 0 };

  // "Already resolved" means linked to a volunteer that itself already
  // has a guardian -- the same state Save Link leaves behind manually.
  // A stray guardian_id set directly on the request (e.g. from a bulk
  // historical import, or an older build of this feature) doesn't count
  // -- those still get offered so they can be upgraded to a real roster
  // link instead of just a CSV-only guardian pointer.
  const volunteerIds = [...new Set(requests.filter(r => r.volunteer_id).map(r => r.volunteer_id))];
  let volunteerGuardians = new Map();
  if (volunteerIds.length) {
    const { data: vols } = await supabase.from('compliance_volunteers').select('id, guardian_id').in('id', volunteerIds);
    volunteerGuardians = new Map((vols ?? []).map(v => [v.id, v.guardian_id]));
  }
  const candidates = requests.filter(r => !(r.volunteer_id && volunteerGuardians.get(r.volunteer_id)));
  if (!candidates.length) return { matches: [], ambiguous: 0 };

  const { data: guardians, error: gErr } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, email')
    .eq('school_id', _profile.school_id)
    .eq('active', true);
  if (gErr) { dbError(gErr, 'Auto-match failed'); return null; }

  const norm = s => (s ?? '').trim().toLowerCase();
  const byEmail = new Map();
  const byName = new Map();
  (guardians ?? []).forEach(g => {
    if (g.email) {
      const key = norm(g.email);
      byEmail.set(key, byEmail.has(key) ? null : g); // null marks an ambiguous duplicate
    }
    const nameKey = `${norm(g.last_name)}|${norm(g.first_name)}`;
    byName.set(nameKey, byName.has(nameKey) ? null : g);
  });

  const matches = [];
  let ambiguous = 0;
  candidates.forEach(r => {
    let basis = 'email';
    let g = r.subject_email ? byEmail.get(norm(r.subject_email)) : undefined;
    if (g === undefined) { basis = 'name'; g = byName.get(`${norm(r.subject_last_name)}|${norm(r.subject_first_name)}`); }
    if (g === null) { ambiguous++; return; }
    if (!g) return;
    matches.push({
      requestId:       r.id,
      volunteerId:     r.volunteer_id || null,
      subjectFirstName: r.subject_first_name,
      subjectLastName:  r.subject_last_name,
      volunteerRoles:  r.volunteer_roles ?? [],
      requestName:     `${r.subject_first_name} ${r.subject_last_name}`,
      requestEmail:    r.subject_email,
      guardianId:      g.id,
      guardianName:    `${g.first_name} ${g.last_name}`,
      guardianEmail:   g.email,
      basis,
    });
  });

  return { matches, ambiguous };
}

function renderGuardianMatchReview(matches, ambiguous) {
  document.getElementById('guardianMatchSummary').textContent =
    `${matches.length} match${matches.length === 1 ? '' : 'es'} found` + (ambiguous ? ` — ${ambiguous} skipped (ambiguous match)` : '');
  document.getElementById('guardianMatchMsg').textContent = '';

  const listEl = document.getElementById('guardianMatchList');
  listEl.innerHTML = matches.map((m, i) => `
    <div class="req-roster-card" style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;">
      <input type="checkbox" class="guardian-match-check" data-idx="${i}" checked style="margin-top:3px;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;"><strong>${esc(m.requestName)}</strong>${m.requestEmail ? ` <span class="muted">${esc(m.requestEmail)}</span>` : ''}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
          → matched to <strong>${esc(m.guardianName)}</strong>${m.guardianEmail ? ` <span class="muted">${esc(m.guardianEmail)}</span>` : ''}
          <span class="bg-status-pill bg-status-pending" style="margin-left:6px;">${m.basis === 'email' ? 'Email match' : 'Name match'}</span>
        </div>
      </div>
    </div>
  `).join('');

  const selectAll = document.getElementById('guardianMatchSelectAll');
  selectAll.checked = true;
  selectAll.onchange = () => {
    listEl.querySelectorAll('.guardian-match-check').forEach(cb => { cb.checked = selectAll.checked; });
  };
}

// Links a matched request's subject to their compliance_volunteers row,
// creating one only if the roster genuinely doesn't have them yet.
// Checks volunteerIndex (keyed by the same matchKey() the DB's
// uq_compliance_volunteers_match_key constraint is built on) before
// inserting, rather than inserting blind and catching the conflict --
// that used to be the only path, which both spammed Postgres error logs
// on every already-known volunteer and, when the post-conflict ilike
// name lookup didn't line up exactly with the stored name, silently
// left the request unlinked even though a volunteer clearly matched.
// Mirrors ensureResolvedVolunteerId() below (that one operates on the
// single request open in the Resolve drawer; this operates on an
// arbitrary match from the bulk review list).
async function ensureVolunteerForMatch(m) {
  if (m.volunteerId) return m.volunteerId;

  const linkVolunteerId = async id => {
    const { error } = await supabase
      .from('compliance_bg_check_requests')
      .update({ volunteer_id: id })
      .eq('id', m.requestId)
      .eq('school_id', _profile.school_id);
    if (error) throw error;
    return id;
  };

  const known = (await loadVolunteerIndex()).get(matchKey(m.subjectFirstName, m.subjectLastName));
  if (known) return linkVolunteerId(known.id);

  const { data, error } = await supabase
    .from('compliance_volunteers')
    .insert({
      school_id: _profile.school_id,
      first_name: m.subjectFirstName,
      last_name: m.subjectLastName,
      email: m.requestEmail,
      volunteer_roles: m.volunteerRoles,
    })
    .select('id')
    .single();

  if (!error) return linkVolunteerId(data.id);

  if (error.code === '23505') {
    // Someone else created a matching volunteer between when this batch
    // was loaded and now -- refresh the index and link to that one
    // instead of failing the match outright.
    volunteerIndex = null;
    const existing = (await loadVolunteerIndex()).get(matchKey(m.subjectFirstName, m.subjectLastName));
    if (existing) return linkVolunteerId(existing.id);
  }

  throw error;
}

export async function confirmGuardianMatches() {
  const listEl = document.getElementById('guardianMatchList');
  const selected = [...listEl.querySelectorAll('.guardian-match-check:checked')]
    .map(cb => guardianMatchCandidates[Number(cb.dataset.idx)]);

  if (!selected.length) {
    document.getElementById('guardianMatchMsg').textContent = 'Select at least one match to link, or Cancel.';
    return;
  }

  const btn = document.getElementById('guardianMatchConfirm');
  btn.disabled = true; btn.textContent = 'Linking…';

  // Fully resolves each match the same way the manual Resolve drawer's
  // guardian Save Link does -- ensure a volunteer roster record exists
  // for the subject, then attach the guardian to that volunteer. Not
  // just a CSV-only pointer on the request.
  let failures = 0;
  for (const m of selected) {
    try {
      const volunteerId = await ensureVolunteerForMatch(m);
      const { error } = await supabase
        .from('compliance_volunteers')
        .update({ guardian_id: m.guardianId })
        .eq('id', volunteerId)
        .eq('school_id', _profile.school_id);
      if (error) throw error;
    } catch {
      failures++;
    }
  }

  btn.disabled = false; btn.textContent = 'Link Selected';

  closeDrawer('guardianMatch');
  const linked = selected.length - failures;
  showToast(`Linked ${linked} guardian${linked === 1 ? '' : 's'}${failures ? ` (${failures} failed — try again)` : ''}`);
  guardianMatchCandidates = [];
  volunteerIndex = null; // the roster and/or a volunteer's guardian_id changed
  await loadRequests();
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

// Bulk version of markSent() for the CSV-export-then-notify-Praesidium
// workflow -- exporting a batch shouldn't require clicking Mark Sent on
// each row individually afterward. The status guard means a row that
// someone else already moved off "pending" between page load and this
// click just doesn't get touched, rather than erroring the whole batch.
async function bulkMarkSent() {
  const ids = reqSelection.ids();
  if (!ids.length) return;
  if (!confirm(`Mark ${ids.length} request${ids.length === 1 ? '' : 's'} as sent?`)) return;

  const { error } = await supabase
    .from('compliance_bg_check_requests')
    .update({ status: 'submitted', submitted_at: new Date().toISOString() })
    .in('id', ids)
    .eq('school_id', _profile.school_id)
    .eq('status', 'pending');

  if (error) { dbError(error, 'Failed'); return; }
  showToast(`${ids.length} request${ids.length === 1 ? '' : 's'} marked as sent`);
  reqSelection.clear();
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

async function restoreRequest(id) {
  if (!confirm('Restore this request to Pending?')) return;
  const { error } = await supabase
    .from('compliance_bg_check_requests')
    .update({ status: 'pending' })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { dbError(error, 'Failed'); return; }
  showToast('Request restored');
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

  const name = `${row.subject_first_name} ${row.subject_last_name}`;
  const initials = ((row.subject_first_name?.[0] ?? '') + (row.subject_last_name?.[0] ?? '')).toUpperCase();
  const requestedBy = row.requestor?.display_name ?? row.requestor?.email ?? '—';

  document.getElementById('resolveRequestInfo').innerHTML = `
    <div class="req-detail-header">
      <div class="admin-table-avatar" style="width:40px;height:40px;font-size:14px;background:${getAvatarColor(name)};">${esc(initials)}</div>
      <div style="flex:1;min-width:0;">
        <div class="req-detail-name">${esc(name)}</div>
        ${row.subject_email ? `<div class="req-detail-email">${esc(row.subject_email)}</div>` : ''}
      </div>
      <span class="bg-status-pill bg-status-${esc(row.status)}">${esc(row.status)}</span>
    </div>
    <div class="req-detail-grid">
      <div class="bg-detail-field" style="margin-bottom:0;">
        <span class="bg-detail-label">Requested by</span>
        <span class="bg-detail-value">${esc(requestedBy)}</span>
      </div>
      <div class="bg-detail-field" style="margin-bottom:0;">
        <span class="bg-detail-label">Requested on</span>
        <span class="bg-detail-value">${fmtShortDate(row.requested_at)}</span>
      </div>
    </div>
    ${row.volunteer_roles?.length ? `
    <div class="bg-detail-field">
      <span class="bg-detail-label">Requested roles</span>
      <div>${row.volunteer_roles.map(r => `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:11px;font-weight:700;padding:2px 8px;margin-right:4px;display:inline-block;">${esc(VOLUNTEER_ROLES[r]?.label ?? r)}</span>`).join('')}</div>
    </div>` : ''}
    ${row.reason ? `
    <div class="bg-detail-field">
      <span class="bg-detail-label">Additional information</span>
      <span class="bg-detail-value">${esc(row.reason)}</span>
    </div>` : ''}
  `;

  document.getElementById('resolveClearedAt').value = '';
  document.getElementById('resolveExpiresAt').value = '';
  document.getElementById('resolveMvrClearedAt').value = '';
  document.getElementById('resolveMvrExpiresAt').value = '';
  document.getElementById('resolveDrawerMsg').textContent = '';
  document.getElementById('resolveVolunteerSearch').value = '';
  document.getElementById('resolveVolunteerResults').style.display = 'none';
  document.getElementById('resolveGuardianSearch').value = '';
  document.getElementById('resolveGuardianResults').style.display = 'none';

  let suggested = null;
  if (row.volunteer_id) {
    const { data } = await supabase.from('compliance_volunteers').select('id, first_name, last_name, guardian_id, email').eq('id', row.volunteer_id).maybeSingle();
    suggested = data;
  } else {
    suggested = (await loadVolunteerIndex()).get(matchKey(row.subject_first_name, row.subject_last_name)) ?? null;
  }
  setResolvedVolunteer(suggested, suggested ? (row.volunteer_id ? 'Already linked.' : 'Suggested match — change it below if this is wrong.') : 'No roster match found — a new volunteer record will be created.');
  await refreshGuardianForVolunteer(suggested);

  openDrawer('resolve');
}

// Re-fetches and displays whichever guardian is actually linked to
// `volunteer` right now -- called on drawer open, and again if the
// admin manually swaps the matched volunteer in the Roster Match box,
// so the Guardian record card never shows a stale link left over from
// a previous match.
async function refreshGuardianForVolunteer(volunteer) {
  let guardian = null;
  if (volunteer?.guardian_id) {
    const { data } = await supabase.from('guardians').select('id, first_name, last_name, email').eq('id', volunteer.guardian_id).maybeSingle();
    guardian = data;
  }
  setResolvedGuardian(guardian, guardian ? 'Already linked.' : 'No guardian linked — search below to link one.');
}

function setResolvedVolunteer(volunteer, hint) {
  resolvedVolunteer = volunteer;
  const chip = document.getElementById('resolveVolunteerChip');
  chip.innerHTML = volunteer
    ? `<span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:999px;padding:2px 10px;font-size:12px;color:#15803d;">${esc(volunteer.first_name)} ${esc(volunteer.last_name)}</span>`
    : '<span class="muted" style="font-size:12px;">No volunteer selected — one will be created on save.</span>';
  document.getElementById('resolveVolunteerHint').textContent = hint ?? '';
  updateResolveGuardianSaveBtn();
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
    .select('id, first_name, last_name, email, guardian_id')
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
      refreshGuardianForVolunteer(v);
      document.getElementById('resolveVolunteerSearch').value = '';
      resultsEl.style.display = 'none';
    });
    resultsEl.appendChild(item);
  });
}

function setResolvedGuardian(guardian, hint) {
  resolvedGuardian = guardian;
  const chip = document.getElementById('resolveGuardianChip');
  chip.innerHTML = guardian
    ? `<span style="display:inline-flex;align-items:center;gap:4px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:999px;padding:2px 10px;font-size:12px;color:#15803d;">${esc(guardian.first_name)} ${esc(guardian.last_name)}</span>`
    : '<span class="muted" style="font-size:12px;">No guardian linked.</span>';
  document.getElementById('resolveGuardianHint').textContent = hint ?? '';
  updateResolveGuardianSaveBtn();
}

// The Guardian record card can be saved on its own, ahead of Mark
// Cleared -- an admin working through a batch of requests may want to
// confirm/link guardians as they go without also having BG dates in
// hand yet. Shown whenever a guardian has been picked; disabled only
// when there's nothing new to save (already linked to that guardian).
function updateResolveGuardianSaveBtn() {
  const btn = document.getElementById('resolveGuardianSaveBtn');
  if (!btn) return;
  btn.style.display = resolvedGuardian ? '' : 'none';
  btn.disabled = !resolvedGuardian || (!!resolvedVolunteer && resolvedGuardian.id === resolvedVolunteer.guardian_id);
}

export async function saveResolveGuardianLink() {
  if (!resolvedGuardian) return;

  const btn = document.getElementById('resolveGuardianSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  let volunteerId;
  try {
    // No roster match yet means no compliance_volunteers row exists at
    // all -- create one now rather than making the admin wait until
    // Mark Cleared just to record which guardian this subject is.
    volunteerId = await ensureResolvedVolunteerId();
  } catch (err) {
    document.getElementById('resolveGuardianHint').textContent = `Failed to save: ${err.message}`;
    btn.disabled = false; btn.textContent = 'Save Link';
    return;
  }

  const { error } = await supabase
    .from('compliance_volunteers')
    .update({ guardian_id: resolvedGuardian.id })
    .eq('id', volunteerId)
    .eq('school_id', _profile.school_id);

  btn.textContent = 'Save Link';

  if (error) {
    document.getElementById('resolveGuardianHint').textContent = `Failed to save: ${error.message}`;
    btn.disabled = false;
    return;
  }

  resolvedVolunteer.guardian_id = resolvedGuardian.id;
  document.getElementById('resolveGuardianHint').textContent = 'Already linked.';
  showToast('Guardian linked');
  updateResolveGuardianSaveBtn();
  volunteerIndex = null; // this volunteer's guardian_id just changed
  await loadRequests(); // refresh the Roster match badge behind the drawer without waiting for a page reload
}

let resolveGuardianSearchTimer = null;
export function onResolveGuardianSearchInput() {
  clearTimeout(resolveGuardianSearchTimer);
  resolveGuardianSearchTimer = setTimeout(searchResolveGuardians, 280);
}

async function searchResolveGuardians() {
  const term = document.getElementById('resolveGuardianSearch')?.value.trim();
  const resultsEl = document.getElementById('resolveGuardianResults');
  if (!term || term.length < 2) { resultsEl.style.display = 'none'; return; }

  resultsEl.innerHTML = '<div class="ft-typeahead-empty">Searching…</div>';
  resultsEl.style.display = '';

  const { data, error } = await supabase
    .from('guardians')
    .select('id, first_name, last_name, email')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`)
    .limit(10);

  if (error) { resultsEl.innerHTML = `<div class="ft-typeahead-empty">Search failed: ${esc(error.message)}</div>`; return; }
  if (!data?.length) { resultsEl.innerHTML = '<div class="ft-typeahead-empty">No guardians found.</div>'; return; }

  resultsEl.innerHTML = '';
  data.forEach(g => {
    const item = document.createElement('div');
    item.className = 'ft-typeahead-item';
    item.innerHTML = `<strong>${esc(g.first_name)} ${esc(g.last_name)}</strong>${g.email ? `<span>${esc(g.email)}</span>` : ''}`;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      setResolvedGuardian(g, 'Manually selected.');
      document.getElementById('resolveGuardianSearch').value = '';
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

// Creates a compliance_volunteers row for the current request's subject
// if one isn't already matched/linked, so callers always end up with a
// real id to attach dates/guardian_id to. Shared by saveResolve() (the
// full Mark Cleared flow) and saveResolveGuardianLink() (linking a
// guardian ahead of clearing, before any volunteer row may exist yet).
async function ensureResolvedVolunteerId() {
  if (resolvedVolunteer?.id) {
    await backfillResolvedVolunteerEmail();
    return resolvedVolunteer.id;
  }

  const { data, error } = await supabase
    .from('compliance_volunteers')
    .insert({
      school_id: _profile.school_id,
      first_name: activeRequest.subject_first_name,
      last_name: activeRequest.subject_last_name,
      email: activeRequest.subject_email || resolvedGuardian?.email || null,
      volunteer_roles: activeRequest.volunteer_roles ?? [],
    })
    .select('id, first_name, last_name, guardian_id, email')
    .single();

  let created = data;
  if (error && error.code === '23505') {
    // Someone else created a matching volunteer between the drawer
    // opening and now -- fall back to linking that one instead of
    // failing the save outright.
    const existing = await supabase
      .from('compliance_volunteers')
      .select('id, first_name, last_name, guardian_id, email')
      .eq('school_id', _profile.school_id)
      .ilike('first_name', activeRequest.subject_first_name)
      .ilike('last_name', activeRequest.subject_last_name)
      .is('archived_at', null)
      .maybeSingle();
    created = existing.data ?? null;
  } else if (error) {
    throw error;
  }

  if (!created) throw new Error('Could not resolve a volunteer record.');

  volunteerIndex = null; // the roster just changed
  await supabase
    .from('compliance_bg_check_requests')
    .update({ volunteer_id: created.id })
    .eq('id', activeRequest.id)
    .eq('school_id', _profile.school_id);

  setResolvedVolunteer(created, 'Already linked.');
  await backfillResolvedVolunteerEmail();
  return created.id;
}

// A volunteer record can predate the email it should have -- created
// manually, or matched to a request that never carried a subject_email
// itself. Whenever we're about to link/clear one that still has no
// email on file, backfill it from whatever email this resolve did turn
// up (the request's subject_email, or the linked guardian's), so the
// roster stops showing "--" for people who are clearly already linked.
async function backfillResolvedVolunteerEmail() {
  if (!resolvedVolunteer || resolvedVolunteer.email) return;
  const candidateEmail = activeRequest?.subject_email || resolvedGuardian?.email || null;
  if (!candidateEmail) return;

  const { error } = await supabase
    .from('compliance_volunteers')
    .update({ email: candidateEmail })
    .eq('id', resolvedVolunteer.id)
    .eq('school_id', _profile.school_id)
    .is('email', null); // don't clobber an email set concurrently elsewhere

  if (!error) resolvedVolunteer.email = candidateEmail;
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

  let volunteerId;
  try {
    volunteerId = await ensureResolvedVolunteerId();
  } catch (err) {
    saveBtn.disabled = false; saveBtn.textContent = 'Mark Cleared';
    msgEl.textContent = `Failed to create volunteer: ${esc(err.message)}`;
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
  if (resolvedGuardian) volUpdate.guardian_id = resolvedGuardian.id;

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
  resolvedGuardian = null;
  volunteerIndex = null; // the roster just changed
  await loadRequests();
}

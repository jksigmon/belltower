
import { supabase } from './admin.supabase.js?v=2';
import { esc, fmtShortDate, dbError, downloadCSV } from './admin.shared.js?v=4';
import {
  openDrawer, closeDrawer, showToast, renderPagination,
  createBulkSelection, applyVolunteerStatusFilters, closeOpenRequestsForVolunteers, PAGE_SIZE,
} from './admin.compliance.utils.js';
import {
  VOLUNTEER_ROLES, roleCheckboxGridHTML, credentialStatus,
  wireRoleDetailsRequirement, rolesRequireDetails, DETAIL_ROLE_HINT, DETAIL_ROLE_ERROR,
} from './compliance.roles.js?v=4';
import { openLinkGuardianDrawerForVolunteer } from './admin.compliance.forms.js';

let _profile        = null;
let volPage          = 1;
let activeVolunteer   = null;      // the row currently open in the drawer, or null when adding
let _onSavedCallback = null;      // lets other sections (Attention) refresh themselves after a save

const VOLUNTEER_FILES_BUCKET = 'volunteer-credential-files';
const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/*';

// Same attach/view/replace/remove box as the Chaperone Credentials tool
// (admin.chaperone-credentials.js) -- .cc-doc-box/.cc-doc-upload live in
// admin-ui.css so both screens share the exact look.
const DOC_ICON    = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const CHECK_ICON  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
const UPLOAD_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';
const PAPERCLIP_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

const FILE_FIELD_IDS = {
  dl:        { input: 'bgDrawerDlFileInput',  cell: 'bgDrawerDlFileCell' },
  insurance: { input: 'bgDrawerInsFileInput', cell: 'bgDrawerInsFileCell' },
};

// Pending file changes for the open drawer, applied only once the volunteer
// row itself saves successfully -- same deferred-to-save pattern as the CEU
// attachment flow in staff.html.
let _pendingDlFile  = null;
let _pendingInsFile = null;
let _removeDlFile   = false;
let _removeInsFile  = false;

const volSelection = createBulkSelection({ barId: 'volBulkBar', countId: 'volBulkCount' });

// ═══════════════════════════════════════════════════════════════════════
// VOLUNTEERS DIRECTORY
// ═══════════════════════════════════════════════════════════════════════

export function resetVolunteerView() {
  volPage = 1;
  volSelection.clear();
}

let _roleFilterPopulated = false;
export function populateVolunteerRoleFilters() {
  if (_roleFilterPopulated) return;
  _roleFilterPopulated = true;
  const targets = ['volRoleFilter', 'attRoleFilter'].map(id => document.getElementById(id)).filter(Boolean);
  targets.forEach(sel => {
    Object.entries(VOLUNTEER_ROLES).forEach(([key, role]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = role.label;
      sel.appendChild(opt);
    });
  });
}

function volFilters() {
  return {
    search:       document.getElementById('volSearch')?.value.trim() || '',
    role:         document.getElementById('volRoleFilter')?.value || '',
    status:       document.getElementById('volStatusFilter')?.value || '',
    showArchived: document.getElementById('volShowArchived')?.checked ?? false,
  };
}

export async function loadVolunteers(profile) {
  if (profile) _profile = profile;
  const tbody = document.getElementById('volTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

  populateVolunteerRoleFilters();

  let query = supabase
    .from('compliance_volunteer_status')
    .select('*', { count: 'exact' })
    .eq('school_id', _profile.school_id);
  query = applyVolunteerStatusFilters(query, volFilters());
  query = query.order('last_name', { ascending: true })
    .range((volPage - 1) * PAGE_SIZE, volPage * PAGE_SIZE - 1);

  const { data, count, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="9" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  const rows = data ?? [];

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted" style="text-align:center;padding:32px 0;">No volunteers match the current filters.</td></tr>';
    document.getElementById('volPagination').style.display = 'none';
    volSelection.updateBar();
    return;
  }

  volSelection.prune(new Set(rows.map(r => r.id)));

  tbody.innerHTML = '';
  rows.forEach(row => {
    const tr = document.createElement('tr');
    if (row.archived_at) tr.style.opacity = '0.5';
    tr.innerHTML = `
      <td><strong>${esc(row.first_name)} ${esc(row.last_name)}</strong>${row.archived_at ? ' <span class="bg-status-pill" style="background:#f1f5f9;color:#64748b;">Archived</span>' : ''}</td>
      <td>${row.email ? esc(row.email) : '<span class="muted">—</span>'}</td>
      <td style="max-width:160px;white-space:normal;">${roleChipsHTML(row)}</td>
      <td>${credChipHTML(row, 'bg')}</td>
      <td>${credChipHTML(row, 'mvr')}</td>
      <td>${credChipHTML(row, 'dl')}${fileClipHTML(row, 'dl')}</td>
      <td>${credChipHTML(row, 'insurance')}${fileClipHTML(row, 'insurance')}</td>
      <td><button class="btn btn-sm" data-id="${esc(row.id)}">Edit</button></td>
      <td>${row.archived_at ? '' : `<input type="checkbox" class="vol-row-check" data-id="${esc(row.id)}" ${volSelection.has(row.id) ? 'checked' : ''}>`}</td>
    `;
    tr.querySelector('button[data-id]').addEventListener('click', () => openVolunteerDrawerForRow(row, () => loadVolunteers()));
    const checkbox = tr.querySelector('.vol-row-check');
    if (checkbox) checkbox.addEventListener('change', () => volSelection.set(row.id, checkbox.checked));
    tr.querySelectorAll('.vol-file-clip').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        viewVolunteerFile(row, btn.dataset.clip);
      });
    });
    tbody.appendChild(tr);
  });

  renderPagination('volPagination', volPage, count ?? rows.length, p => { volPage = p; loadVolunteers(); });
  volSelection.updateBar();
  volSelection.wireSelectAll(
    'volSelectAllCheckbox',
    rows.filter(r => !r.archived_at).map(r => r.id),
    () => loadVolunteers(),
  );
}

function roleChipsHTML(row) {
  if (!row.volunteer_roles?.length) return '<span class="muted">—</span>';
  return row.volunteer_roles.map(r => {
    const label = VOLUNTEER_ROLES[r]?.label ?? r;
    return `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:10px;font-weight:700;padding:2px 7px;display:inline-block;margin:1px;">${esc(label)}</span>`;
  }).join('');
}

const CRED_DATE_COLS = {
  bg:        ['bg_cleared_at', 'bg_expires_at'],
  mvr:       ['mvr_cleared_at', 'mvr_expires_at'],
  dl:        [null, 'dl_expires_at'],
  insurance: [null, 'insurance_expires_at'],
};

function credChipHTML(row, cred) {
  const status = credentialStatus(row, cred);
  const [, expiresCol] = CRED_DATE_COLS[cred];
  const dateStr = row[expiresCol] ? fmtShortDate(row[expiresCol]) : null;

  if (status === 'blocked') return '<span class="bg-status-pill bg-status-expired" title="Flagged not allowed to drive (May drive is unchecked below).">Not allowed to drive</span>';
  if (status === 'missing') return '<span class="bg-status-pill bg-status-cancelled">Missing</span>';
  if (status === 'expired') return `<span class="bg-status-pill bg-status-expired">Expired${dateStr ? ` ${esc(dateStr)}` : ''}</span>`;
  return `<span class="bg-status-pill bg-status-cleared">${dateStr ? esc(dateStr) : 'OK'}</span>`;
}

// Small clickable paperclip next to the DL/Insurance pill when a copy is on
// file -- lets an admin open the attachment straight from the list without
// opening the Edit Volunteer drawer.
function fileClipHTML(row, cred) {
  const path = cred === 'dl' ? row.dl_file_path : row.insurance_file_path;
  if (!path) return '';
  return `<button type="button" class="vol-file-clip" data-clip="${cred}" title="View attached file" style="background:none;border:none;color:#2563eb;padding:0;margin-left:5px;cursor:pointer;display:inline-flex;vertical-align:middle;">${PAPERCLIP_ICON}</button>`;
}

async function viewVolunteerFile(row, field) {
  const path = field === 'dl' ? row.dl_file_path : row.insurance_file_path;
  if (!path) return;
  const { data, error } = await supabase.storage.from(VOLUNTEER_FILES_BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { showToast('Could not open file' + (error ? ': ' + error.message : '')); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

export function wireVolunteerFilters() {
  const reset = () => { volPage = 1; loadVolunteers(); };
  document.getElementById('volSearch')?.addEventListener('input', reset);
  document.getElementById('volRoleFilter')?.addEventListener('change', reset);
  document.getElementById('volStatusFilter')?.addEventListener('change', reset);
  document.getElementById('volShowArchived')?.addEventListener('change', reset);
  document.getElementById('volAddRecordBtn')?.addEventListener('click', () => openVolunteerDrawerNew());
  document.getElementById('volBulkArchiveBtn')?.addEventListener('click', bulkArchiveVolunteers);
  document.getElementById('volExportBtn')?.addEventListener('click', exportVolunteersCSV);
}

async function bulkArchiveVolunteers() {
  const ids = volSelection.ids();
  if (!ids.length) return;
  if (!confirm(`Archive ${ids.length} volunteer${ids.length === 1 ? '' : 's'}?`)) return;

  const { error } = await supabase
    .from('compliance_volunteers')
    .update({ archived_at: new Date().toISOString() })
    .in('id', ids)
    .eq('school_id', _profile.school_id);

  if (error) { dbError(error, 'Archive failed'); return; }
  showToast(`${ids.length} volunteer${ids.length === 1 ? '' : 's'} archived`);
  volSelection.clear();
  await loadVolunteers();
}

async function exportVolunteersCSV() {
  let query = supabase
    .from('compliance_volunteer_status')
    .select('*')
    .eq('school_id', _profile.school_id)
    .order('last_name', { ascending: true })
    .limit(5000);
  query = applyVolunteerStatusFilters(query, volFilters());

  const { data, error } = await query;
  if (error) { dbError(error, 'Export failed'); return; }

  const header = ['First name', 'Last name', 'Email', 'Roles', 'BG cleared', 'BG expires', 'MVR cleared', 'MVR expires', 'DL expires', 'Insurance expires', 'May chaperone', 'May drive'];
  const csvRows = (data ?? []).map(r => [
    r.first_name, r.last_name, r.email ?? '', (r.volunteer_roles ?? []).join('; '),
    r.bg_cleared_at ?? '', r.bg_expires_at ?? '', r.mvr_cleared_at ?? '', r.mvr_expires_at ?? '',
    r.dl_expires_at ?? '', r.insurance_expires_at ?? '', r.can_chaperone ? 'Yes' : 'No', r.can_drive ? 'Yes' : 'No',
  ]);
  downloadCSV('volunteers.csv', header, csvRows);
}

// Moved to admin.shared.js — re-exported here so the compliance modules that
// already import it from this file keep working.
export { downloadCSV };

// ── Volunteer Drawer (shared with Attention's row-level Edit) ─────────
// Reuses the #bgDrawer markup left over from the old single BG-checks
// table -- same drawer, overlay, and buttons, just driven by volunteer
// fields now instead of request fields.

// `profile` is optional and only needed when this is called from a
// module other than this one (e.g. Needs Attention's row Edit button)
// -- _profile here is private module state, set by loadVolunteers(),
// which never runs if the admin lands on Attention without visiting
// the Volunteers tab first in this session.
export function openVolunteerDrawerForRow(row, onSaved, profile) {
  if (profile) _profile = profile;
  activeVolunteer = row;
  _onSavedCallback = onSaved ?? null;
  renderVolunteerDrawer(row);
  openDrawer('bg');
  wireExpireAutoFill('bgDrawerClearedAt',    'bgDrawerExpiresAt');
  wireExpireAutoFill('bgDrawerMvrClearedAt', 'bgDrawerMvrExpiresAt');
}

export function openVolunteerDrawerNew(prefill, onSaved, profile) {
  if (profile) _profile = profile;
  activeVolunteer = null;
  _onSavedCallback = onSaved ?? (() => loadVolunteers());
  renderVolunteerDrawer(null, prefill);
  openDrawer('bg');
  wireExpireAutoFill('bgDrawerClearedAt',    'bgDrawerExpiresAt');
  wireExpireAutoFill('bgDrawerMvrClearedAt', 'bgDrawerMvrExpiresAt');
}

function renderVolunteerDrawer(row, prefill) {
  const v = row ?? prefill ?? {};
  document.getElementById('bgDrawerTitle').textContent = row ? 'Edit Volunteer' : 'Add Volunteer Record';

  const selectedRoles = new Set(v.volunteer_roles ?? []);
  document.getElementById('bgDrawerBody').innerHTML = `
    <div class="drawer-row-2">
      <div class="drawer-field">
        <label for="bgDrawerFirstName">First name</label>
        <input type="text" id="bgDrawerFirstName" value="${esc(v.first_name ?? '')}">
      </div>
      <div class="drawer-field">
        <label for="bgDrawerLastName">Last name</label>
        <input type="text" id="bgDrawerLastName" value="${esc(v.last_name ?? '')}">
      </div>
    </div>
    <div class="drawer-field">
      <label for="bgDrawerEmail">Email</label>
      <input type="email" id="bgDrawerEmail" value="${esc(v.email ?? '')}">
    </div>
    <div class="drawer-field" id="bgDrawerGuardianWrap" style="display:none;">
      <label style="text-transform:none;font-size:0.85rem;">Guardian record</label>
      <div id="bgDrawerGuardianInfo"></div>
    </div>
    <div class="drawer-field">
      <label style="text-transform:none;font-size:0.85rem;">Volunteer role(s)</label>
      <div class="bg-role-grid" id="bgDrawerRoleGrid">${roleCheckboxGridHTML('bgDrawerRole')}</div>
    </div>
    <hr style="border:none;border-top:1px solid var(--border);margin:0;">
    <div class="drawer-row-2">
      <div class="drawer-field">
        <label for="bgDrawerClearedAt">BG cleared</label>
        <input type="date" id="bgDrawerClearedAt" autocomplete="off" value="${v.bg_cleared_at ?? ''}">
      </div>
      <div class="drawer-field">
        <label for="bgDrawerExpiresAt">BG expires</label>
        <input type="date" id="bgDrawerExpiresAt" autocomplete="off" value="${v.bg_expires_at ?? ''}">
      </div>
    </div>
    <div class="drawer-row-2">
      <div class="drawer-field">
        <label for="bgDrawerMvrClearedAt">MVR cleared</label>
        <input type="date" id="bgDrawerMvrClearedAt" autocomplete="off" value="${v.mvr_cleared_at ?? ''}">
      </div>
      <div class="drawer-field">
        <label for="bgDrawerMvrExpiresAt">MVR expires</label>
        <input type="date" id="bgDrawerMvrExpiresAt" autocomplete="off" value="${v.mvr_expires_at ?? ''}">
      </div>
    </div>
    <div class="drawer-row-2">
      <div class="drawer-field">
        <label for="bgDrawerDlExpiresAt">DL expires</label>
        <input type="date" id="bgDrawerDlExpiresAt" autocomplete="off" value="${v.dl_expires_at ?? ''}">
        <div id="bgDrawerDlFileCell" style="margin-top:6px;"></div>
        <input type="file" id="bgDrawerDlFileInput" accept="${FILE_ACCEPT}" style="display:none;">
      </div>
      <div class="drawer-field">
        <label for="bgDrawerInsExpiresAt">Insurance expires</label>
        <input type="date" id="bgDrawerInsExpiresAt" autocomplete="off" value="${v.insurance_expires_at ?? ''}">
        <div id="bgDrawerInsFileCell" style="margin-top:6px;"></div>
        <input type="file" id="bgDrawerInsFileInput" accept="${FILE_ACCEPT}" style="display:none;">
      </div>
    </div>
    <div style="display:flex;gap:20px;margin-bottom:8px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;">
        <input type="checkbox" id="bgDrawerCanChaperone" ${v.can_chaperone !== false ? 'checked' : ''}> May chaperone
      </label>
      <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;">
        <input type="checkbox" id="bgDrawerCanDrive" ${v.can_drive !== false ? 'checked' : ''}> May drive
      </label>
    </div>
    <div class="drawer-field">
      <label for="bgDrawerAdminNote">Admin note <span id="bgDrawerAdminNoteMark" style="color:var(--danger);display:none;">*</span></label>
      <textarea id="bgDrawerAdminNote" rows="3">${esc(v.admin_note ?? '')}</textarea>
      <span id="bgDrawerAdminNoteHint" class="muted" style="display:none;font-size:12px;margin-top:4px;">${DETAIL_ROLE_HINT}</span>
    </div>
    <div id="bgDrawerMsg" style="font-size:13px;color:var(--danger);min-height:18px;"></div>
  `;

  document.querySelectorAll('input[name="bgDrawerRole"]').forEach(cb => { cb.checked = selectedRoles.has(cb.value); });

  // The admin note is where an "Other" role gets its meaning here --
  // same rule the staff request form and Log a Request drawer enforce.
  // Wired after the checkboxes are restored so the marker reflects a
  // volunteer who already holds the role.
  wireRoleDetailsRequirement({
    inputName: 'bgDrawerRole',
    root: document.getElementById('bgDrawerRoleGrid'),
    notesEl: document.getElementById('bgDrawerAdminNote'),
    showWhenRequired: [
      document.getElementById('bgDrawerAdminNoteMark'),
      document.getElementById('bgDrawerAdminNoteHint'),
    ],
  });
  renderGuardianSection(row);
  wireDrawerFileSection('dl', row);
  wireDrawerFileSection('insurance', row);

  const archiveBtn = document.getElementById('bgDrawerArchive');
  if (archiveBtn) {
    if (row) {
      archiveBtn.style.display = '';
      archiveBtn.textContent = row.archived_at ? 'Unarchive this volunteer' : 'Archive this volunteer';
      archiveBtn.dataset.recordId = row.id;
      archiveBtn.dataset.archive  = row.archived_at ? '0' : '1';
    } else {
      archiveBtn.style.display = 'none';
    }
  }
}

// New (unsaved) volunteers have no id yet to link a guardian against,
// so the section stays hidden until the record has been saved once.
async function renderGuardianSection(row) {
  const wrap = document.getElementById('bgDrawerGuardianWrap');
  if (!wrap) return;
  if (!row?.id) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  const info = document.getElementById('bgDrawerGuardianInfo');
  info.innerHTML = '<span class="muted" style="font-size:13px;">Loading…</span>';

  let guardian = null;
  if (row.guardian_id) {
    const { data } = await supabase.from('guardians').select('id, first_name, last_name, email').eq('id', row.guardian_id).maybeSingle();
    guardian = data;
  }

  // The drawer may have been closed and reopened for a different row
  // while this fetch was in flight -- don't clobber that row's section.
  if (activeVolunteer?.id !== row.id) return;

  info.innerHTML = guardian
    ? `<div class="req-roster-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
         <span style="font-size:13px;">Linked to <strong>${esc(guardian.first_name)} ${esc(guardian.last_name)}</strong>${guardian.email ? ` &mdash; ${esc(guardian.email)}` : ''}</span>
         <button class="btn btn-sm" type="button" id="bgDrawerLinkGuardianBtn">Change</button>
       </div>`
    : `<div class="req-roster-card" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
         <span class="muted" style="font-size:13px;">Not linked to a guardian record.</span>
         <button class="btn btn-sm" type="button" id="bgDrawerLinkGuardianBtn">Link guardian</button>
       </div>`;

  document.getElementById('bgDrawerLinkGuardianBtn')?.addEventListener('click', () => {
    openLinkGuardianDrawerForVolunteer(row, async guardianRow => {
      row.guardian_id = guardianRow.id;
      if (activeVolunteer) activeVolunteer.guardian_id = guardianRow.id;
      await renderGuardianSection(row);
    }, _profile);
  });
}

function fileControlHTML(field, path, name) {
  if (path) {
    return `
      <div class="cc-doc-box">
        <span class="cc-doc-box-icon">${DOC_ICON}</span>
        <div class="cc-doc-box-body">
          <div class="cc-doc-box-name">
            <span>${esc(name ?? 'File')}</span>
            <span class="cc-doc-check">${CHECK_ICON}</span>
          </div>
          <div class="cc-doc-box-actions">
            <a href="#" data-view-file="${field}">View</a>
            <span class="cc-doc-sep">|</span>
            <button type="button" data-choose-file="${field}">Replace</button>
            <span class="cc-doc-sep">|</span>
            <button type="button" class="cc-doc-remove" data-remove-file="${field}">Remove</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <button type="button" class="cc-doc-upload" data-choose-file="${field}">
      ${UPLOAD_ICON}
      <span>Upload document</span>
    </button>
  `;
}

function filePendingUploadHTML(name) {
  return `
    <div class="cc-doc-box cc-doc-box-pending">
      <span class="cc-doc-box-icon">${DOC_ICON}</span>
      <div class="cc-doc-box-body">
        <div class="cc-doc-box-name"><span>${esc(name)}</span></div>
        <div class="cc-doc-box-actions"><span class="muted">Uploading on save…</span></div>
      </div>
    </div>
  `;
}

function filePendingRemoveHTML() {
  return `
    <div class="cc-doc-box cc-doc-box-pending">
      <span class="cc-doc-box-icon">${DOC_ICON}</span>
      <div class="cc-doc-box-body">
        <div class="cc-doc-box-name"><span class="muted">Removing…</span></div>
        <div class="cc-doc-box-actions"><span class="muted">on save</span></div>
      </div>
    </div>
  `;
}

// Resets the DL/insurance file section for the row being opened (or clears
// it for a new/unsaved volunteer), and shows whatever's currently attached.
// View fetches its signed URL on click (not pre-fetched here) -- same
// pattern as the Chaperone Credentials tool.
function wireDrawerFileSection(field, row) {
  const ids = FILE_FIELD_IDS[field];
  const inputEl = document.getElementById(ids.input);
  const cell    = document.getElementById(ids.cell);
  if (!inputEl || !cell) return;

  inputEl.value = '';
  delete inputEl.dataset.removed;
  if (field === 'dl') { _pendingDlFile = null; _removeDlFile = false; }
  else { _pendingInsFile = null; _removeInsFile = false; }

  const filePath = field === 'dl' ? row?.dl_file_path : row?.insurance_file_path;
  const fileName = field === 'dl' ? row?.dl_file_name : row?.insurance_file_name;
  cell.innerHTML = fileControlHTML(field, filePath, fileName);

  cell.onclick = e => {
    if (e.target.closest(`[data-choose-file="${field}"]`)) {
      inputEl.click();
    } else if (e.target.closest(`[data-remove-file="${field}"]`)) {
      inputEl.value = '';
      inputEl.dataset.removed = '1';
      if (field === 'dl') { _removeDlFile = true; _pendingDlFile = null; }
      else { _removeInsFile = true; _pendingInsFile = null; }
      cell.innerHTML = filePendingRemoveHTML();
    } else if (e.target.closest(`[data-view-file="${field}"]`)) {
      e.preventDefault();
      viewDrawerFile(field, row);
    }
  };

  inputEl.onchange = () => {
    const file = inputEl.files?.[0];
    delete inputEl.dataset.removed;
    if (field === 'dl') { _pendingDlFile = file ?? null; if (file) _removeDlFile = false; }
    else { _pendingInsFile = file ?? null; if (file) _removeInsFile = false; }
    if (file) cell.innerHTML = filePendingUploadHTML(file.name);
  };
}

async function viewDrawerFile(field, row) {
  const path = field === 'dl' ? row?.dl_file_path : row?.insurance_file_path;
  if (!path) return;
  const { data, error } = await supabase.storage.from(VOLUNTEER_FILES_BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { showToast('Could not open file' + (error ? ': ' + error.message : '')); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

// Uploads a staged file (or clears an existing one) for a saved volunteer
// row. Returns undefined when there's nothing to change for this field.
async function resolveDrawerFile(field, volunteerId) {
  const pendingFile = field === 'dl' ? _pendingDlFile : _pendingInsFile;
  const removeFlag  = field === 'dl' ? _removeDlFile  : _removeInsFile;
  const oldPath = activeVolunteer ? (field === 'dl' ? activeVolunteer.dl_file_path : activeVolunteer.insurance_file_path) : null;

  if (pendingFile) {
    const ts = Date.now();
    const safeName = pendingFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${_profile.school_id}/${volunteerId}/${field}-${ts}-${safeName}`;
    const { error } = await supabase.storage.from(VOLUNTEER_FILES_BUCKET)
      .upload(path, pendingFile, { contentType: pendingFile.type || 'application/octet-stream', upsert: false });
    if (error) {
      console.error('Volunteer file upload failed', error);
      showToast('Volunteer saved, but the file upload failed: ' + error.message);
      return undefined;
    }
    return { path, name: pendingFile.name, oldPathToRemove: oldPath || null };
  }

  if (removeFlag && oldPath) {
    return { path: null, name: null, oldPathToRemove: oldPath };
  }

  return undefined;
}

async function applyDrawerFileChanges(volunteerId) {
  const dl  = await resolveDrawerFile('dl', volunteerId);
  const ins = await resolveDrawerFile('insurance', volunteerId);
  if (dl === undefined && ins === undefined) return;

  const update = {};
  if (dl !== undefined)  { update.dl_file_path = dl.path;   update.dl_file_name = dl.name; }
  if (ins !== undefined) { update.insurance_file_path = ins.path; update.insurance_file_name = ins.name; }

  const { error } = await supabase.from('compliance_volunteers')
    .update(update)
    .eq('id', volunteerId)
    .eq('school_id', _profile.school_id);
  if (error) {
    console.error('Volunteer file link failed', error);
    showToast('Volunteer saved, but attaching the file failed: ' + error.message);
    return;
  }

  if (dl?.oldPathToRemove) await supabase.storage.from(VOLUNTEER_FILES_BUCKET).remove([dl.oldPathToRemove]);
  if (ins?.oldPathToRemove) await supabase.storage.from(VOLUNTEER_FILES_BUCKET).remove([ins.oldPathToRemove]);
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

export async function saveVolunteer() {
  const msgEl = document.getElementById('bgDrawerMsg');
  const firstName = document.getElementById('bgDrawerFirstName')?.value.trim();
  const lastName  = document.getElementById('bgDrawerLastName')?.value.trim();

  if (!firstName || !lastName) {
    msgEl.textContent = 'First and last name are required.';
    return;
  }

  const payload = {
    first_name:  firstName,
    last_name:   lastName,
    email:       document.getElementById('bgDrawerEmail')?.value.trim() || null,
    volunteer_roles: [...document.querySelectorAll('input[name="bgDrawerRole"]:checked')].map(el => el.value),
    bg_cleared_at:   document.getElementById('bgDrawerClearedAt')?.value || null,
    bg_expires_at:   document.getElementById('bgDrawerExpiresAt')?.value || null,
    mvr_cleared_at:  document.getElementById('bgDrawerMvrClearedAt')?.value || null,
    mvr_expires_at:  document.getElementById('bgDrawerMvrExpiresAt')?.value || null,
    dl_expires_at:   document.getElementById('bgDrawerDlExpiresAt')?.value || null,
    insurance_expires_at: document.getElementById('bgDrawerInsExpiresAt')?.value || null,
    can_chaperone:   document.getElementById('bgDrawerCanChaperone')?.checked ?? true,
    can_drive:       document.getElementById('bgDrawerCanDrive')?.checked ?? true,
    admin_note:      document.getElementById('bgDrawerAdminNote')?.value.trim() || null,
  };

  if (rolesRequireDetails(payload.volunteer_roles) && !payload.admin_note) {
    msgEl.textContent = DETAIL_ROLE_ERROR;
    document.getElementById('bgDrawerAdminNote')?.focus();
    return;
  }

  const saveBtn = document.getElementById('bgDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  let error, savedId;
  if (activeVolunteer) {
    ({ error } = await supabase
      .from('compliance_volunteers')
      .update(payload)
      .eq('id', activeVolunteer.id)
      .eq('school_id', _profile.school_id));
    savedId = activeVolunteer.id;
  } else {
    const { data, error: insertError } = await supabase
      .from('compliance_volunteers')
      .insert({ ...payload, school_id: _profile.school_id })
      .select('id')
      .single();
    error = insertError;
    savedId = data?.id;
  }

  saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';

  if (error) {
    msgEl.textContent = error.code === '23505'
      ? 'A volunteer with this name already exists. Edit their existing record instead.'
      : `Save failed: ${esc(error.message)}`;
    return;
  }

  if (savedId) await applyDrawerFileChanges(savedId);

  // Entering the BG cleared date here is functionally the same action as
  // "Mark Cleared" in the Requests screen's Resolve drawer -- it just
  // starts from the volunteer's own record instead of the request. Without
  // this, a request tied to this volunteer stayed stuck on
  // pending/submitted forever even though the roster now shows them cleared.
  if (activeVolunteer && payload.bg_cleared_at) {
    await closeOpenRequestsForVolunteers(_profile.school_id, activeVolunteer.id, {
      clearedAt: payload.bg_cleared_at,
      expiresAt: payload.bg_expires_at,
      mvrClearedAt: payload.mvr_cleared_at,
      mvrExpiresAt: payload.mvr_expires_at,
    });
  }

  // Keep the linked guardian's own DL/insurance/chaperone/drive columns in
  // sync -- compliance_report and the field-trips chaperone check both
  // still read those columns directly off guardians, not off this table.
  const guardianId = activeVolunteer?.guardian_id;
  if (guardianId) {
    await supabase.from('guardians')
      .update({
        dl_expires_at: payload.dl_expires_at,
        insurance_expires_at: payload.insurance_expires_at,
        can_chaperone: payload.can_chaperone,
        can_drive: payload.can_drive,
      })
      .eq('id', guardianId)
      .eq('school_id', _profile.school_id);
  }

  closeDrawer('bg');
  showToast(activeVolunteer ? 'Volunteer updated' : 'Volunteer added');
  activeVolunteer = null;
  if (_onSavedCallback) await _onSavedCallback();
  else await loadVolunteers();
}

export function onVolunteerArchiveClick() {
  const btn     = document.getElementById('bgDrawerArchive');
  const id      = btn?.dataset.recordId;
  const archive = btn?.dataset.archive === '1';
  if (id) archiveVolunteer(id, archive);
}

async function archiveVolunteer(id, archive) {
  const { error } = await supabase
    .from('compliance_volunteers')
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { dbError(error, 'Archive failed'); return; }
  closeDrawer('bg');
  showToast(archive ? 'Volunteer archived' : 'Volunteer unarchived');
  activeVolunteer = null;
  if (_onSavedCallback) await _onSavedCallback();
  else await loadVolunteers();
}

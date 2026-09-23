import { supabase } from './admin.supabase.js?v=2';
import { esc, debounce, showToast, dbError, todayISO, getAvatarColor } from './admin.shared.js?v=4';
import { VOLUNTEER_ROLES } from './compliance.roles.js?v=4';

const BUCKET = 'volunteer-credential-files';
const FILE_FIELDS = ['dl', 'insurance'];
const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/*';

let rows = new Map(); // id -> row, current result set
let schoolId = null;

const DOC_ICON    = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
const CHECK_ICON  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>';
const WARN_ICON   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 17h.01"/></svg>';
const DASH_ICON   = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';
const UPLOAD_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

export async function initChaperoneCredentials(profile) {
  schoolId = profile?.school_id ?? null;
  document.getElementById('ccSearch')?.addEventListener('input', debounce(load, 250));
  await load();
}

async function load() {
  const tbody = document.getElementById('ccTableBody');
  const term = document.getElementById('ccSearch')?.value.trim() || null;
  tbody.innerHTML = '<tr><td colspan="7" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

  const { data, error } = await supabase.rpc('list_chaperone_credentials', { p_search: term });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  const data_ = data ?? [];
  rows = new Map(data_.map(r => [r.id, r]));
  document.getElementById('ccTruncatedNote').style.display = data_.length >= 200 ? 'block' : 'none';

  if (!data_.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted" style="text-align:center;padding:32px 0;">${term ? 'No matches.' : 'No volunteers on the roster yet.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = '';
  data_.forEach(row => {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td>${nameCellHTML(row)}</td>
      <td style="max-width:160px;white-space:normal;">${roleChipsHTML(row.volunteer_roles)}</td>
      <td>${docCellHTML('dl', row)}</td>
      <td>${expirationCellHTML('dl', row)}</td>
      <td>${docCellHTML('insurance', row)}</td>
      <td>${expirationCellHTML('insurance', row)}</td>
      <td><button class="btn btn-primary btn-sm" data-save>Save</button></td>
    `;
    tr.querySelector('[data-save]').addEventListener('click', () => saveRow(row.id, tr));
    tr.querySelectorAll('input[type="date"]').forEach(input => {
      input.addEventListener('input', () => updateExpirationDisplay(input));
    });
    FILE_FIELDS.forEach(field => wireFileControls(tr, field));
    tbody.appendChild(tr);
  });
}

function nameCellHTML(row) {
  const name = `${row.first_name} ${row.last_name}`;
  const initials = `${row.first_name?.[0] ?? ''}${row.last_name?.[0] ?? ''}`.toUpperCase();
  const color = getAvatarColor(`${row.first_name ?? ''}${row.last_name ?? ''}`);
  return `
    <div class="staff-name-cell">
      <div class="staff-avatar" style="background:${color}">${initials}</div>
      <div class="staff-name-group">
        <span class="staff-fullname">${esc(name)}</span>
        <span class="staff-cell-muted">${row.email ? esc(row.email) : '—'}</span>
      </div>
    </div>
  `;
}

function roleChipsHTML(roleKeys) {
  if (!roleKeys?.length) return '<span class="muted">—</span>';
  return roleKeys.map(r => {
    const label = VOLUNTEER_ROLES[r]?.label ?? r;
    return `<span style="background:#eff6ff;color:#1d4ed8;border-radius:999px;font-size:10px;font-weight:700;padding:2px 7px;display:inline-block;margin:1px;">${esc(label)}</span>`;
  }).join('');
}

/* ── Expiration column: date input + status icon/subtext ───────────── */

function daysUntil(dateStr) {
  const today  = new Date(todayISO() + 'T00:00:00');
  const target = new Date(dateStr + 'T00:00:00');
  return Math.round((target - today) / 86400000);
}

function expirationStatus(dateStr) {
  if (!dateStr) return 'none';
  const days = daysUntil(dateStr);
  if (days < 0) return 'expired';
  if (days <= 30) return 'soon';
  return 'ok';
}

function expirationSubtext(dateStr) {
  const status = expirationStatus(dateStr);
  if (status === 'none') return 'No date set';
  const days = daysUntil(dateStr);
  if (status === 'expired') return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
  if (status === 'soon') return `Expires in ${days} day${days === 1 ? '' : 's'}`;
  if (days >= 365) {
    const yrs = Math.floor(days / 365);
    return `Valid for ${yrs}${yrs >= 6 ? '+' : ''} year${yrs === 1 ? '' : 's'}`;
  }
  const months = Math.floor(days / 30);
  return `Valid for ${months} month${months === 1 ? '' : 's'}`;
}

function expirationIcon(status) {
  if (status === 'ok') return CHECK_ICON;
  if (status === 'none') return DASH_ICON;
  return WARN_ICON; // soon or expired
}

function expirationCellHTML(field, row) {
  const dateVal = field === 'dl' ? row.dl_expires_at : row.insurance_expires_at;
  const status = expirationStatus(dateVal);
  return `
    <div class="cc-exp-cell">
      <span class="cc-exp-icon cc-exp-${status}">${expirationIcon(status)}</span>
      <div class="cc-exp-body">
        <input type="date" class="cc-exp-input" data-field="${field}" value="${dateVal ?? ''}">
        <span class="cc-exp-subtext cc-exp-${status}">${esc(expirationSubtext(dateVal))}</span>
      </div>
    </div>
  `;
}

function updateExpirationDisplay(input) {
  const cell = input.closest('.cc-exp-cell');
  if (!cell) return;
  const status = expirationStatus(input.value || null);
  const iconEl = cell.querySelector('.cc-exp-icon');
  const subEl  = cell.querySelector('.cc-exp-subtext');
  iconEl.className = `cc-exp-icon cc-exp-${status}`;
  iconEl.innerHTML  = expirationIcon(status);
  subEl.className   = `cc-exp-subtext cc-exp-${status}`;
  subEl.textContent = expirationSubtext(input.value || null);
}

/* ── Document column: attach/replace/remove ─────────────────────────── */

function docCellHTML(field, row) {
  const path = field === 'dl' ? row.dl_file_path : row.insurance_file_path;
  const name = field === 'dl' ? row.dl_file_name : row.insurance_file_name;
  return `
    <div data-file-cell="${field}">${fileControlHTML(field, path, name)}</div>
    <input type="file" data-file-input="${field}" accept="${FILE_ACCEPT}" style="display:none;">
  `;
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

function wireFileControls(tr, field) {
  const cell = tr.querySelector(`[data-file-cell="${field}"]`);
  const fileInput = tr.querySelector(`[data-file-input="${field}"]`);
  if (!cell || !fileInput) return;

  cell.addEventListener('click', e => {
    if (e.target.closest(`[data-choose-file="${field}"]`)) {
      fileInput.click();
    } else if (e.target.closest(`[data-remove-file="${field}"]`)) {
      fileInput.value = '';
      fileInput.dataset.removed = '1';
      cell.innerHTML = filePendingRemoveHTML();
    } else if (e.target.closest(`[data-view-file="${field}"]`)) {
      e.preventDefault();
      viewFile(tr.dataset.id, field);
    }
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    delete fileInput.dataset.removed;
    if (file) cell.innerHTML = filePendingUploadHTML(file.name);
  });
}

async function viewFile(id, field) {
  const row = rows.get(id);
  const path = field === 'dl' ? row?.dl_file_path : row?.insurance_file_path;
  if (!path) return;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { dbError(error ?? new Error('Could not open file'), 'Could not open file'); return; }
  window.open(data.signedUrl, '_blank', 'noopener');
}

// Resolves what a row's file column should end up as after Save: a freshly
// uploaded file, a pending removal, or (most of the time) whatever it
// already was. Returns null on a failed upload so saveRow() can bail
// before writing anything, instead of persisting dates with a half-applied
// file change.
async function resolveFileOutcome(id, field, tr, row) {
  const fileInput = tr.querySelector(`[data-file-input="${field}"]`);
  const currentPath = field === 'dl' ? row.dl_file_path : row.insurance_file_path;
  const currentName = field === 'dl' ? row.dl_file_name : row.insurance_file_name;

  const newFile = fileInput.files?.[0];
  if (newFile) {
    const ts = Date.now();
    const safeName = newFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${schoolId}/${id}/${field}-${ts}-${safeName}`;
    const { error } = await supabase.storage.from(BUCKET)
      .upload(path, newFile, { contentType: newFile.type || 'application/octet-stream', upsert: false });
    if (error) {
      dbError(error, 'File upload failed');
      return null;
    }
    return { path, name: newFile.name, oldPathToRemove: currentPath || null };
  }

  if (fileInput.dataset.removed === '1') {
    return { path: null, name: null, oldPathToRemove: currentPath || null };
  }

  return { path: currentPath ?? null, name: currentName ?? null, oldPathToRemove: null };
}

async function saveRow(id, tr) {
  const btn = tr.querySelector('[data-save]');
  const dlVal  = tr.querySelector('[data-field="dl"]').value || null;
  const insVal = tr.querySelector('[data-field="insurance"]').value || null;
  const row = rows.get(id);

  btn.disabled = true;
  btn.textContent = 'Saving…';

  const dlOutcome  = await resolveFileOutcome(id, 'dl', tr, row);
  const insOutcome = await resolveFileOutcome(id, 'insurance', tr, row);

  if (!dlOutcome || !insOutcome) {
    btn.disabled = false;
    btn.textContent = 'Save';
    return;
  }

  const { error } = await supabase.rpc('update_chaperone_credentials', {
    p_volunteer_id: id,
    p_dl_expires_at: dlVal,
    p_insurance_expires_at: insVal,
    p_dl_file_path: dlOutcome.path,
    p_dl_file_name: dlOutcome.name,
    p_insurance_file_path: insOutcome.path,
    p_insurance_file_name: insOutcome.name,
  });

  btn.disabled = false;
  btn.textContent = 'Save';

  if (error) { dbError(error, 'Save failed'); return; }

  row.dl_expires_at = dlVal;
  row.insurance_expires_at = insVal;
  row.dl_file_path = dlOutcome.path;
  row.dl_file_name = dlOutcome.name;
  row.insurance_file_path = insOutcome.path;
  row.insurance_file_name = insOutcome.name;

  if (dlOutcome.oldPathToRemove) await supabase.storage.from(BUCKET).remove([dlOutcome.oldPathToRemove]);
  if (insOutcome.oldPathToRemove) await supabase.storage.from(BUCKET).remove([insOutcome.oldPathToRemove]);

  const dlCell = tr.querySelector('[data-file-cell="dl"]');
  const insCell = tr.querySelector('[data-file-cell="insurance"]');
  if (dlCell) dlCell.innerHTML = fileControlHTML('dl', row.dl_file_path, row.dl_file_name);
  if (insCell) insCell.innerHTML = fileControlHTML('insurance', row.insurance_file_path, row.insurance_file_name);
  tr.querySelectorAll('input[type="file"]').forEach(input => { input.value = ''; delete input.dataset.removed; });

  showToast('Credentials updated');
  tr.classList.remove('cc-row-saved');
  void tr.offsetWidth; // restart the animation if the row was just saved again
  tr.classList.add('cc-row-saved');
}

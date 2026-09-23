
import { supabase } from './admin.supabase.js?v=2';
import { esc, fmtShortDate, dbError, downloadCSV, showToast } from './admin.shared.js?v=4';

const PAGE_SIZE = 25;

let _profile           = null;
let trnPage             = 1;
let editingTraining     = null;   // row being edited, or null when adding
let selectedEmployee    = null;   // { id, name } chosen from search results while adding
let trnStaffSearchTimer = null;

export async function initTraining(profile) {
  _profile = profile;
  wireDrawer();
  wireFilters();
  await loadTraining();
}

// ═══════════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════════

// Hours and Minutes are separate, additive fields (not an either/or unit
// choice) so a duration like "1 hr 15 min" doesn't require doing the math
// by hand -- 1 in Hours, 15 in Minutes, or just 75 in Minutes alone, both
// land on the same total. Mirrors admin.licensure.js's ceuHoursInHours(),
// minus the CEU conversion -- this is a plain duration, not a credit.
function trainingDurationInHours() {
  const hoursRaw   = parseFloat(document.getElementById('trnDrawerHours')?.value) || 0;
  const minutesRaw = parseFloat(document.getElementById('trnDrawerMinutes')?.value) || 0;
  const total = hoursRaw + minutesRaw / 60;
  return total > 0 ? Math.round(total * 100) / 100 : null;
}

function formatDuration(hours) {
  if (!hours) return '<span class="muted">—</span>';
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return esc(parts.join(' ') || '0m');
}

function trnFilters() {
  return {
    search:   document.getElementById('trnSearch')?.value.trim() || '',
    verified: document.getElementById('trnVerifiedFilter')?.value || '',
  };
}

async function loadTraining() {
  const tbody = document.getElementById('trnTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:32px 0;">Loading…</td></tr>';

  const { search, verified } = trnFilters();

  let query = supabase
    .from('staff_required_training')
    .select('id, employee_id, training_name, provider, completed_date, expires_date, duration_hours, verified, file_path, file_name, employees!employee_id(first_name, last_name)', { count: 'exact' })
    .eq('school_id', _profile.school_id);

  if (verified) query = query.eq('verified', verified === 'true');

  if (search) {
    const { data: matches } = await supabase
      .from('employees')
      .select('id')
      .eq('school_id', _profile.school_id)
      .or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
    const ids = (matches || []).map(m => m.id);
    if (!ids.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:32px 0;">No records match the current filters.</td></tr>';
      document.getElementById('trnPagination').style.display = 'none';
      return;
    }
    query = query.in('employee_id', ids);
  }

  query = query.order('completed_date', { ascending: false })
    .range((trnPage - 1) * PAGE_SIZE, trnPage * PAGE_SIZE - 1);

  const { data, count, error } = await query;

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8" class="status-danger" style="text-align:center;padding:32px 0;">Failed to load: ${esc(error.message)}</td></tr>`;
    return;
  }

  const rows = data ?? [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:32px 0;">No required training records logged yet.</td></tr>';
    document.getElementById('trnPagination').style.display = 'none';
    return;
  }

  tbody.innerHTML = '';
  rows.forEach(row => {
    const name = row.employees ? `${row.employees.first_name} ${row.employees.last_name}` : '—';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${esc(name)}</strong></td>
      <td>${esc(row.training_name)}</td>
      <td>${row.provider ? esc(row.provider) : '<span class="muted">—</span>'}</td>
      <td>${formatDuration(row.duration_hours)}</td>
      <td>${fmtShortDate(row.completed_date)}</td>
      <td>${row.expires_date ? fmtShortDate(row.expires_date) : '<span class="muted">—</span>'}</td>
      <td>${row.verified ? '<span class="trn-pill trn-pill-verified">Verified</span>' : '<span class="trn-pill trn-pill-pending">Pending</span>'}</td>
      <td style="white-space:nowrap;display:flex;gap:6px;">
        ${row.file_path ? `<button class="trn-btn-icon trn-btn-attach" data-action="attach" title="Open ${esc(row.file_name ?? 'attachment')}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>` : ''}
        <button class="btn btn-sm" data-action="edit">Edit</button>
        <button class="btn btn-sm" data-action="delete" style="color:var(--danger);">Delete</button>
      </td>
    `;
    tr.querySelector('[data-action="attach"]')?.addEventListener('click', () => openTrainingAttachment(row));
    tr.querySelector('[data-action="edit"]').addEventListener('click', () => openTrainingDrawerForRow(row));
    tr.querySelector('[data-action="delete"]').addEventListener('click', () => deleteTraining(row.id));
    tbody.appendChild(tr);
  });

  renderPagination(count ?? rows.length);
}

function renderPagination(totalItems) {
  const container = document.getElementById('trnPagination');
  if (!container) return;
  container.innerHTML = '';

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  const from = Math.min((trnPage - 1) * PAGE_SIZE + 1, totalItems);
  const to   = Math.min(trnPage * PAGE_SIZE, totalItems);

  const info = document.createElement('span');
  info.className = 'pagination-info';
  info.textContent = totalItems === 0
    ? 'No results'
    : totalPages <= 1
      ? `${totalItems} record${totalItems !== 1 ? '' : ''}`
      : `${from}–${to} of ${totalItems}`;
  container.appendChild(info);
  container.style.display = '';

  if (totalPages <= 1) return;

  const controls = document.createElement('div');
  controls.className = 'pagination-controls';

  function makeBtn(label, targetPage, disabled) {
    const btn = document.createElement('button');
    btn.innerHTML = label;
    btn.className = 'pagination-btn' + (targetPage === trnPage ? ' pagination-active' : '');
    btn.disabled = disabled;
    if (!disabled && targetPage !== trnPage) btn.onclick = () => { trnPage = targetPage; loadTraining(); };
    return btn;
  }

  controls.appendChild(makeBtn('&#8249;', trnPage - 1, trnPage === 1));
  for (let p = 1; p <= totalPages; p++) controls.appendChild(makeBtn(p, p, false));
  controls.appendChild(makeBtn('&#8250;', trnPage + 1, trnPage === totalPages));
  container.appendChild(controls);
}

function wireFilters() {
  const reset = () => { trnPage = 1; loadTraining(); };
  document.getElementById('trnSearch')?.addEventListener('input', reset);
  document.getElementById('trnVerifiedFilter')?.addEventListener('change', reset);
  document.getElementById('trnAddRecordBtn')?.addEventListener('click', () => openTrainingDrawerNew());
  document.getElementById('trnExportBtn')?.addEventListener('click', exportTrainingCSV);
}

async function exportTrainingCSV() {
  const { data, error } = await supabase
    .from('staff_required_training')
    .select('training_name, provider, completed_date, expires_date, duration_hours, verified, employees!employee_id(first_name, last_name)')
    .eq('school_id', _profile.school_id)
    .order('completed_date', { ascending: false })
    .limit(5000);

  if (error) { dbError(error, 'Export failed'); return; }

  const header = ['Employee', 'Training', 'Provider', 'Duration (hrs)', 'Completed', 'Expires', 'Verified'];
  const rows = (data ?? []).map(r => [
    r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : '',
    r.training_name, r.provider ?? '', r.duration_hours ?? '', r.completed_date, r.expires_date ?? '', r.verified ? 'Yes' : 'No',
  ]);
  downloadCSV('required-training.csv', header, rows);
}

// Open a training record's attachment straight from its row. The blank tab
// is opened synchronously on click so the popup blocker treats it as a
// user-initiated action; it's then pointed at the signed URL once resolved.
async function openTrainingAttachment(row) {
  if (!row.file_path) return;

  const win = window.open('', '_blank');
  if (win) win.opener = null;
  const { data, error } = await supabase.storage
    .from('training-files')
    .createSignedUrl(row.file_path, 3600);

  if (error || !data?.signedUrl) {
    if (win) win.close();
    console.error('Could not open attachment', error);
    showToast('Could not open attachment.', 'error');
    return;
  }

  if (win) win.location = data.signedUrl;
  else window.open(data.signedUrl, '_blank', 'noopener');
}

async function deleteTraining(id) {
  if (!confirm('Delete this training record? This cannot be undone.')) return;
  const { error } = await supabase.from('staff_required_training').delete().eq('id', id).eq('school_id', _profile.school_id);
  if (error) { dbError(error, 'Delete failed'); return; }
  showToast('Training record deleted');
  await loadTraining();
}

// ═══════════════════════════════════════════════════════════════════════
// DRAWER
// ═══════════════════════════════════════════════════════════════════════

function openDrawer() {
  document.getElementById('trnDrawerOverlay').style.display = '';
  document.getElementById('trnDrawer').style.display = '';
  requestAnimationFrame(() => {
    document.getElementById('trnDrawerOverlay').classList.add('open');
    document.getElementById('trnDrawer').classList.add('open');
  });
}

function closeDrawer() {
  const ol = document.getElementById('trnDrawerOverlay');
  const dr = document.getElementById('trnDrawer');
  ol.classList.remove('open'); dr.classList.remove('open');
  setTimeout(() => { ol.style.display = 'none'; dr.style.display = 'none'; }, 250);
}

function wireDrawer() {
  document.getElementById('trnDrawerOverlay')?.addEventListener('click', closeDrawer);
  document.getElementById('trnDrawerClose')?.addEventListener('click', closeDrawer);
  document.getElementById('trnDrawerCancel')?.addEventListener('click', closeDrawer);
  document.getElementById('trnDrawerSave')?.addEventListener('click', saveTraining);
  document.getElementById('trnStaffSearch')?.addEventListener('input', onTrainingStaffSearchInput);
}

function openTrainingDrawerNew() {
  editingTraining  = null;
  selectedEmployee = null;
  renderTrainingDrawer();
  openDrawer();
}

function openTrainingDrawerForRow(row) {
  editingTraining  = row;
  selectedEmployee = row.employees ? { id: row.employee_id, name: `${row.employees.first_name} ${row.employees.last_name}` } : null;
  renderTrainingDrawer();
  openDrawer();
}

function renderTrainingDrawer() {
  const t = editingTraining ?? {};
  document.getElementById('trnDrawerTitle').textContent = editingTraining ? 'Edit Training Record' : 'Add Training Record';

  // Only the combined decimal hours value is stored, so the original
  // Hours/Minutes split is gone on edit -- re-derive a sensible one.
  const wholeHours   = t.duration_hours ? Math.floor(t.duration_hours) : '';
  const remainderMin = t.duration_hours ? Math.round((t.duration_hours - Math.floor(t.duration_hours)) * 60) : '';

  const employeePicker = editingTraining
    ? `<div class="drawer-field"><label>Employee</label><div style="padding:8px 10px;background:#f9fafb;border:1px solid var(--border);border-radius:8px;font-size:13px;">${esc(selectedEmployee?.name ?? '—')}</div></div>`
    : `
      <div class="drawer-field">
        <label for="trnStaffSearch">Employee</label>
        <input type="text" id="trnStaffSearch" class="admin-input" placeholder="Type a name to search…" autocomplete="off">
        <div id="trnStaffResults" style="border:1px solid var(--border);border-radius:8px;margin-top:6px;max-height:180px;overflow-y:auto;"></div>
        <div id="trnStaffSelected" style="margin-top:8px;"></div>
      </div>`;

  document.getElementById('trnDrawerBody').innerHTML = `
    ${employeePicker}
    <div class="drawer-field">
      <label for="trnDrawerName">Training name</label>
      <input type="text" id="trnDrawerName" placeholder="e.g. Safe Schools: Blood Borne Pathogens" value="${esc(t.training_name ?? '')}">
    </div>
    <div class="drawer-row-2">
      <div class="drawer-field">
        <label for="trnDrawerProvider">Provider</label>
        <input type="text" id="trnDrawerProvider" value="${esc(t.provider ?? 'Vector Solutions')}">
      </div>
      <div class="drawer-field">
        <label style="text-transform:none;">&nbsp;</label>
        <label style="display:flex;align-items:center;gap:8px;font-size:14px;cursor:pointer;height:38px;">
          <input type="checkbox" id="trnDrawerVerified" ${t.verified ? 'checked' : ''}> Verified
        </label>
      </div>
    </div>
    <div class="drawer-field">
      <label>Duration <span class="muted" style="font-weight:400;">(optional)</span></label>
      <div class="lic-hours-input-row">
        <input type="number" id="trnDrawerHours" min="0" step="0.5" placeholder="Hours" value="${wholeHours}">
        <input type="number" id="trnDrawerMinutes" min="0" step="1" placeholder="Minutes" value="${remainderMin}">
      </div>
    </div>
    <div class="drawer-row-2">
      <div class="drawer-field">
        <label for="trnDrawerCompleted">Completed</label>
        <input type="date" id="trnDrawerCompleted" value="${t.completed_date ?? ''}">
      </div>
      <div class="drawer-field">
        <label for="trnDrawerExpires">Expires (if applicable)</label>
        <input type="date" id="trnDrawerExpires" value="${t.expires_date ?? ''}">
      </div>
    </div>
    <div class="drawer-field">
      <label>Certificate <span class="muted" style="font-weight:400;">(optional)</span></label>
      <div id="trnDrawerCurrentFile" class="lic-file-current" hidden></div>
      <div class="lic-file-choose-row">
        <input type="file" id="trnDrawerFileInput" accept=".pdf,.jpg,.jpeg,.png,.heic,.heif,application/pdf,image/*" style="display:none;">
        <button type="button" class="btn btn-sm" id="trnDrawerFileChooseBtn">Choose File</button>
        <span id="trnDrawerFileNameLabel" class="muted" style="font-size:0.82rem;">No file chosen</span>
      </div>
    </div>
    <div class="drawer-field">
      <label for="trnDrawerNotes">Notes</label>
      <textarea id="trnDrawerNotes" rows="2">${esc(t.notes ?? '')}</textarea>
    </div>
    <div id="trnDrawerMsg" style="font-size:13px;color:var(--danger);min-height:18px;"></div>
  `;

  document.getElementById('trnStaffSearch')?.addEventListener('input', onTrainingStaffSearchInput);
  if (!editingTraining && selectedEmployee) renderSelectedEmployee();
  if (t.file_path) showAdminTrainingCurrentFile(t);

  document.getElementById('trnDrawerFileChooseBtn')?.addEventListener('click', () => {
    document.getElementById('trnDrawerFileInput')?.click();
  });
  document.getElementById('trnDrawerFileInput')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    const label = document.getElementById('trnDrawerFileNameLabel');
    if (label && file) label.textContent = file.name;
  });
}

const TRN_FILE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

async function showAdminTrainingCurrentFile(t) {
  const current = document.getElementById('trnDrawerCurrentFile');
  if (!current) return;
  const { data: signed } = await supabase.storage.from('training-files').createSignedUrl(t.file_path, 3600);
  // Re-checked after the await -- switching to a different row while the
  // signed URL is in flight would otherwise paint it into the wrong drawer.
  if (editingTraining?.id !== t.id) return;
  current.hidden = false;
  current.innerHTML =
    TRN_FILE_SVG +
    `<a href="${esc(signed?.signedUrl ?? '#')}" target="_blank" rel="noopener">${esc(t.file_name ?? 'Attached file')}</a>`;
}

function onTrainingStaffSearchInput() {
  clearTimeout(trnStaffSearchTimer);
  trnStaffSearchTimer = setTimeout(searchTrainingStaff, 280);
}

async function searchTrainingStaff() {
  const term = document.getElementById('trnStaffSearch')?.value.trim();
  const resultsEl = document.getElementById('trnStaffResults');
  if (!resultsEl) return;

  if (!term || term.length < 2) { resultsEl.innerHTML = ''; return; }

  const { data, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`)
    .order('last_name')
    .limit(10);

  if (error) { resultsEl.innerHTML = `<div style="padding:10px;color:var(--danger);font-size:13px;">Search failed.</div>`; return; }
  if (!data?.length) { resultsEl.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:13px;">No staff found.</div>'; return; }

  resultsEl.innerHTML = '';
  data.forEach(e => {
    const div = document.createElement('div');
    div.style.cssText = 'padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px;';
    div.textContent = `${e.first_name} ${e.last_name}`;
    div.addEventListener('click', () => {
      selectedEmployee = { id: e.id, name: `${e.first_name} ${e.last_name}` };
      document.getElementById('trnStaffSearch').value = '';
      resultsEl.innerHTML = '';
      renderSelectedEmployee();
    });
    resultsEl.appendChild(div);
  });
}

function renderSelectedEmployee() {
  const wrap = document.getElementById('trnStaffSelected');
  if (!wrap) return;
  wrap.innerHTML = selectedEmployee
    ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#f9fafb;border:1px solid var(--border);border-radius:8px;font-size:13px;"><span>${esc(selectedEmployee.name)}</span><button type="button" class="btn btn-sm" id="trnClearStaffBtn">Change</button></div>`
    : '';
  document.getElementById('trnClearStaffBtn')?.addEventListener('click', () => {
    selectedEmployee = null;
    renderSelectedEmployee();
  });
}

async function saveTraining() {
  const msgEl = document.getElementById('trnDrawerMsg');
  const employeeId = editingTraining ? editingTraining.employee_id : selectedEmployee?.id;

  if (!employeeId) { msgEl.textContent = 'Select an employee.'; return; }

  const trainingName = document.getElementById('trnDrawerName')?.value.trim();
  if (!trainingName) { msgEl.textContent = 'Training name is required.'; return; }

  const completedDate = document.getElementById('trnDrawerCompleted')?.value;
  if (!completedDate) { msgEl.textContent = 'Completed date is required.'; return; }

  const payload = {
    employee_id:    employeeId,
    training_name:  trainingName,
    provider:       document.getElementById('trnDrawerProvider')?.value.trim() || null,
    completed_date: completedDate,
    expires_date:   document.getElementById('trnDrawerExpires')?.value || null,
    duration_hours: trainingDurationInHours(),
    verified:       document.getElementById('trnDrawerVerified')?.checked ?? false,
    notes:          document.getElementById('trnDrawerNotes')?.value.trim() || null,
  };

  if (payload.verified && !editingTraining?.verified) {
    payload.verified_by = _profile.user_id;
    payload.verified_at = new Date().toISOString();
  } else if (!payload.verified) {
    payload.verified_by = null;
    payload.verified_at = null;
  }

  const saveBtn = document.getElementById('trnDrawerSave');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';

  let trainingId;
  if (editingTraining) {
    const { error } = await supabase.from('staff_required_training').update(payload).eq('id', editingTraining.id).eq('school_id', _profile.school_id);
    saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    if (error) { msgEl.textContent = `Save failed: ${esc(error.message)}`; return; }
    trainingId = editingTraining.id;
  } else {
    payload.school_id = _profile.school_id;
    payload.created_by = _profile.user_id;
    const { data, error } = await supabase.from('staff_required_training').insert(payload).select().single();
    saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
    if (error) { msgEl.textContent = `Save failed: ${esc(error.message)}`; return; }
    trainingId = data.id;
  }

  const fileInput = document.getElementById('trnDrawerFileInput');
  if (fileInput?.files?.length) {
    await uploadTrainingFile(trainingId, fileInput.files[0]);
  }

  closeDrawer();
  showToast(editingTraining ? 'Training record updated' : 'Training record added');
  editingTraining = null;
  selectedEmployee = null;
  await loadTraining();
}

async function uploadTrainingFile(trainingId, file) {
  const ts       = Date.now();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path     = `${_profile.school_id}/${trainingId}/${ts}-${safeName}`;

  const { error: uploadError } = await supabase.storage.from('training-files').upload(path, file, { upsert: false });
  if (uploadError) { showToast('File upload failed: ' + uploadError.message, 'error'); return; }

  const { error: linkError } = await supabase.from('staff_required_training')
    .update({ file_path: path, file_name: file.name })
    .eq('id', trainingId);
  if (linkError) showToast('File uploaded, but attaching it to the record failed: ' + linkError.message, 'error');
}

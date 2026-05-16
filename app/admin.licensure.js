import { supabase } from './admin.supabase.js';
import { initUserMenu } from './user-menu.js';
import { debounce } from './admin.shared.js';

/* ─────────────────────────────────────────────────────
   STATE
───────────────────────────────────────────────────── */
let currentProfile = null;
let campusLookup   = {};
let employeeLookup = {};  // id → "Last, First"
let allLicenses    = [];  // cached for export
let editingId      = null;

const PAGE_SIZE = 50;
let licPage  = 0;
let auditPage = 0;

/* Flatpickr instances */
let fpIssue = null;
let fpExp   = null;

/* ─────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────── */
async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) { window.location.href = '/login.html'; return; }

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', session.user.id)
    .single();

  if (!profile || (!profile.is_superadmin && !profile.can_manage_licensure)) {
    window.location.href = '/admin.html';
    return;
  }

  currentProfile = profile;
  initUserMenu(profile.display_name ?? profile.email);

  await Promise.all([loadCampuses(), loadEmployees()]);
  populateCampusSelects();
  populateStaffSelect();
  wireEvents();
  initDatePickers();

  await setView('compliance');
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

  await loadAlertList(day90, today);
}

async function loadAlertList(day90, today) {
  const { data } = await supabase
    .from('staff_licenses')
    .select('id, employee_id, license_type, license_area, expiration_date, status, alert_muted')
    .eq('school_id', currentProfile.school_id)
    .lte('expiration_date', day90)
    .order('expiration_date', { ascending: true })
    .limit(50);

  const list = document.getElementById('alertList');

  if (!data?.length) {
    list.innerHTML = '<div class="lic-empty">No licenses expiring in the next 90 days.</div>';
    return;
  }

  list.innerHTML = '';
  data.forEach(lic => {
    const daysLeft = daysBetween(today, lic.expiration_date);
    const isExpired = daysLeft < 0;
    const urgency = isExpired ? 'urgent' : daysLeft <= 30 ? 'urgent' : daysLeft <= 60 ? 'warn' : '';
    const daysLabel = isExpired
      ? `${Math.abs(daysLeft)}d overdue`
      : `${daysLeft}d remaining`;

    const row = document.createElement('div');
    row.className = `alert-row ${urgency}`;
    row.innerHTML = `
      <span class="alert-name">${employeeLookup[lic.employee_id] ?? '—'}</span>
      <span class="alert-type">${lic.license_type}${lic.license_area ? ' · ' + lic.license_area : ''}</span>
      <span class="alert-expiry">${formatDate(lic.expiration_date)}</span>
      <span class="alert-days ${urgency || 'caution'}">${daysLabel}</span>
      ${lic.alert_muted ? '<span class="muted-badge">Muted</span>' : ''}
    `;
    list.appendChild(row);
  });
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
    .select('*')
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
  if (error) { console.error(error); return; }

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
  renderLicenseTable(rows);
}

function renderLicenseTable(rows) {
  const tbody = document.getElementById('licenseTableBody');
  const today = new Date().toISOString().slice(0, 10);

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="lic-empty">No licenses found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  rows.forEach(lic => {
    const tr = document.createElement('tr');
    const daysLeft = lic.expiration_date ? daysBetween(today, lic.expiration_date) : null;

    tr.innerHTML = `
      <td>${employeeLookup[lic.employee_id] ?? '—'}</td>
      <td>${lic.license_number ?? '—'}</td>
      <td>${lic.license_type}${lic.license_class ? ` <small style="color:#6b7280;">(${lic.license_class})</small>` : ''}</td>
      <td>${lic.license_area ?? '—'}</td>
      <td>${lic.grade_authorization ?? '—'}</td>
      <td>${formatDate(lic.expiration_date)}${daysLeft !== null ? `<br><small style="color:${daysLeft < 0 ? '#dc2626' : daysLeft <= 30 ? '#dc2626' : daysLeft <= 60 ? '#ea580c' : '#9ca3af'}">${daysLeft < 0 ? Math.abs(daysLeft) + 'd overdue' : daysLeft + 'd'}</small>` : ''}</td>
      <td>${statusBadge(lic.status)}</td>
      <td>${lic.is_provisional ? '<span class="badge badge-provisional">Yes</span>' : '—'}</td>
      <td>${renewalBadge(lic.renewal_status)}</td>
      <td>${lic.verified ? '<span class="verified-check" title="Verified">✓</span>' : '<span class="unverified-x">—</span>'}</td>
      <td style="white-space:nowrap;">
        <button class="btn editLicBtn" data-id="${lic.id}">Edit</button>
        <button class="btn danger deleteLicBtn" data-id="${lic.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.editLicBtn').forEach(btn =>
    btn.addEventListener('click', () => openEditModal(btn.dataset.id))
  );
  tbody.querySelectorAll('.deleteLicBtn').forEach(btn =>
    btn.addEventListener('click', () => deleteLicense(btn.dataset.id))
  );
}

/* ─────────────────────────────────────────────────────
   AUDIT LOG TAB
───────────────────────────────────────────────────── */
async function loadAuditLog() {
  const search = document.getElementById('auditSearch')?.value.trim().toLowerCase() ?? '';

  const { data, error } = await supabase
    .from('staff_license_history')
    .select(`
      id, changed_at, change_type, field_changes,
      changed_by,
      staff_licenses ( employee_id )
    `)
    .eq('school_id', currentProfile.school_id)
    .order('changed_at', { ascending: false })
    .limit(200);

  if (error) { console.error(error); return; }

  let rows = data || [];

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

  const tbody = document.getElementById('auditTableBody');

  if (search) {
    rows = rows.filter(r => {
      const name = (employeeLookup[r.staff_licenses?.employee_id] ?? '').toLowerCase();
      const changer = (changerLookup[r.changed_by] ?? '').toLowerCase();
      return name.includes(search) || r.change_type.toLowerCase().includes(search) || changer.includes(search);
    });
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="lic-empty">No audit history yet.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  rows.forEach(r => {
    const employeeId = r.staff_licenses?.employee_id;
    const changerProfile = changerLookup[r.changed_by] ?? '—';
    const details = r.field_changes
      ? Object.entries(r.field_changes)
          .map(([k, v]) => `${k}: ${v.old ?? '—'} → ${v.new ?? '—'}`)
          .join(', ')
      : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${formatDateTime(r.changed_at)}</td>
      <td>${employeeLookup[employeeId] ?? '—'}</td>
      <td><span class="badge badge-${changeTypeBadge(r.change_type)}">${r.change_type}</span></td>
      <td>${changerProfile}</td>
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
  document.getElementById('licenseModalTitle').textContent = 'Add License';
  document.getElementById('staffSelectRow').style.display = '';
  document.getElementById('saveLicenseBtn').textContent = 'Save License';
  resetForm();
  window.openDrawer?.('licenseDrawer');
}

function openEditModal(id) {
  const lic = allLicenses.find(l => l.id === id);
  if (!lic) return;

  editingId = id;
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
async function saveLicense() {
  const isEdit   = !!editingId;
  const schoolId = currentProfile.school_id;

  const employeeId = isEdit
    ? allLicenses.find(l => l.id === editingId)?.employee_id
    : document.getElementById('licStaff').value;

  if (!employeeId) { alert('Please select a staff member.'); return; }

  const licType = document.getElementById('licType').value;
  if (!licType) { alert('License type is required.'); return; }

  const expDate = document.getElementById('licExpDate').value;
  if (!expDate) { alert('Expiration date is required.'); return; }

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

  let licenseId;

  if (isEdit) {
    const old = allLicenses.find(l => l.id === editingId);
    const changes = diffObjects(old, payload);
    const { error } = await supabase.from('staff_licenses').update(payload).eq('id', editingId);
    if (error) { console.error(error); alert('Failed to save license.'); return; }

    // When expiration_date changes (renewal), clear the alert log so the new
    // expiration cycle sends fresh threshold alerts.
    if (old?.expiration_date !== payload.expiration_date) {
      await supabase.from('license_alert_log').delete().eq('license_id', editingId);
    }

    if (Object.keys(changes).length) {
      await writeHistory(editingId, schoolId, 'updated', changes);
    }
    licenseId = editingId;
  } else {
    payload.created_by = currentProfile.user_id;
    const { data, error } = await supabase.from('staff_licenses').insert(payload).select().single();
    if (error) { console.error(error); alert('Failed to save license.'); return; }
    await writeHistory(data.id, schoolId, 'created', null);
    licenseId = data.id;
  }

  // Upload file if one was selected
  const fileInput = document.getElementById('licFileInput');
  if (fileInput?.files?.length) {
    await uploadLicenseFile(licenseId, fileInput.files[0]);
  }

  window.closeDrawer?.('licenseDrawer');
  await loadLicenses();
}

async function deleteLicense(id) {
  if (!confirm('Delete this license record? This cannot be undone.')) return;
  const lic = allLicenses.find(l => l.id === id);
  if (lic) await writeHistory(id, currentProfile.school_id, 'deleted', null);
  const { error } = await supabase.from('staff_licenses').delete().eq('id', id);
  if (error) { console.error(error); alert('Failed to delete license.'); return; }
  await loadLicenses();
}

async function writeHistory(licenseId, schoolId, changeType, fieldChanges) {
  await supabase.from('staff_license_history').insert({
    license_id:    licenseId,
    school_id:     schoolId,
    changed_by:    currentProfile.user_id,
    change_type:   changeType,
    field_changes: fieldChanges,
  });
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
    alert('File upload failed: ' + uploadError.message);
    return;
  }

  // Mark any existing files as no longer current
  await supabase
    .from('staff_license_files')
    .update({ is_current: false })
    .eq('license_id', licenseId);

  // Record the new file
  await supabase.from('staff_license_files').insert({
    license_id:  licenseId,
    school_id:   currentProfile.school_id,
    file_path:   path,
    file_name:   file.name,
    uploaded_by: currentProfile.user_id,
    is_current:  true,
  });
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
   EXPORT
───────────────────────────────────────────────────── */
function exportLicenses() {
  if (!allLicenses.length) { alert('No licenses to export.'); return; }

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

  if (view === 'compliance') await loadCompliance();
  if (view === 'licenses')   await loadLicenses();
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
    const isFilter = id === 'licCampusFilter';
    sel.innerHTML = isFilter ? '<option value="">All campuses</option>' : '<option value="">All campuses</option>';
    entries.forEach(([cid, name]) => {
      const opt = document.createElement('option');
      opt.value = cid;
      opt.textContent = name;
      sel.appendChild(opt);
    });
  });
}

function populateStaffSelect() {
  const sel = document.getElementById('licStaff');
  if (!sel) return;
  sel.innerHTML = '<option value="">Select staff member…</option>';
  Object.entries(employeeLookup)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .forEach(([id, name]) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
    });
}

/* ─────────────────────────────────────────────────────
   DATE PICKERS
───────────────────────────────────────────────────── */
function initDatePickers() {
  fpIssue = flatpickr('#licIssueDate', { dateFormat: 'Y-m-d', allowInput: true });
  fpExp   = flatpickr('#licExpDate',   { dateFormat: 'Y-m-d', allowInput: true });
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

  // Hash-based routing on load
  window.addEventListener('hashchange', () => {
    const view = location.hash.replace('#', '') || 'compliance';
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

function showModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function hideModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
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

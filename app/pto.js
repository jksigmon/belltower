import { supabase } from '/app/admin.supabase.js';
import { initUserMenu } from '/app/user-menu.js';

/* =============================================
   STATE
============================================= */
let currentSchoolPtoTypes = [];
let lastPendingPtoCount = 0;
let lastCancelPtoCount = 0;
let currentPtoHistoryEmployeeId = null;
let rolloverReportData = [];
let committedRolloverMeta = null;
let staffListCache = null;
let policiesEmployees = [];
let policiesPolicyMap = {};
const ptoViewCache = new Set();
let ptoCalendar;
let reportsFlatpickrInitialized = false;

// Pending bulk selection
const selectedPendingIds = new Set();

// Denial modal callback
let _denyCallback = null;

/* =============================================
   AUTH
============================================= */
const { data: sessionData } = await supabase.auth.getSession();
if (!sessionData?.session) {
  window.location.href = '/login.html';
  throw new Error('No session');
}

const signOutBtn = document.getElementById('signOut');
if (signOutBtn) {
  signOutBtn.addEventListener('click', async () => {
    try {
      await supabase.auth.signOut();
      window.location.href = '/login.html';
    } catch (err) {
      console.error('Sign out failed', err);
    }
  });
}

/* =============================================
   PROFILE + MODULE CHECK
============================================= */
const { data: currentProfile, error: profErr } = await supabase
  .from('profiles')
  .select('*, schools!profiles_school_id_fkey(school_modules(module, enabled))')
  .eq('user_id', sessionData.session.user.id)
  .single();

if (profErr || !currentProfile) {
  alert('Profile load failed');
  throw profErr;
}

initUserMenu(currentProfile.display_name ?? currentProfile.email);

if (!currentProfile.can_view_pto_calendar) {
  document.getElementById('ptoTabCalendar')?.remove();
}

if (!currentProfile.can_approve_pto) {
  document.getElementById('ptoTabPending')?.remove();
  document.getElementById('ptoTabCancellations')?.remove();
}

if (!currentProfile.can_review_pto) {
  document.querySelector('#ptoTabs [data-view="history"]')?.remove();
}

if (!currentProfile.can_adjust_pto) {
  document.getElementById('ptoTabAdjust')?.remove();
  document.getElementById('ptoTabPolicies')?.remove();
}

if (!currentProfile.can_generate_pto_reports) {
  document.getElementById('ptoTabReports')?.remove();
}

const ptoTabsEl = document.querySelector('.pto-tabs');
if (ptoTabsEl) {
  ptoTabsEl.style.visibility = 'visible';
}

function hasAdminAccess(profile) {
  return (
    profile.is_superadmin === true ||
    profile.can_access_admin === true ||
    profile.can_manage_access === true ||
    profile.can_approve_pto === true ||
    profile.can_adjust_pto === true ||
    profile.can_bulk_upload === true
  );
}

const backToAdmin = document.getElementById('backToAdmin');
if (backToAdmin && hasAdminAccess(currentProfile)) {
  backToAdmin.style.visibility = 'visible';
}

/* =============================================
   MODULE GATE
============================================= */
const ptoModule = currentProfile.schools?.school_modules?.find(r => r.module === 'pto');
if (!ptoModule?.enabled) {
  alert('PTO is not enabled for your school.');
  window.location.href = '/admin.html';
  throw new Error('PTO disabled');
}

/* =============================================
   STARTUP
============================================= */
const startupLoads = [loadSchoolPtoTypes(), loadPtoRequestCounts()];
if (currentProfile.can_approve_pto) startupLoads.push(loadPto());
await Promise.all(startupLoads);
if (currentProfile.can_approve_pto) ptoViewCache.add('pending');

if (currentProfile.can_view_pto_calendar) {
  initPtoCalendar();
}

const staffSelect = document.getElementById('ptoStaffSelect');
const generateBtn = document.getElementById('generateExportBtn');

if (!currentProfile.can_generate_pto_reports) {
  generateBtn?.setAttribute('disabled', true);
}

if (generateBtn) {
  generateBtn.addEventListener('click', handlePtoExport);
}

if (staffSelect) {
  staffSelect.addEventListener('change', e => {
    const employeeId = e.target.value;
    if (employeeId === currentPtoHistoryEmployeeId) return;
    currentPtoHistoryEmployeeId = employeeId;
    document.getElementById('ptoTypeFilter').value = '';
    refreshStaffHistory(employeeId);
  });
}

document.getElementById('ptoYearFilter')?.addEventListener('change', () => {
  refreshStaffHistory(currentPtoHistoryEmployeeId);
});

document.getElementById('ptoTypeFilter')?.addEventListener('change', () => {
  applyPtoTypeFilter();
});

document.getElementById('historyExportBtn')?.addEventListener('click', () => {
  const sel = document.getElementById('ptoStaffSelect');
  const name = sel?.options[sel.selectedIndex]?.text ?? '';
  exportHistoryToCsv(currentPtoHistoryEmployeeId, name);
});

document.getElementById('historyAdjustBtn')?.addEventListener('click', async () => {
  await setPtoView('adjust');
  const adjustSel = document.getElementById('ptoAdjustStaff');
  if (adjustSel && currentPtoHistoryEmployeeId) {
    adjustSel.value = currentPtoHistoryEmployeeId;
    adjustSel.dispatchEvent(new Event('change'));
  }
});

document.getElementById('ledgerToggleBtn')?.addEventListener('click', () => {
  const content = document.getElementById('ledgerContent');
  const icon = document.getElementById('ledgerChevronIcon');
  const open = !content.hidden;
  content.hidden = open;
  if (icon) icon.style.transform = open ? '' : 'rotate(90deg)';
});

/* =============================================
   DENIAL MODAL
============================================= */
function openDenyModal(title, info, onSubmit) {
  document.getElementById('ptoDenyTitle').textContent = title;
  document.getElementById('ptoDenyInfo').textContent = info;
  document.getElementById('ptoDenyReason').value = '';
  _denyCallback = onSubmit;
  document.getElementById('ptoDenyModal').hidden = false;
  setTimeout(() => document.getElementById('ptoDenyReason').focus(), 50);
}

function closeDenyModal() {
  document.getElementById('ptoDenyModal').hidden = true;
  _denyCallback = null;
}

document.getElementById('ptoDenyCancel').addEventListener('click', closeDenyModal);

document.getElementById('ptoDenyConfirm').addEventListener('click', async () => {
  const reason = document.getElementById('ptoDenyReason').value.trim();
  if (!reason) {
    document.getElementById('ptoDenyReason').focus();
    return;
  }
  const btn = document.getElementById('ptoDenyConfirm');
  btn.disabled = true;
  btn.textContent = 'Denying…';
  await _denyCallback?.(reason);
  btn.disabled = false;
  btn.textContent = 'Deny';
  closeDenyModal();
});

/* =============================================
   BULK APPROVE (PENDING)
============================================= */
function updatePendingBulkBar() {
  const bar = document.getElementById('ptoBulkBar');
  const countEl = document.getElementById('ptoBulkCount');
  if (!bar) return;
  const count = selectedPendingIds.size;
  bar.hidden = count === 0;
  if (countEl) countEl.textContent = `${count} selected`;
}

function clearPendingSelection() {
  selectedPendingIds.clear();
  document.querySelectorAll('#ptoTable .pto-row-check').forEach(cb => { cb.checked = false; });
  const sa = document.getElementById('ptoPendingSelectAll');
  if (sa) { sa.checked = false; sa.indeterminate = false; }
  updatePendingBulkBar();
}

async function bulkApprovePending() {
  if (!selectedPendingIds.size) return;
  const ids = [...selectedPendingIds];
  if (!confirm(`Approve ${ids.length} PTO request${ids.length !== 1 ? 's' : ''}?`)) return;

  const { error } = await supabase
    .from('pto_requests')
    .update({
      status: 'APPROVED',
      decided_at: new Date().toISOString(),
      decided_by: currentProfile.employee_id
    })
    .in('id', ids)
    .eq('school_id', currentProfile.school_id);

  if (error) {
    console.error(error);
    alert('Failed to approve requests.');
    return;
  }

  clearPendingSelection();
  await loadPtoRequestCounts();
  loadPto();
  ptoCalendar?.refetchEvents();
}

document.getElementById('ptoBulkApprove')?.addEventListener('click', bulkApprovePending);
document.getElementById('ptoBulkClear')?.addEventListener('click', clearPendingSelection);

/* =============================================
   UTILITY FUNCTIONS
============================================= */
function refreshStaffHistory(employeeId) {
  resetStaffHistoryView();
  if (employeeId) {
    loadStaffPtoHistory(employeeId);
    loadStaffPtoLedger(employeeId);
    loadPtoHistoryBalances(employeeId);
    document.getElementById('historyActionsWrap').hidden = false;
  } else {
    document.getElementById('historyActionsWrap').hidden = true;
  }
}

function formatTime(t) {
  if (!t) return '';
  return new Date(`1970-01-01T${t}`).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function formatHoursWithTime(r) {
  const hours = Number(r.requested_hours ?? 0);
  if (!hours) return '—';
  if (r.start_time && r.end_time) {
    return `${hours} hrs (${formatTime(r.start_time)}–${formatTime(r.end_time)})`;
  }
  if (r.requested_duration_label === 'Half Day') {
    return `Half Day (${hours} hrs)`;
  }
  return `${hours} hrs`;
}

function showPtoHistoryBalances(show) {
  // legacy shim — stats row visibility now managed via loadPtoHistoryBalances / resetStaffHistoryView
}

function ptoBadge(type) {
  const map = {
    VACATION:     'badge-pto-vacation',
    SICK:         'badge-pto-sick',
    PERSONAL:     'badge-pto-personal',
    PROFESSIONAL: 'badge-pto-professional',
  };
  const cls = map[type] ?? 'badge-pto-other';
  const label = type.charAt(0) + type.slice(1).toLowerCase();
  return `<span class="pto-type-badge ${cls}">${label}</span>`;
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

function humanizeReason(reason) {
  if (!reason) return '—';
  const allot = reason.match(/^ANNUAL_ALLOTMENT_(\d+)$/);
  if (allot) return `Annual Allotment (${allot[1]})`;
  const manual = reason.match(/^MANUAL_ADJUSTMENT_(\d+)(?::\s*(.*))?$/);
  if (manual) return `Manual Adjustment (${manual[1]})${manual[2] ? ': ' + manual[2] : ''}`;
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function populateYearFilter() {
  const sel = document.getElementById('ptoYearFilter');
  if (!sel) return;
  const cur = new Date().getFullYear();
  sel.innerHTML = '<option value="">All Years</option>';
  for (let y = cur; y >= cur - 4; y--) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === cur) opt.selected = true;
    sel.appendChild(opt);
  }
}

function populatePtoTypeFilter() {
  const sel = document.getElementById('ptoTypeFilter');
  if (!sel) return;
  sel.innerHTML = '<option value="">All Types</option>';
  currentSchoolPtoTypes.forEach(type => {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = type.charAt(0) + type.slice(1).toLowerCase();
    sel.appendChild(opt);
  });
}

function applyPtoTypeFilter() {
  const type = document.getElementById('ptoTypeFilter')?.value ?? '';
  const rows = document.querySelectorAll('#ptoHistoryAdminTable tbody tr');
  rows.forEach(tr => {
    const badge = tr.querySelector('.pto-type-badge');
    const rowType = badge?.dataset.type ?? '';
    tr.style.display = (!type || rowType === type) ? '' : 'none';
  });
}

function exportHistoryToCsv(employeeId, employeeName) {
  const tbody = document.querySelector('#ptoHistoryAdminTable tbody');
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll('tr'));
  if (!rows.length) return;
  const lines = [['Type', 'Dates', 'Hours', 'Status', 'Notes', 'Submitted']];
  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    lines.push([
      cells[0]?.querySelector('.pto-type-badge')?.textContent?.trim() ?? '',
      cells[1]?.textContent?.trim() ?? '',
      cells[2]?.textContent?.trim() ?? '',
      cells[3]?.innerText?.replace(/\s+/g, ' ').trim() ?? '',
      cells[4]?.textContent?.trim() ?? '',
      cells[5]?.textContent?.trim() ?? '',
    ]);
  });
  const csv = lines.map(r =>
    r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pto_history_${(employeeName || employeeId || 'export').replace(/\s+/g, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* =============================================
   PTO TYPES
============================================= */
async function loadSchoolPtoTypes() {
  const { data, error } = await supabase
    .from('school_pto_types')
    .select('pto_type')
    .eq('school_id', currentProfile.school_id)
    .eq('enabled', true);

  if (error) {
    console.error('Failed to load PTO types:', error);
    return;
  }
  currentSchoolPtoTypes = data.map(r => r.pto_type);
}

/* =============================================
   PENDING PTO TABLE
============================================= */
async function loadPto() {
  const tbody = document.querySelector('#ptoTable tbody');
  const emptyState = document.getElementById('pendingEmpty');
  if (!currentProfile.can_approve_pto) return;
  if (!tbody) return;

  clearPendingSelection();
  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('pto_requests')
    .select(`
      id,
      pto_type,
      start_date,
      end_date,
      requested_hours,
      requested_duration_label,
      start_time,
      end_time,
      notes,
      status,
      employees!pto_requests_employee_id_fkey (
        first_name,
        last_name
      )
    `)
    .eq('status', 'PENDING')
    .eq('school_id', currentProfile.school_id)
    .order('submitted_at', { ascending: true })
    .limit(50);

  if (error) {
    console.error(error);
    if (emptyState) emptyState.hidden = false;
    return;
  }

  if (!data || data.length === 0) {
    if (emptyState) emptyState.hidden = false;
    return;
  }

  if (emptyState) emptyState.hidden = true;

  data.forEach(r => {
    const emp = r.employees
      ? `${r.employees.first_name} ${r.employees.last_name}`
      : '';

    const dates =
      r.start_date === r.end_date
        ? r.start_date
        : `${r.start_date} → ${r.end_date}`;

    const hoursText = formatHoursWithTime(r);
    const notesText = r.notes ? r.notes : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pto-cell-check">
        <input type="checkbox" class="pto-row-check" data-id="${r.id}" aria-label="Select row" />
      </td>
      <td>${emp}</td>
      <td>${r.pto_type}</td>
      <td>${dates}</td>
      <td>${hoursText}</td>
      <td>${notesText}</td>
      <td>${r.status}</td>
      <td>
        <span class="action-buttons">
          <button class="btn btn-approve">Approve</button>
          <button class="btn btn-deny">Deny</button>
        </span>
      </td>
    `;

    tr.querySelector('.pto-row-check').addEventListener('change', e => {
      if (e.target.checked) {
        selectedPendingIds.add(r.id);
      } else {
        selectedPendingIds.delete(r.id);
      }
      // Update select-all indeterminate state
      const sa = document.getElementById('ptoPendingSelectAll');
      if (sa) {
        const total = document.querySelectorAll('#ptoTable .pto-row-check').length;
        sa.checked = selectedPendingIds.size === total;
        sa.indeterminate = selectedPendingIds.size > 0 && selectedPendingIds.size < total;
      }
      updatePendingBulkBar();
    });

    tr.querySelector('.btn-approve').addEventListener('click', () => {
      if (!currentProfile.can_approve_pto) {
        alert('You are not authorized to approve PTO requests.');
        return;
      }
      updatePtoStatus(r.id, 'APPROVED');
    });

    tr.querySelector('.btn-deny').addEventListener('click', () => {
      denyInitialPto(r);
    });

    tbody.appendChild(tr);
  });

  // Wire select-all
  const sa = document.getElementById('ptoPendingSelectAll');
  if (sa) {
    sa.checked = false;
    sa.indeterminate = false;
    sa.onchange = () => {
      document.querySelectorAll('#ptoTable .pto-row-check').forEach(cb => {
        cb.checked = sa.checked;
        if (sa.checked) {
          selectedPendingIds.add(cb.dataset.id);
        } else {
          selectedPendingIds.delete(cb.dataset.id);
        }
      });
      updatePendingBulkBar();
    };
  }
}

/* =============================================
   CANCELLATIONS TABLE
============================================= */
async function loadPtoCancellationRequests() {
  if (!currentProfile.can_approve_pto) return;

  const tbody = document.querySelector('#ptoCancelTable tbody');
  const emptyState = document.getElementById('cancellationsEmpty');
  if (!tbody) return;

  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('pto_requests')
    .select(`
      id,
      pto_type,
      start_date,
      end_date,
      requested_hours,
      requested_duration_label,
      start_time,
      end_time,
      notes,
      status,
      employees!pto_requests_employee_id_fkey (
        first_name,
        last_name
      )
    `)
    .in('status', ['CANCEL_REQUESTED', 'RESCIND_REQUESTED'])
    .eq('school_id', currentProfile.school_id)
    .order('submitted_at', { ascending: true });

  if (error) {
    console.error(error);
    if (emptyState) emptyState.hidden = false;
    return;
  }

  if (!data || data.length === 0) {
    if (emptyState) emptyState.hidden = false;
    return;
  }

  if (emptyState) emptyState.hidden = true;

  data.forEach(r => {
    const emp = r.employees
      ? `${r.employees.first_name} ${r.employees.last_name}`
      : '';

    const dates =
      r.start_date === r.end_date
        ? r.start_date
        : `${r.start_date} → ${r.end_date}`;

    const hoursText = formatHoursWithTime(r);
    const notesText = r.notes || '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${emp}</td>
      <td>${r.pto_type}</td>
      <td>${dates}</td>
      <td>${hoursText}</td>
      <td>
        ${renderCancelBadge(r.status, r.start_date)}
        <div class="muted">${notesText}</div>
      </td>
      <td class="status warn">
        ${formatStatus(r.status)}
      </td>
      <td>
        <span class="action-buttons">
          <button class="btn btn-approve">
            ${r.status === 'RESCIND_REQUESTED' ? 'Approve Rescind' : 'Approve Cancel'}
          </button>
          <button class="btn btn-deny">
            ${r.status === 'RESCIND_REQUESTED' ? 'Deny Rescind' : 'Deny Cancel'}
          </button>
        </span>
      </td>
    `;

    tr.querySelector('.btn-approve').addEventListener('click', () => {
      if (!currentProfile.can_approve_pto) {
        alert('You are not authorized to approve PTO cancellations.');
        return;
      }
      approveCancellation(r);
    });

    tr.querySelector('.btn-deny').addEventListener('click', () => {
      if (!currentProfile.can_approve_pto) {
        alert('You are not authorized to deny PTO cancellations.');
        return;
      }
      denyCancellation(r);
    });

    tbody.appendChild(tr);
  });
}

function renderCancelBadge(status, startDate) {
  if (status === 'RESCIND_REQUESTED') {
    return '<span class="badge badge-warn">Rescind (Past PTO)</span>';
  }
  return '<span class="badge badge-muted">Future Cancel</span>';
}

function formatStatus(status) {
  switch (status) {
    case 'RESCIND_REQUESTED': return 'Rescind Requested';
    case 'RESCINDED':         return 'Rescinded';
    case 'CANCEL_REQUESTED':  return 'Cancel Requested';
    default:                  return status.replace('_', ' ');
  }
}

/* =============================================
   APPROVE / DENY ACTIONS
============================================= */
async function approveCancellation(r) {
  if (!currentProfile.can_approve_pto) {
    alert('You are not authorized to approve PTO cancellations.');
    return;
  }

  if (r.status === 'RESCIND_REQUESTED') {
    const confirmed = confirm(
      `Approve PTO Rescind?\n\nThis PTO was approved for past dates.\nBy approving this rescind, you confirm that the employee did NOT take this time off.\n\n✔ PTO hours will be credited back\n✔ Ledger and balance will be updated\n✔ This action is audit-logged`
    );
    if (!confirmed) return;
  } else {
    if (!confirm('Approve this PTO cancellation and credit time back?')) return;
  }

  const { error } = await supabase
    .from('pto_requests')
    .update({
      status: r.status === 'RESCIND_REQUESTED' ? 'RESCINDED' : 'CANCELLED',
      decided_at: new Date().toISOString(),
      decided_by: currentProfile.employee_id
    })
    .eq('id', r.id);

  if (error) {
    console.error(error);
    alert('Failed to approve cancellation.');
    return;
  }

  await loadPtoRequestCounts();
  loadPto();
  loadPtoCancellationRequests();
  ptoCalendar?.refetchEvents();
}

function denyInitialPto(r) {
  if (!currentProfile.can_approve_pto) {
    alert('You are not authorized to deny PTO requests.');
    return;
  }

  const emp = r.employees
    ? `${r.employees.first_name} ${r.employees.last_name}`
    : '';
  const dateRange = r.start_date === r.end_date
    ? r.start_date
    : `${r.start_date} → ${r.end_date}`;

  openDenyModal(
    'Deny PTO Request',
    `${emp} — ${r.pto_type} (${dateRange})`,
    async (reason) => {
      const updatedNotes = r.notes
        ? `${r.notes}\n\n[DENIED]: ${reason}`
        : `[DENIED]: ${reason}`;

      const { error } = await supabase
        .from('pto_requests')
        .update({
          status: 'DENIED',
          notes: updatedNotes,
          decided_at: new Date().toISOString(),
          decided_by: currentProfile.employee_id
        })
        .eq('id', r.id);

      if (error) {
        console.error(error);
        alert('Failed to deny PTO request.');
        return;
      }

      await loadPtoRequestCounts();
      loadPto();
      ptoCalendar?.refetchEvents();
    }
  );
}

function denyCancellation(r) {
  if (!currentProfile.can_approve_pto) {
    alert('You are not authorized to deny PTO requests.');
    return;
  }

  const emp = r.employees
    ? `${r.employees.first_name} ${r.employees.last_name}`
    : '';
  const dateRange = r.start_date === r.end_date
    ? r.start_date
    : `${r.start_date} → ${r.end_date}`;

  const isRescind = r.status === 'RESCIND_REQUESTED';
  const title     = isRescind ? 'Deny Rescind Request' : 'Deny Cancellation Request';
  const noteLabel = isRescind ? 'RESCIND DENIED' : 'CANCEL DENIED';

  openDenyModal(
    title,
    `${emp} — ${r.pto_type} (${dateRange})`,
    async (reason) => {
      const updatedNotes = r.notes
        ? `${r.notes}\n\n[${noteLabel}]: ${reason}`
        : `[${noteLabel}]: ${reason}`;

      const { error } = await supabase
        .from('pto_requests')
        .update({
          status: 'APPROVED',
          notes: updatedNotes,
          decided_at: new Date().toISOString(),
          decided_by: currentProfile.employee_id
        })
        .eq('id', r.id);

      if (error) {
        console.error(error);
        alert('Failed to deny request.');
        return;
      }

      await loadPtoRequestCounts();
      loadPto();
      loadPtoCancellationRequests();
      ptoCalendar?.refetchEvents();
    }
  );
}

async function updatePtoStatus(requestId, newStatus) {
  if (!currentProfile.can_approve_pto) {
    alert('You are not authorized to approve or deny PTO requests.');
    return;
  }

  const confirmMsg =
    newStatus === 'APPROVED'
      ? 'Approve this PTO request?'
      : 'Deny this PTO request?';

  if (!confirm(confirmMsg)) return;

  const { error } = await supabase
    .from('pto_requests')
    .update({
      status: newStatus,
      decided_at: new Date().toISOString(),
      decided_by: currentProfile.employee_id
    })
    .eq('id', requestId);

  if (error) {
    console.error(error);
    alert('Failed to update PTO request.');
    return;
  }

  await loadPtoRequestCounts();
  loadPto();
  ptoCalendar?.refetchEvents();
}

/* =============================================
   STAFF LIST / OPTIONS
============================================= */
async function loadStaffList() {
  if (!staffListCache) {
    const { data, error } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('school_id', currentProfile.school_id)
      .eq('active', true)
      .order('last_name');
    if (error) { console.error('Failed to load staff list:', error); return []; }
    staffListCache = data || [];
  }
  return staffListCache;
}

async function loadPtoStaffOptions() {
  const select = document.getElementById('ptoStaffSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Select staff member…</option>';
  const data = await loadStaffList();
  data.forEach(emp => {
    const opt = document.createElement('option');
    opt.value = emp.id;
    opt.textContent = `${emp.last_name}, ${emp.first_name}`;
    select.appendChild(opt);
  });
}

/* =============================================
   REQUEST COUNTS / BADGES
============================================= */
async function loadPtoRequestCounts() {
  if (!currentProfile.can_approve_pto) return;

  const schoolId = currentProfile.school_id;

  const [{ count: pendingCount }, { count: cancelCount }] = await Promise.all([
    supabase.from('pto_requests')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .eq('status', 'PENDING'),
    supabase.from('pto_requests')
      .select('id', { count: 'exact', head: true })
      .eq('school_id', schoolId)
      .in('status', ['CANCEL_REQUESTED', 'RESCIND_REQUESTED'])
  ]);

  updateTabBadge('pendingCount', pendingCount);
  updateTabBadge('cancelCount', cancelCount);
}

function updateTabBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = (count && count > 0) ? count : '';
}

/* =============================================
   HISTORY BALANCES
============================================= */
async function loadPtoHistoryBalances(employeeId) {
  const chips = document.getElementById('historyBalanceChips');
  const statsRow = document.getElementById('historyStatsRow');
  if (!chips) return;

  chips.innerHTML = '';

  if (!employeeId) {
    if (statsRow) statsRow.hidden = true;
    return;
  }

  const { data, error } = await supabase
    .from('pto_balances')
    .select('pto_type, balance_hours')
    .eq('employee_id', employeeId);

  if (statsRow) statsRow.hidden = false;
  if (error || !data || data.length === 0) return;

  data.forEach(b => {
    const chip = document.createElement('div');
    chip.className = 'balance-chip';
    const low = b.balance_hours < 8;
    chip.innerHTML = `
      <div class="balance-chip-label">${b.pto_type.charAt(0)+b.pto_type.slice(1).toLowerCase()}</div>
      <div class="balance-chip-value${low ? ' warn' : ''}">${b.balance_hours} hrs</div>
    `;
    chips.appendChild(chip);
  });
}

async function loadStaffPtoBalances(employeeId) {
  const container = document.getElementById('ptoBalancesAdmin');
  container.innerHTML = '';
  if (!employeeId) return;

  const { data, error } = await supabase
    .from('pto_balances')
    .select('pto_type, balance_hours')
    .eq('school_id', currentProfile.school_id)
    .eq('employee_id', employeeId);

  if (error) {
    console.error('Failed to load PTO balances:', error);
    return;
  }

  const balanceMap = {};
  data.forEach(b => { balanceMap[b.pto_type] = b.balance_hours; });

  currentSchoolPtoTypes.forEach(type => {
    const hours = balanceMap[type] ?? 0;
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="muted">${type}</div>
      <div style="font-size:18px;">${hours} hrs</div>
    `;
    container.appendChild(div);
  });
}

async function getCurrentPtoBalanceMap(employeeId) {
  const { data, error } = await supabase
    .from('pto_balances')
    .select('pto_type, balance_hours')
    .eq('school_id', currentProfile.school_id)
    .eq('employee_id', employeeId);

  if (error) {
    console.error('Failed to load current PTO balances:', error);
    return {};
  }

  const map = {};
  data.forEach(b => { map[b.pto_type] = b.balance_hours; });
  return map;
}

/* =============================================
   PTO HISTORY TABLE
============================================= */
async function loadStaffPtoHistory(employeeId) {
  const table = document.getElementById('ptoHistoryAdminTable');
  const tbody = table.querySelector('tbody');
  const emptyState = document.getElementById('ptoHistoryEmpty');
  if (!currentProfile.can_review_pto) return;
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!employeeId) {
    resetStaffHistoryView();
    return;
  }

  const year = document.getElementById('ptoYearFilter')?.value ?? '';

  let approvedUsed = 0;
  let cancelled = 0;
  let pending = 0;

  let ledgerQuery = supabase
    .from('pto_ledger')
    .select('delta_hours, reason')
    .eq('employee_id', employeeId);

  let histQuery = supabase
    .from('pto_requests')
    .select(`
      pto_type,
      start_date,
      end_date,
      partial_day,
      partial_hours,
      start_time,
      end_time,
      requested_hours,
      status,
      notes,
      submitted_at,
      decided_at,
      employees!pto_requests_decided_by_fkey(first_name, last_name)
    `)
    .eq('employee_id', employeeId)
    .order('submitted_at', { ascending: false });

  if (year) {
    ledgerQuery = ledgerQuery
      .gte('created_at', `${year}-01-01`)
      .lte('created_at', `${year}-12-31`);
    histQuery = histQuery
      .gte('start_date', `${year}-01-01`)
      .lte('start_date', `${year}-12-31`);
  }

  const [
    { data: ledger, error: ledgerError },
    { data, error }
  ] = await Promise.all([ledgerQuery, histQuery]);

  if (ledgerError) {
    console.error('Failed to load PTO ledger:', ledgerError);
    resetStaffHistoryView();
    return;
  }

  ledger.forEach(l => {
    if (l.reason === 'REQUEST APPROVED') approvedUsed += Math.abs(l.delta_hours);
    if (l.reason === 'REQUEST CANCELLED FUTURE') cancelled += l.delta_hours;
  });

  if (error) {
    console.error('Failed to load PTO history:', error);
    resetStaffHistoryView();
    return;
  }

  if (!data || data.length === 0) {
    table.style.display = 'none';
    emptyState.hidden = false;
  } else {
    table.style.display = '';
    emptyState.hidden = true;

    data.forEach(r => {
      const hours = Number(r.requested_hours ?? 0);
      if (r.status === 'PENDING') pending += hours;

      const dates = r.start_date === r.end_date
        ? fmtDate(r.start_date)
        : `${fmtDate(r.start_date)} – ${fmtDate(r.end_date)}`;

      let decisionHtml = '';

      if (r.status === 'PENDING') {
        decisionHtml = '<span class="status-pending">Pending</span>';
      } else if (r.status === 'APPROVED') {
        const name = r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : 'Admin';
        const date = r.decided_at ? fmtDate(r.decided_at.split('T')[0]) : '';
        decisionHtml = `<span class="ok">Approved</span><br><span class="muted">by ${name} • ${date}</span>`;
      } else if (r.status === 'DENIED') {
        const name = r.employees ? `${r.employees.first_name} ${r.employees.last_name}` : 'Admin';
        const date = r.decided_at ? fmtDate(r.decided_at.split('T')[0]) : '';
        decisionHtml = `<span class="err">Denied</span><br><span class="muted">by ${name} • ${date}</span>`;
      } else if (r.status === 'CANCELLED') {
        decisionHtml = `<span class="warn">Cancelled</span><br><span class="muted">by employee</span>`;
      }

      const typeMap = { VACATION: 'badge-pto-vacation', SICK: 'badge-pto-sick', PERSONAL: 'badge-pto-personal', PROFESSIONAL: 'badge-pto-professional' };
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><span class="pto-type-badge ${typeMap[r.pto_type] ?? 'badge-pto-other'}" data-type="${r.pto_type}">${r.pto_type.charAt(0)+r.pto_type.slice(1).toLowerCase()}</span></td>
        <td>${dates}</td>
        <td>${formatHoursWithTime(r)}</td>
        <td>${decisionHtml}</td>
        <td>${r.notes || '—'}</td>
        <td>${fmtDate(r.submitted_at?.split('T')[0])}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  const netUsed = approvedUsed - cancelled;
  document.getElementById('ptoSumApproved').textContent  = `${approvedUsed} hrs`;
  document.getElementById('ptoSumCancelled').textContent = `${cancelled} hrs`;
  document.getElementById('ptoSumPending').textContent   = `${pending} hrs`;
  document.getElementById('ptoSumNet').textContent       = `${netUsed} hrs`;

  applyPtoTypeFilter();
}

/* =============================================
   PTO LEDGER
============================================= */
async function loadStaffPtoLedger(employeeId) {
  const table = document.getElementById('ptoLedgerAdminTable');
  const tbody = table?.querySelector('tbody');
  const emptyState = document.getElementById('ptoLedgerEmpty');
  if (!currentProfile.can_review_pto) return;
  if (!tbody || !table) return;

  tbody.innerHTML = '';

  if (!employeeId) {
    table.style.display = 'none';
    if (emptyState) emptyState.hidden = false;
    return;
  }

  const year = document.getElementById('ptoYearFilter')?.value ?? '';

  let ledgerQuery = supabase
    .from('pto_ledger')
    .select('pto_type, delta_hours, reason, created_at')
    .eq('employee_id', employeeId)
    .order('created_at', { ascending: false });

  if (year) {
    ledgerQuery = ledgerQuery
      .gte('created_at', `${year}-01-01`)
      .lte('created_at', `${year}-12-31`);
  }

  const [balanceMap, { data: ledger, error }] = await Promise.all([
    getCurrentPtoBalanceMap(employeeId),
    ledgerQuery
  ]);

  if (error) {
    console.error('Failed to load PTO ledger:', error);
    table.style.display = 'none';
    if (emptyState) emptyState.hidden = false;
    return;
  }

  if (!ledger || ledger.length === 0) {
    table.style.display = 'none';
    if (emptyState) emptyState.hidden = false;
    return;
  }

  table.style.display = '';
  if (emptyState) emptyState.hidden = true;

  const runningBalance = { ...balanceMap };
  const typeMap = { VACATION: 'badge-pto-vacation', SICK: 'badge-pto-sick', PERSONAL: 'badge-pto-personal', PROFESSIONAL: 'badge-pto-professional' };

  ledger.forEach(entry => {
    const type = entry.pto_type;
    if (runningBalance[type] === undefined) runningBalance[type] = 0;

    const balanceAfter = runningBalance[type];
    const hoursClass = entry.delta_hours < 0 ? 'err' : 'ok';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="pto-type-badge ${typeMap[type] ?? 'badge-pto-other'}">${type.charAt(0)+type.slice(1).toLowerCase()}</span></td>
      <td class="${hoursClass}">${entry.delta_hours > 0 ? '+' : ''}${entry.delta_hours} hrs</td>
      <td>${humanizeReason(entry.reason)}</td>
      <td>${fmtDate(entry.created_at?.split('T')[0])}</td>
      <td>${balanceAfter.toFixed(2)} hrs</td>
    `;

    tbody.appendChild(tr);
    runningBalance[type] -= entry.delta_hours;
  });
}

/* =============================================
   ANNUAL PTO ALLOTMENT
============================================= */
async function applyAnnualPto(employeeId, ptoType, hours) {
  if (!currentProfile.can_adjust_pto) {
    alert('Not authorized');
    return;
  }

  const year = new Date().getFullYear();
  const reason = `ANNUAL_ALLOTMENT_${year}`;

  const { data: existing } = await supabase
    .from('pto_ledger')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('pto_type', ptoType)
    .eq('reason', reason)
    .limit(1);

  if (existing && existing.length > 0) {
    alert('Annual PTO has already been applied for this year.');
    return;
  }

  const { error } = await supabase
    .from('pto_ledger')
    .insert({
      school_id:   currentProfile.school_id,
      employee_id: employeeId,
      pto_type:    ptoType,
      delta_hours: hours,
      reason,
      created_by:  currentProfile.employee_id
    });

  if (error) {
    console.error(error);
    alert('Failed to apply annual PTO allotment.');
    return;
  }

  alert(`Annual PTO allotment (${hours} hrs) applied.`);
}

/* =============================================
   PTO POLICIES
============================================= */
async function loadPtoPolicies() {
  if (!currentProfile || !currentProfile.school_id) return;

  const tbody = document.querySelector('#ptoPoliciesTable tbody');
  const headerRow = document.getElementById('ptoPoliciesHeader');

  tbody.innerHTML = '';
  headerRow.innerHTML = '<th>Employee</th>';

  currentSchoolPtoTypes.forEach(type => {
    const th = document.createElement('th');
    th.textContent = type;
    headerRow.appendChild(th);
  });

  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, first_name, last_name, employment_months')
    .eq('school_id', currentProfile.school_id)
    .eq('active', true)
    .order('last_name');

  if (empErr || !employees?.length) return;

  const employeeIds = employees.map(e => e.id);
  const { data: allPolicies, error: polErr } = await supabase
    .from('employee_pto_policies')
    .select('employee_id, pto_type, annual_hours')
    .in('employee_id', employeeIds);

  if (polErr) return;

  const policyMap = {};
  (allPolicies || []).forEach(p => {
    if (!policyMap[p.employee_id]) policyMap[p.employee_id] = {};
    policyMap[p.employee_id][p.pto_type] = p.annual_hours;
  });

  policiesEmployees = employees || [];
  policiesPolicyMap = policyMap;

  const bulkTypeSelect = document.getElementById('policyBulkType');
  bulkTypeSelect.innerHTML = '<option value="">PTO type…</option>';
  currentSchoolPtoTypes.forEach(type => bulkTypeSelect.appendChild(new Option(type, type)));

  const distinctMonths = [...new Set(policiesEmployees.map(e => e.employment_months).filter(Boolean))].sort((a, b) => a - b);
  const bulkMonthsSelect = document.getElementById('policyBulkMonths');
  bulkMonthsSelect.innerHTML = '<option value="">All staff</option>';
  distinctMonths.forEach(m => bulkMonthsSelect.appendChild(new Option(`${m}-month`, m)));

  const bulkBar = document.getElementById('policiesBulkBar');
  bulkBar.style.display = 'flex';
  document.getElementById('policyBulkSetAll').addEventListener('click', () => bulkSetPolicies(false));
  document.getElementById('policyBulkFillBlank').addEventListener('click', () => bulkSetPolicies(true));

  employees.forEach(emp => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${emp.last_name}, ${emp.first_name}</td>`;

    currentSchoolPtoTypes.forEach(type => {
      const hours = policyMap[emp.id]?.[type] ?? '';
      const td = document.createElement('td');
      td.innerHTML = `
        <div class="pto-policy-cell">
          <input step="0.5" type="number" min="0" value="${hours}"
            class="pto-policy-input"
            data-employee="${emp.id}"
            data-type="${type}"
            ${currentProfile.can_adjust_pto ? '' : 'disabled'} />
          <span class="save-indicator"></span>
        </div>
      `;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

async function bulkSetPolicies(fillBlankOnly) {
  const ptoType = document.getElementById('policyBulkType').value;
  const hoursRaw = document.getElementById('policyBulkHours').value;
  const monthsFilter = document.getElementById('policyBulkMonths').value;
  const statusEl = document.getElementById('policyBulkStatus');

  if (!ptoType) { alert('Select a PTO type.'); return; }
  if (hoursRaw === '' || isNaN(Number(hoursRaw))) { alert('Enter a valid number of hours.'); return; }
  const hours = parseFloat(hoursRaw);
  if (hours < 0) { alert('Hours must be 0 or greater.'); return; }

  const eligible = policiesEmployees.filter(e => {
    if (monthsFilter && String(e.employment_months) !== String(monthsFilter)) return false;
    if (fillBlankOnly) {
      const existing = policiesPolicyMap[e.id]?.[ptoType];
      return existing === undefined || existing === null || existing === '';
    }
    return true;
  });

  if (eligible.length === 0) {
    statusEl.textContent = 'No matching employees.';
    setTimeout(() => { statusEl.textContent = ''; }, 3000);
    return;
  }

  statusEl.textContent = `Saving ${eligible.length} records…`;

  const { error } = await supabase
    .from('employee_pto_policies')
    .upsert(eligible.map(e => ({
      employee_id:  e.id,
      pto_type:     ptoType,
      annual_hours: hours
    })));

  if (error) {
    console.error('Bulk policy set failed:', error);
    statusEl.textContent = 'Failed to save.';
    return;
  }

  eligible.forEach(e => {
    if (!policiesPolicyMap[e.id]) policiesPolicyMap[e.id] = {};
    policiesPolicyMap[e.id][ptoType] = hours;
    const input = document.querySelector(
      `.pto-policy-input[data-employee="${e.id}"][data-type="${ptoType}"]`
    );
    if (input) input.value = hours;
  });

  const label = eligible.length === 1 ? '1 employee' : `${eligible.length} employees`;
  statusEl.textContent = `✓ Updated ${label}.`;
  setTimeout(() => { statusEl.textContent = ''; }, 3000);
}

async function promptForPtoType() {
  // This function is retained for legacy compatibility but is not used in primary flows.
  // Primary flows use dedicated UI dropdowns (#ptoAdjustType, #bulkAnnualPtoType).
  if (!currentSchoolPtoTypes || currentSchoolPtoTypes.length === 0) {
    alert('No PTO types are enabled for this school.');
    return null;
  }
  if (currentSchoolPtoTypes.length === 1) return currentSchoolPtoTypes[0];
  return null;
}

async function previewAnnualAllotments(employees, ptoType, year) {
  let willApply = 0;
  let willSkip = 0;

  for (const emp of employees) {
    if (!emp.annual_pto_hours || emp.annual_pto_hours <= 0) {
      willSkip++;
      continue;
    }

    const { data: existing } = await supabase
      .from('pto_ledger')
      .select('id')
      .eq('employee_id', emp.id)
      .eq('pto_type', ptoType)
      .eq('reason', `ANNUAL_ALLOTMENT_${year}`)
      .limit(1);

    if (existing && existing.length > 0) willSkip++;
    else willApply++;
  }

  return { willApply, willSkip };
}

async function applyAnnualAllotmentIfEligible(employee, ptoType, year) {
  if (!employee.annual_pto_hours || employee.annual_pto_hours <= 0) {
    return { skipped: true, reason: 'No annual PTO configured' };
  }

  const reason = `ANNUAL_ALLOTMENT_${year}`;

  const { data: existing } = await supabase
    .from('pto_ledger')
    .select('id')
    .eq('employee_id', employee.id)
    .eq('pto_type', ptoType)
    .eq('reason', reason)
    .limit(1);

  if (existing && existing.length > 0) {
    return { skipped: true, reason: 'Already applied' };
  }

  const { error } = await supabase
    .from('pto_ledger')
    .insert({
      school_id:   currentProfile.school_id,
      employee_id: employee.id,
      pto_type:    ptoType,
      delta_hours: employee.annual_pto_hours,
      reason,
      created_by:  currentProfile.employee_id
    });

  if (error) {
    console.error('Bulk allotment error:', error);
    return { error: true };
  }

  return { applied: true };
}

async function hasAnnualAllotmentBeenApplied(employeeId, ptoType, year) {
  const { data, error } = await supabase
    .from('pto_ledger')
    .select('id')
    .eq('employee_id', employeeId)
    .eq('pto_type', ptoType)
    .eq('reason', `ANNUAL_ALLOTMENT_${year}`)
    .limit(1);

  if (error) {
    console.error('Failed to check annual allotment:', error);
    return false;
  }
  return data.length > 0;
}

async function updateBulkAllotmentStatus() {
  const ptoType = document.getElementById('bulkAnnualPtoType').value;
  const statusEl = document.getElementById('bulkAllotmentStatus');
  if (!ptoType) { statusEl.style.display = 'none'; return; }

  const year = new Date().getFullYear();

  const { data } = await supabase
    .from('pto_ledger')
    .select('created_at')
    .eq('school_id', currentProfile.school_id)
    .eq('pto_type', ptoType)
    .eq('reason', `ANNUAL_ALLOTMENT_${year}`)
    .order('created_at', { ascending: false })
    .limit(1);

  if (data && data.length > 0) {
    const date = new Date(data[0].created_at).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    statusEl.textContent = `⚠ ${year} allotment last applied ${date}. Running again will skip anyone already credited.`;
    statusEl.style.display = 'block';
  } else {
    statusEl.textContent = `No ${year} allotment has been applied yet for ${ptoType}.`;
    statusEl.style.display = 'block';
  }
}

async function loadPtoAdjustStaff() {
  const select = document.getElementById('ptoAdjustStaff');
  if (!select) return;
  select.innerHTML = '<option value="">Select staff…</option>';
  const data = await loadStaffList();
  data.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.last_name}, ${e.first_name}`;
    select.appendChild(opt);
  });
}

async function updateAnnualAllotmentUI() {
  const employeeId = document.getElementById('ptoAdjustStaff').value;
  const ptoType = document.getElementById('ptoAdjustType').value;
  const btn = document.getElementById('applyAnnualAllotmentBtn');
  const status = document.getElementById('annualAllotmentStatus');

  status.style.display = 'none';
  btn.disabled = false;

  if (!employeeId || !ptoType) return;

  const year = new Date().getFullYear();
  const applied = await hasAnnualAllotmentBeenApplied(employeeId, ptoType, year);

  if (applied) {
    btn.disabled = true;
    status.textContent = `Annual allotment already applied for ${year}.`;
    status.style.display = 'inline';
  }
}

function populateBulkAnnualPtoTypes() {
  const select = document.getElementById('bulkAnnualPtoType');
  select.innerHTML = '<option value="">Select PTO type…</option>';
  currentSchoolPtoTypes.forEach(type => {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = type;
    select.appendChild(opt);
  });
}

function populateAdjustPtoTypes() {
  const select = document.getElementById('ptoAdjustType');
  select.innerHTML = '';
  currentSchoolPtoTypes.forEach(type => {
    const opt = document.createElement('option');
    opt.value = type;
    opt.textContent = type;
    select.appendChild(opt);
  });
}

/* =============================================
   CALENDAR
============================================= */
async function initPtoCalendar() {
  const calendarEl = document.getElementById('pto-calendar');

  ptoCalendar = new FullCalendar.Calendar(calendarEl, {
    initialView: 'dayGridMonth',
    height: 'auto',
    fixedWeekCount: false,
    dayMaxEvents: 3,
    headerToolbar: {
      left:   'prev,next today',
      center: 'title',
      right:  'dayGridMonth,timeGridWeek,timeGridDay'
    },

    events: async (info, success, failure) => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!sessionData?.session) {
          setTimeout(() => ptoCalendar.refetchEvents(), 250);
          return;
        }

        const { data, error } = await supabase.functions.invoke(
          'get_pto_calendar_events_v2',
          { body: { start_date: info.startStr, end_date: info.endStr } }
        );

        if (error) throw error;

        success(
          data.map(e => {
            const base = {
              id: e.id,
              title: e.title,
              backgroundColor: colorForPtoType(e.pto_type),
              borderColor:     colorForPtoType(e.pto_type),
              extendedProps:   { pto_type: e.pto_type }
            };
            if (e.partial_day && e.start_time && e.end_time && e.start_date) {
              return { ...base, start: `${e.start_date}T${e.start_time}`, end: `${e.start_date}T${e.end_time}`, allDay: false };
            }
            return { ...base, start: e.start, end: e.end, allDay: e.allDay ?? true };
          })
        );
      } catch (err) {
        console.error(err);
        failure(err);
      }
    },

    eventClick({ event, el, jsEvent }) {
      jsEvent.preventDefault();
      openCalEventPopover(el, event);
    }
  });

  ptoCalendar.render();
}

function colorForPtoType(type) {
  switch (type) {
    case 'VACATION': return '#2563eb';
    case 'SICK':     return '#16a34a';
    case 'PERSONAL': return '#9333ea';
    default:         return '#64748b';
  }
}

/* =============================================
   CALENDAR EVENT POPOVER
============================================= */

async function openCalEventPopover(el, fcEvent) {
  const popover = document.getElementById('calEventPopover');
  const ptoType = fcEvent.extendedProps.pto_type ?? '';

  // Employee name lives before the " – " separator in the title
  const sepIdx = fcEvent.title.lastIndexOf(' – ');
  const empName = sepIdx >= 0 ? fcEvent.title.slice(0, sepIdx) : fcEvent.title;

  // Date / time display
  let dateStr, timeStr;
  if (!fcEvent.allDay) {
    const [datePart, timePart] = fcEvent.startStr.split('T');
    const [, endTimePart]      = (fcEvent.endStr || '').split('T');
    dateStr = fmtDate(datePart);
    timeStr = `${formatTime(timePart?.slice(0, 8))} – ${formatTime(endTimePart?.slice(0, 8))}`;
  } else {
    const startDate = fcEvent.startStr;
    const endExcl   = new Date(fcEvent.end);
    endExcl.setDate(endExcl.getDate() - 1);
    const endDate = endExcl.toISOString().slice(0, 10);
    dateStr = startDate === endDate
      ? fmtDate(startDate)
      : `${fmtDate(startDate)} – ${fmtDate(endDate)}`;
    timeStr = 'Full day';
  }

  // Type badge
  const badge = document.getElementById('calPopTypeBadge');
  const color = colorForPtoType(ptoType);
  badge.textContent      = ptoType.charAt(0) + ptoType.slice(1).toLowerCase();
  badge.style.background = color + '22';
  badge.style.color      = color;
  badge.style.border     = `1px solid ${color}55`;

  document.getElementById('calPopEmpName').textContent  = empName;
  document.getElementById('calPopDate').textContent     = dateStr;
  document.getElementById('calPopTime').textContent     = timeStr;
  document.getElementById('calPopHours').textContent    = '…';
  document.getElementById('calPopNotes').textContent    = '…';
  document.getElementById('calPopApprover').textContent = '…';

  popover.hidden = false;
  positionCalPopover(popover, el);

  // Fetch full record for hours, notes, approver
  const { data, error } = await supabase
    .from('pto_requests')
    .select(`
      requested_hours,
      requested_duration_label,
      notes,
      decided_at,
      approver:employees!pto_requests_decided_by_fkey(first_name, last_name)
    `)
    .eq('id', fcEvent.id)
    .single();

  if (error || !data) return;

  document.getElementById('calPopHours').textContent =
    data.requested_duration_label || (data.requested_hours != null ? `${data.requested_hours} hrs` : '—');

  const notes = data.notes?.trim() || '';
  document.getElementById('calPopNotes').textContent    = notes || '—';
  document.getElementById('calPopNotesRow').hidden      = !notes;

  if (data.approver) {
    const name = `${data.approver.first_name} ${data.approver.last_name}`;
    const date = data.decided_at ? fmtDate(data.decided_at.slice(0, 10)) : '';
    document.getElementById('calPopApprover').textContent = date ? `${name} · ${date}` : name;
  } else {
    document.getElementById('calPopApprover').textContent = '—';
  }
}

function positionCalPopover(popover, el) {
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 8;

  let top  = rect.bottom + gap;
  let left = rect.left;

  popover.style.top  = top  + 'px';
  popover.style.left = left + 'px';

  const popW = popover.offsetWidth  || 280;
  const popH = popover.offsetHeight || 200;

  if (left + popW > vw - 12) left = Math.max(12, vw - popW - 12);
  if (top  + popH > vh - 12) top  = Math.max(12, rect.top - gap - popH);

  popover.style.top  = top  + 'px';
  popover.style.left = left + 'px';
}

function closeCalEventPopover() {
  document.getElementById('calEventPopover').hidden = true;
}

document.getElementById('calPopClose')?.addEventListener('click', closeCalEventPopover);

document.addEventListener('click', (e) => {
  const popover = document.getElementById('calEventPopover');
  if (!popover.hidden && !popover.contains(e.target) && !e.target.closest('.fc-event')) {
    closeCalEventPopover();
  }
});

/* =============================================
   TAB ROUTING
============================================= */
const ptoTabs = document.querySelectorAll('#ptoTabs .tab');

async function setPtoView(view) {
  if (view === 'history' && !currentProfile.can_review_pto) {
    alert('You are not authorized to view staff PTO history.');
    return;
  }
  if ((view === 'adjust' || view === 'policies') && !currentProfile.can_adjust_pto) {
    alert('You are not authorized to modify PTO policies or balances.');
    return;
  }
  if (view === 'reports' && !currentProfile.can_generate_pto_reports) {
    alert('You are not authorized to generate PTO reports.');
    return;
  }
  if (view === 'rollover' && !currentProfile.can_adjust_pto) {
    alert('You are not authorized to run year-end rollover.');
    return;
  }

  document.querySelectorAll('.admin-section').forEach(section => {
    section.classList.remove('active');
    const skel = section.querySelector('.skeleton-container');
    if (skel) skel.style.display = 'none';
  });

  const activeSection = document.getElementById(`pto-${view}`);
  if (!activeSection) {
    console.warn('Missing PTO section:', `pto-${view}`);
    return;
  }

  activeSection.classList.add('active');

  const skeleton = activeSection.querySelector('.skeleton-container');
  if (skeleton && view !== 'reports') skeleton.style.display = 'block';

  const content = activeSection.querySelector('.admin-content.fade-in');
  if (content && view !== 'reports') content.classList.remove('visible');

  try {
    if (view === 'calendar' && ptoCalendar) {
      requestAnimationFrame(() => ptoCalendar.updateSize());
    }

    if (view === 'pending') {
      if (!ptoViewCache.has('pending')) await loadPto();
    }
    ptoViewCache.delete('pending');

    if (view === 'cancellations') {
      await loadPtoCancellationRequests();
    }

    if (view === 'history') {
      if (!ptoViewCache.has('history-staff')) {
        await loadPtoStaffOptions();
        populateYearFilter();
        populatePtoTypeFilter();
        ptoViewCache.add('history-staff');
      }
      const select = document.getElementById('ptoStaffSelect');
      const employeeId = select?.value || null;
      resetStaffHistoryView();
      currentPtoHistoryEmployeeId = employeeId;
      if (employeeId) refreshStaffHistory(employeeId);
    }

    if (view === 'adjust' && !ptoViewCache.has('adjust')) {
      await Promise.all([
        populateAdjustPtoTypes(),
        loadPtoAdjustStaff(),
        populateBulkAnnualPtoTypes()
      ]);
      ptoViewCache.add('adjust');
    }

    if (view === 'reports') {
      initPtoReportsView();
    }

    if (view === 'rollover' && !ptoViewCache.has('rollover')) {
      await initRolloverView();
      ptoViewCache.add('rollover');
    }

    if (view === 'policies' && !ptoViewCache.has('policies')) {
      await loadPtoPolicies();
      ptoViewCache.add('policies');
    }
  } catch (err) {
    console.error(`Error loading PTO view "${view}"`, err);
    return;
  }

  if (content) {
    requestAnimationFrame(() => content.classList.add('visible'));
  }
  if (skeleton && view !== 'reports') skeleton.style.display = 'none';
}

/* =============================================
   ADJUST VIEW
============================================= */
async function loadAdjustPtoBalances(employeeId) {
  const container = document.getElementById('adjustPtoBalances');

  if (!employeeId) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }

  container.style.display = 'grid';
  container.innerHTML = '';

  const balanceMap = await getCurrentPtoBalanceMap(employeeId);

  currentSchoolPtoTypes.forEach(type => {
    const hours = balanceMap[type] ?? 0;
    const div = document.createElement('div');
    div.innerHTML = `
      <div class="muted">${type}</div>
      <div style="font-size:16px; font-weight:600;">${hours} hrs</div>
    `;
    container.appendChild(div);
  });
}

function resetStaffHistoryView() {
  document.getElementById('ptoHistoryAdminTable').style.display = 'none';
  document.getElementById('ptoHistoryEmpty').hidden = false;
  document.getElementById('ptoLedgerAdminTable').style.display = 'none';
  document.getElementById('ptoLedgerEmpty').hidden = false;

  const statsRow = document.getElementById('historyStatsRow');
  if (statsRow) statsRow.hidden = true;

  const chips = document.getElementById('historyBalanceChips');
  if (chips) chips.innerHTML = '';

  ['ptoSumApproved', 'ptoSumPending', 'ptoSumCancelled', 'ptoSumNet'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
}

/* =============================================
   REPORTS
============================================= */
let reportsFlatpickrInitializedFlag = false;

const REPORT_META = {
  transactions: {
    needsDates: true,
    description: 'All PTO ledger entries (approvals, adjustments, allotments) within the selected date range.'
  },
  balances: {
    needsDates: false,
    description: 'Current PTO balance snapshot for all active employees as of today.'
  },
  payroll: {
    needsDates: true,
    description: 'Approved PTO hours used per employee within the selected date range, for payroll processing.'
  },
  negative_balances: {
    needsDates: false,
    description: 'All employees currently carrying a negative PTO balance — use before payroll to identify pay deductions needed.'
  },
  year_end_summary: {
    needsDates: true,
    description: 'Full-year PTO summary per employee: allotted, used, adjusted, rollover credited, and current balance. Select your fiscal year start and end dates.'
  }
};

async function initPtoReportsView() {
  if (reportsFlatpickrInitialized) return;

  flatpickr('#exportStartDate', {
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'M j, Y'
  });

  flatpickr('#exportEndDate', {
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'M j, Y'
  });

  document.getElementById('exportReportType').addEventListener('change', e => {
    const meta = REPORT_META[e.target.value];
    const dateRange = document.getElementById('exportDateRange');
    const desc = document.getElementById('exportReportDescription');
    if (meta) {
      dateRange.style.display = meta.needsDates ? 'flex' : 'none';
      desc.textContent = meta.description;
    } else {
      dateRange.style.display = 'none';
      desc.textContent = '';
    }
  });

  const campusSelect = document.getElementById('exportCampusFilter');
  if (campusSelect) {
    const { data: campuses } = await supabase
      .from('campuses')
      .select('id, name')
      .eq('school_id', currentProfile.school_id)
      .order('name');

    (campuses || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      campusSelect.appendChild(opt);
    });

    if (!campuses || campuses.length === 0) {
      campusSelect.style.display = 'none';
    }
  }

  reportsFlatpickrInitialized = true;
}

async function handlePtoExport() {
  if (!currentProfile.can_generate_pto_reports) {
    alert('You are not authorized to generate PTO reports.');
    return;
  }

  const reportType = document.getElementById('exportReportType')?.value;
  const startDate  = document.getElementById('exportStartDate')?.value;
  const endDate    = document.getElementById('exportEndDate')?.value;
  const campusId   = document.getElementById('exportCampusFilter')?.value || null;

  if (!reportType) {
    alert('Please select a report type.');
    return;
  }

  if (REPORT_META[reportType]?.needsDates && (!startDate || !endDate)) {
    alert('Please select a start and end date.');
    return;
  }

  try {
    const btn = document.getElementById('generateExportBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';

    const { data, error } = await supabase.functions.invoke('export_pto_report_v2', {
      body: { report_type: reportType, start_date: startDate, end_date: endDate, campus_id: campusId }
    });

    if (error) throw error;

    const binary = atob(data.file);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error(err);
    alert('Failed to generate export.');
  } finally {
    const btn = document.getElementById('generateExportBtn');
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}

/* =============================================
   POLICY INPUT CHANGE (DELEGATION)
============================================= */
document.addEventListener('change', async e => {
  if (!e.target.classList.contains('pto-policy-input')) return;

  const input = e.target;
  const employeeId = input.dataset.employee;
  const ptoType = input.dataset.type;
  const hours = Number(input.value);
  const indicator = input.parentElement.querySelector('.save-indicator');

  if (hours < 0) {
    alert('Annual hours must be 0 or greater.');
    return;
  }

  indicator.textContent = 'Saving…';
  indicator.classList.remove('success', 'error');
  indicator.classList.add('saving');

  const { error } = await supabase
    .from('employee_pto_policies')
    .upsert({ employee_id: employeeId, pto_type: ptoType, annual_hours: hours });

  if (error) {
    console.error(error);
    indicator.textContent = 'Error';
    indicator.classList.remove('saving');
    indicator.classList.add('error');
  } else {
    indicator.textContent = '✓';
    indicator.classList.remove('saving', 'error');
    indicator.classList.add('success');
  }

  setTimeout(() => {
    indicator.classList.remove('success', 'error', 'saving');
    indicator.textContent = '';
  }, 2000);
});

/* =============================================
   ADJUST FORM
============================================= */
document.getElementById('applyPtoAdjustment')
  .addEventListener('click', async () => {
    if (!currentProfile?.can_adjust_pto) {
      alert('Not authorized');
      return;
    }

    const employeeId = document.getElementById('ptoAdjustStaff').value;
    const ptoType    = document.getElementById('ptoAdjustType').value;
    const hours      = Number(document.getElementById('ptoAdjustHours').value);
    const reasonInput = document.getElementById('ptoAdjustReason').value.trim();

    if (!employeeId || !hours) {
      alert('Select staff and enter hours');
      return;
    }

    if (!reasonInput) {
      alert('Please enter a reason for this adjustment');
      return;
    }

    const reason = `MANUAL_ADJUSTMENT_${new Date().getFullYear()}: ${reasonInput}`;

    const { error } = await supabase
      .from('pto_ledger')
      .insert({
        school_id:   currentProfile.school_id,
        employee_id: employeeId,
        pto_type:    ptoType,
        delta_hours: hours,
        reason,
        created_by:  currentProfile.employee_id
      });

    if (error) {
      console.error(error);
      alert('Failed to apply PTO adjustment');
      return;
    }

    alert('PTO adjustment applied');
    document.getElementById('ptoAdjustHours').value = '';
    document.getElementById('ptoAdjustReason').value = '';
    loadAdjustPtoBalances(employeeId);
    closeModal('adjustPtoModal');
  });

/* =============================================
   ANNUAL ALLOTMENT (SINGLE)
============================================= */
document.getElementById('applyAnnualAllotmentBtn')
  .addEventListener('click', async () => {
    if (!currentProfile.can_adjust_pto) {
      alert('You are not authorized to apply PTO allotments.');
      return;
    }

    const employeeId = document.getElementById('ptoAdjustStaff').value;
    const ptoType    = document.getElementById('ptoAdjustType').value;

    if (!employeeId || !ptoType) {
      alert('Select staff member and PTO type first.');
      return;
    }

    const year = new Date().getFullYear();

    const { data: policy, error } = await supabase
      .from('employee_pto_policies')
      .select('annual_hours')
      .eq('employee_id', employeeId)
      .eq('pto_type', ptoType)
      .single();

    if (error || !policy) {
      alert('No annual PTO policy configured for this employee and PTO type.');
      return;
    }

    const hours = policy.annual_hours;
    const alreadyApplied = await hasAnnualAllotmentBeenApplied(employeeId, ptoType, year);
    const statusEl = document.getElementById('annualAllotmentStatus');

    if (alreadyApplied) {
      statusEl.textContent = `Annual allotment already applied for ${year}.`;
      statusEl.style.display = 'inline';
      return;
    }

    await applyAnnualPto(employeeId, ptoType, hours);

    statusEl.textContent = `Annual allotment (${hours} hrs) applied for ${year}.`;
    statusEl.style.display = 'inline';

    if (staffSelect?.value === employeeId) {
      loadStaffPtoBalances(employeeId);
      loadStaffPtoLedger(employeeId);
    }
  });

/* =============================================
   ANNUAL ALLOTMENT (BULK)
============================================= */
document.getElementById('applyAnnualAllotmentsBulk')
  .addEventListener('click', async () => {
    if (!currentProfile.can_adjust_pto) {
      alert('You are not authorized to perform bulk PTO changes.');
      return;
    }

    const ptoType = document.getElementById('bulkAnnualPtoType').value;
    if (!ptoType) {
      alert('Please select a PTO type.');
      return;
    }

    const year = new Date().getFullYear();

    const { data: policies, error } = await supabase
      .from('employee_pto_policies')
      .select(`
        employee_id,
        annual_hours,
        employees!inner(id, active)
      `)
      .eq('pto_type', ptoType)
      .eq('employees.active', true);

    if (error) {
      console.error(error);
      alert('Failed to load PTO policies.');
      return;
    }

    const empIds = policies.map(p => p.employee_id);
    const { data: alreadyAppliedRows } = await supabase
      .from('pto_ledger')
      .select('employee_id')
      .in('employee_id', empIds)
      .eq('pto_type', ptoType)
      .eq('reason', `ANNUAL_ALLOTMENT_${year}`);

    const appliedSet = new Set((alreadyAppliedRows || []).map(r => r.employee_id));
    let willApply = 0;
    let willSkip = 0;

    for (const p of policies) {
      if (appliedSet.has(p.employee_id)) willSkip++;
      else willApply++;
    }

    const confirmRun = confirm(
      `Annual PTO Allotment Preview (${year})\n\n` +
      `PTO Type: ${ptoType}\n\n` +
      `✅ Will Apply: ${willApply}\n` +
      `⏭️ Will Skip: ${willSkip}\n\n` +
      `Proceed with applying allotments?`
    );

    if (!confirmRun) return;

    let applied = 0;
    let skipped = 0;
    let failed  = 0;

    for (const p of policies) {
      const result = await applyAnnualAllotmentIfEligible(
        { id: p.employee_id, annual_pto_hours: p.annual_hours },
        ptoType,
        year
      );
      if (result.applied) applied++;
      else if (result.skipped) skipped++;
      else failed++;
    }

    alert(
      `Annual PTO Allotment Results (${year})\n\n` +
      `✅ Applied: ${applied}\n` +
      `⏭️ Skipped: ${skipped}\n` +
      `❌ Failed: ${failed}`
    );

    updateBulkAllotmentStatus();
  });

/* =============================================
   HASH ROUTING
============================================= */
function handlePtoRoute() {
  const view = location.hash.replace('#', '') || 'pending';
  setPtoView(view);
}

window.addEventListener('hashchange', handlePtoRoute);
handlePtoRoute();

/* =============================================
   MODALS
============================================= */
function openModal(id) {
  document.getElementById(id).classList.add('open');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('open');
}

const openExportBtn = document.getElementById('openExportModal');
const exportModal   = document.getElementById('exportModal');

if (openExportBtn && exportModal) {
  openExportBtn.addEventListener('click', () => {
    openModal('exportModal');

    const generateBtn = document.getElementById('generateExportBtn');
    if (generateBtn && !generateBtn.dataset.bound) {
      generateBtn.dataset.bound = 'true';

      generateBtn.addEventListener('click', async () => {
        const reportType = document.getElementById('exportReportType').value;
        const startDate  = document.getElementById('exportStartDate')?.value;
        const endDate    = document.getElementById('exportEndDate')?.value;

        if (!reportType) { alert('Please select a report type.'); return; }

        if (REPORT_META[reportType]?.needsDates && (!startDate || !endDate)) {
          alert('Please select a start and end date.');
          return;
        }

        generateBtn.disabled = true;
        generateBtn.textContent = 'Generating…';

        try {
          const { data, error } = await supabase.functions.invoke(
            'export_pto_report_v2',
            { body: { report_type: reportType, start_date: startDate, end_date: endDate } }
          );

          if (error) {
            console.error(error);
            const status = error.context?.status;
            if (status === 401)      alert('You must be signed in to export PTO reports.');
            else if (status === 403) alert('You are not authorized to export PTO reports.');
            else                     alert('Failed to generate export.');
            return;
          }

          const binary = atob(data.file);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

          const blob = new Blob([bytes], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = data.filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error(err);
          alert('Failed to generate export.');
        } finally {
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate Export';
        }
      });
    }
  });
}

document.getElementById('ptoStaffSelect').value = '';
document.querySelector('#ptoHistoryAdminTable tbody').innerHTML = '';

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

/* =============================================
   ADJUST STAFF/TYPE CHANGE LISTENERS
============================================= */
document.getElementById('ptoAdjustStaff').addEventListener('change', e => {
  const employeeId = e.target.value;
  updateAnnualAllotmentUI();
  loadAdjustPtoBalances(employeeId);
});

document.getElementById('ptoAdjustType').addEventListener('change', updateAnnualAllotmentUI);
document.getElementById('bulkAnnualPtoType').addEventListener('change', updateBulkAllotmentStatus);

/* =============================================
   YEAR-END ROLLOVER
============================================= */
async function initRolloverView() {
  const select = document.getElementById('rolloverPtoTypeSelect');
  select.innerHTML = '<option value="">Select leave type…</option>';

  currentSchoolPtoTypes
    .filter(t => t !== 'ROLLOVER')
    .forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      select.appendChild(opt);
    });

  document.getElementById('rolloverReportWrap').style.display = 'none';
  document.getElementById('rolloverEmpty').style.display = 'none';
  rolloverReportData = [];
}

async function runRolloverReport() {
  const ptoType = document.getElementById('rolloverPtoTypeSelect').value;
  if (!ptoType) { alert('Select a leave type first.'); return; }

  const proceed = await checkLastRolloverRun();
  if (!proceed) return;

  const btn = document.getElementById('runRolloverReportBtn');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  document.getElementById('rolloverReportWrap').style.display = 'none';
  document.getElementById('rolloverEmpty').style.display = 'none';
  document.getElementById('rolloverCommitStatus').style.display = 'none';
  document.getElementById('rolloverPostCommit').style.display = 'none';
  rolloverReportData = [];

  try {
    const { data: settings } = await supabase
      .from('school_settings')
      .select('rollover_max_hours, payout_max_hours, payout_eligible_months, workday_hours')
      .eq('school_id', currentProfile.school_id)
      .single();

    const rolloverMax    = settings?.rollover_max_hours ?? 8;
    const payoutMax      = settings?.payout_max_hours ?? 32;
    const payoutEligible = settings?.payout_eligible_months ?? [10];
    const workdayHours   = settings?.workday_hours ?? 8;

    const { data: employees, error: empErr } = await supabase
      .from('employees')
      .select('id, first_name, last_name, employment_months')
      .eq('school_id', currentProfile.school_id)
      .eq('active', true)
      .order('last_name');

    if (empErr) throw empErr;

    const { data: balances, error: balErr } = await supabase
      .from('pto_balances')
      .select('employee_id, balance_hours')
      .eq('school_id', currentProfile.school_id)
      .eq('pto_type', ptoType);

    if (balErr) throw balErr;

    const balanceMap = {};
    (balances || []).forEach(b => { balanceMap[b.employee_id] = b.balance_hours; });

    const rows = employees.map(emp => {
      const balance = balanceMap[emp.id] ?? 0;
      const months = emp.employment_months;
      const isPayoutEligible = payoutEligible.includes(months);

      let defaultRollover = 0;
      let defaultPayout = 0;

      if (balance > 0) {
        defaultRollover = Math.min(balance, rolloverMax);
        if (isPayoutEligible) {
          defaultPayout = Math.min(balance - defaultRollover, payoutMax);
        }
      }

      return {
        employeeId: emp.id,
        name: `${emp.last_name}, ${emp.first_name}`,
        months,
        balance,
        rollover: defaultRollover,
        payout: defaultPayout,
        isPayoutEligible,
        rolloverMax,
        payoutMax,
        workdayHours
      };
    });

    rolloverReportData = rows;
    renderRolloverReport(rows, ptoType, workdayHours);

  } catch (err) {
    console.error('Rollover report error', err);
    alert('Failed to load rollover report.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Report';
  }
}

function renderRolloverReport(rows, ptoType, workdayHours) {
  const positiveRows = rows.filter(r => r.balance >= 0);
  const negativeRows = rows.filter(r => r.balance < 0);

  const tbody = document.querySelector('#rolloverReportTable tbody');
  tbody.innerHTML = '';

  if (positiveRows.length === 0 && negativeRows.length === 0) {
    document.getElementById('rolloverEmpty').style.display = 'block';
    return;
  }

  positiveRows.forEach((row, i) => {
    const payoutDays = row.isPayoutEligible
      ? (row.payout / workdayHours).toFixed(2)
      : '—';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.months ? `${row.months}-month` : '—'}</td>
      <td>${row.balance.toFixed(2)} hrs</td>
      <td>
        <input type="number" class="rollover-input" min="0" max="${row.rolloverMax}" step="0.5"
          value="${row.rollover}" data-idx="${i}" style="width:80px;" />
      </td>
      <td>
        ${row.isPayoutEligible
          ? `<input type="number" class="payout-input" min="0" max="${row.payoutMax}" step="0.5"
               value="${row.payout}" data-idx="${i}" style="width:80px;" />`
          : '<span class="muted">N/A</span>'}
      </td>
      <td class="payout-days-cell" data-idx="${i}">${row.isPayoutEligible ? payoutDays : '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.rollover-input').forEach(input => {
    input.addEventListener('input', () => {
      rolloverReportData[Number(input.dataset.idx)].rollover = Number(input.value) || 0;
    });
  });

  tbody.querySelectorAll('.payout-input').forEach(input => {
    input.addEventListener('input', () => {
      const idx = Number(input.dataset.idx);
      const val = Number(input.value) || 0;
      rolloverReportData[idx].payout = val;
      const daysCell = tbody.querySelector(`.payout-days-cell[data-idx="${idx}"]`);
      if (daysCell) daysCell.textContent = (val / workdayHours).toFixed(2);
    });
  });

  const negWrap = document.getElementById('rolloverNegativeWrap');
  const negTbody = document.querySelector('#rolloverNegativeTable tbody');
  negTbody.innerHTML = '';

  if (negativeRows.length > 0) {
    negWrap.style.display = 'block';
    negativeRows.forEach(row => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color:var(--err,#dc2626);">${row.name}</td>
        <td>${row.months ? `${row.months}-month` : '—'}</td>
        <td style="color:var(--err,#dc2626);">${row.balance.toFixed(2)} hrs</td>
        <td style="color:var(--err,#dc2626);">${(row.balance / workdayHours).toFixed(2)} days</td>
      `;
      negTbody.appendChild(tr);
    });
  } else {
    negWrap.style.display = 'none';
  }

  document.getElementById('rolloverReportWrap').style.display = 'block';
}

async function commitRollover() {
  if (!currentProfile.can_adjust_pto) {
    alert('Not authorized.');
    return;
  }

  const ptoType = document.getElementById('rolloverPtoTypeSelect').value;
  const year = new Date().getFullYear();

  const toProcess = rolloverReportData.filter(
    r => r.balance > 0 && (r.rollover > 0 || r.payout > 0)
  );

  if (toProcess.length === 0) {
    alert('No rollover or payout amounts to commit.');
    return;
  }

  for (const row of toProcess) {
    if (row.rollover < 0 || row.payout < 0) {
      alert(`Invalid amounts for ${row.name}. Hours cannot be negative.`);
      return;
    }
    if (row.rollover + row.payout > row.balance) {
      alert(`${row.name}: rollover + payout (${row.rollover + row.payout} hrs) exceeds balance (${row.balance} hrs).`);
      return;
    }
    if (!row.isPayoutEligible && row.payout > 0) {
      alert(`${row.name} is not eligible for payout based on employment type.`);
      return;
    }
  }

  const totalRollover  = toProcess.reduce((s, r) => s + r.rollover, 0);
  const totalPayout    = toProcess.reduce((s, r) => s + r.payout, 0);
  const workdayHours   = toProcess[0]?.workdayHours ?? 8;

  const confirmed = confirm(
    `Year-End Rollover Commit (${year})\n\n` +
    `Leave type: ${ptoType}\n` +
    `Employees affected: ${toProcess.length}\n\n` +
    `Total rollover to ROLLOVER balance: ${totalRollover} hrs\n` +
    `Total payout (handle in payroll): ${totalPayout} hrs (${(totalPayout / workdayHours).toFixed(2)} days)\n\n` +
    `This will debit the ${ptoType} balance and credit ROLLOVER for each employee.\n\nProceed?`
  );

  if (!confirmed) return;

  const btn = document.getElementById('commitRolloverBtn');
  btn.disabled = true;
  btn.textContent = 'Committing…';

  const statusEl = document.getElementById('rolloverCommitStatus');
  statusEl.style.display = 'none';

  try {
    const ledgerEntries = [];

    for (const row of toProcess) {
      const totalDebit = row.rollover + row.payout;
      if (totalDebit > 0) {
        ledgerEntries.push({
          school_id:   currentProfile.school_id,
          employee_id: row.employeeId,
          pto_type:    ptoType,
          delta_hours: -totalDebit,
          reason:      `YEAR_END_${year}_DEBIT`,
          created_by:  currentProfile.employee_id
        });
      }
      if (row.rollover > 0) {
        ledgerEntries.push({
          school_id:   currentProfile.school_id,
          employee_id: row.employeeId,
          pto_type:    'ROLLOVER',
          delta_hours: row.rollover,
          reason:      `YEAR_END_${year}_ROLLOVER`,
          created_by:  currentProfile.employee_id
        });
      }
    }

    const { error } = await supabase.from('pto_ledger').insert(ledgerEntries);
    if (error) throw error;

    committedRolloverMeta = { data: [...rolloverReportData], ptoType, year };
    statusEl.textContent = `✅ Committed ${year} rollover for ${toProcess.length} employees.`;
    statusEl.style.display = 'inline';
    rolloverReportData = [];
    document.getElementById('rolloverReportWrap').style.display = 'none';
    document.getElementById('rolloverPostCommit').style.display = 'block';

  } catch (err) {
    console.error('Rollover commit error', err);
    alert('Failed to commit rollover. No changes were saved.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Commit Rollover & Payout';
  }
}

function exportRolloverReport(data, ptoType, year) {
  const workdayHours = data[0]?.workdayHours ?? 8;

  const positiveRows = data.filter(r => r.balance >= 0).map(r => ({
    'Employee':                    r.name,
    'Employment Type':             r.months ? `${r.months}-month` : '—',
    'Current Balance (hrs)':       r.balance.toFixed(2),
    'Current Balance (days)':      (r.balance / workdayHours).toFixed(2),
    'Rollover to ROLLOVER (hrs)':  r.rollover,
    'Payout Hours':                r.isPayoutEligible ? r.payout : 'N/A',
    'Payout Days':                 r.isPayoutEligible ? (r.payout / workdayHours).toFixed(2) : 'N/A',
    'Payout Eligible':             r.isPayoutEligible ? 'Yes' : 'No'
  }));

  const negativeRows = data.filter(r => r.balance < 0).map(r => ({
    'Employee':        r.name,
    'Employment Type': r.months ? `${r.months}-month` : '—',
    'Balance (hrs)':   r.balance.toFixed(2),
    'Balance (days)':  (r.balance / workdayHours).toFixed(2)
  }));

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(positiveRows.length ? positiveRows : [{ Note: 'No employees with positive balances' }]);
  XLSX.utils.book_append_sheet(wb, ws1, 'Rollover & Payout');

  if (negativeRows.length) {
    const ws2 = XLSX.utils.json_to_sheet(negativeRows);
    XLSX.utils.book_append_sheet(wb, ws2, 'Negative Balances');
  }

  XLSX.writeFile(wb, `Year-End-Rollover-${ptoType}-${year}.xlsx`);
}

async function checkLastRolloverRun() {
  const { data: lastRun } = await supabase
    .from('pto_ledger')
    .select('created_at')
    .eq('school_id', currentProfile.school_id)
    .like('reason', 'YEAR\\_END\\_%\\_ROLLOVER')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastRun) return true;

  const lastRunDate = new Date(lastRun.created_at);
  const elevenMonthsMs = 11 * 30 * 24 * 60 * 60 * 1000;
  const withinElevenMonths = (Date.now() - lastRunDate.getTime()) < elevenMonthsMs;

  if (withinElevenMonths) {
    const formatted = lastRunDate.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
    return confirm(
      `Year-end rollover was last committed on ${formatted}.\n\n` +
      `Running it again within 11 months may result in duplicate rollover credits.\n\n` +
      `Are you sure you want to continue?`
    );
  }

  return true;
}

document.getElementById('runRolloverReportBtn').addEventListener('click', runRolloverReport);
document.getElementById('commitRolloverBtn').addEventListener('click', commitRollover);

document.getElementById('exportRolloverBtn').addEventListener('click', () => {
  const ptoType = document.getElementById('rolloverPtoTypeSelect').value;
  const year = new Date().getFullYear();
  if (!rolloverReportData.length) { alert('Run the report first.'); return; }
  exportRolloverReport(rolloverReportData, ptoType, year);
});

document.getElementById('downloadCommittedBtn').addEventListener('click', () => {
  if (!committedRolloverMeta) return;
  exportRolloverReport(committedRolloverMeta.data, committedRolloverMeta.ptoType, committedRolloverMeta.year);
});

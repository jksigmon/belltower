import { supabase } from '/app/admin.supabase.js';
import { initUserMenu } from '/app/user-menu.js';
import { requireAuth } from '/app/admin.auth.js';
import { showToast, esc } from '/app/admin.shared.js';

/* =============================================
   STATE
============================================= */
let currentSchoolPtoTypes = [];
let currentSchoolPtoTypeMeta = {};
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
   CONFIRM MODAL UTILITY
============================================= */
function showConfirm({ title = 'Confirm', body = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const modal      = document.getElementById('confirmModal');
    const titleEl    = document.getElementById('confirmModalTitle');
    const bodyEl     = document.getElementById('confirmModalBody');
    const confirmBtn = document.getElementById('confirmModalConfirm');
    const cancelBtn  = document.getElementById('confirmModalCancel');

    titleEl.textContent    = title;
    bodyEl.textContent     = body;
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent  = cancelText;
    confirmBtn.className   = danger ? 'btn danger' : 'btn btn-primary';

    modal.hidden = false;

    function finish(result) {
      modal.hidden = true;
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onOverlay);
      resolve(result);
    }
    function onConfirm() { finish(true); }
    function onCancel()  { finish(false); }
    function onOverlay(e) { if (e.target === modal) finish(false); }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click',  onCancel);
    modal.addEventListener('click', onOverlay);
  });
}

/* =============================================
   AUTH + PROFILE
============================================= */
const _session = await requireAuth();
if (!_session) { window.location.href = '/login.html'; throw new Error('No session'); }

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

// Custom select: needs school_modules join for tab visibility gating
const { data: currentProfile, error: profErr } = await supabase
  .from('profiles')
  .select('*, schools!profiles_school_id_fkey(school_modules(module, enabled))')
  .eq('user_id', _session.user.id)
  .single();

if (profErr || !currentProfile) {
  showToast('Profile load failed', 'error');
  throw profErr;
}

initUserMenu(currentProfile.display_name ?? currentProfile.email);

// PTO permission helpers — evaluated once after profile load
// Driven entirely by explicit flags; role alone does not grant access.
const _canManagePtoBalances =
  currentProfile.can_manage_pto_balances === true ||
  currentProfile.is_superadmin === true;
const _canAdjustPto = currentProfile.can_adjust_pto === true || _canManagePtoBalances;

if (!currentProfile.can_view_pto_calendar) {
  document.getElementById('ptoTabCalendar')?.remove();
}

if (!currentProfile.can_approve_pto) {
  document.getElementById('ptoTabPending')?.remove();
  document.getElementById('ptoTabCancellations')?.remove();
}

if (!currentProfile.can_review_pto && !_canManagePtoBalances) {
  document.getElementById('navPtoHistory')?.remove();
}

if (!(currentProfile.can_submit_on_behalf && currentProfile.can_approve_pto)) {
  document.getElementById('navPtoSubmitOnBehalf')?.remove();
}

if (!_canAdjustPto) {
  document.getElementById('navPtoAdjust')?.remove();
}

if (!_canManagePtoBalances) {
  document.getElementById('navPtoRollover')?.remove();
  document.getElementById('navPtoPolicies')?.remove();
}

if (!currentProfile.can_generate_pto_reports) {
  document.getElementById('ptoTabReports')?.remove();
}

// Deduction-only mode: strip allotment UI and tighten hint text
if (_canAdjustPto && !_canManagePtoBalances) {
  document.getElementById('adjustAllotmentsWrap')?.remove();
  const hoursInput = document.getElementById('ptoAdjustHours');
  if (hoursInput) {
    hoursInput.placeholder = 'Hours (negative to deduct)';
    hoursInput.setAttribute('max', '0');
  }
  const hint = document.getElementById('adjustHintText');
  if (hint) hint.textContent = 'Enter a negative number to deduct time (e.g. -0.5 for 30 min). Use this for early departures or unexpected absences. All deductions are recorded in the employee ledger.';
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
    profile.can_manage_pto_balances === true ||
    profile.can_bulk_upload === true
  );
}

const backToAdmin = document.getElementById('backToAdmin');
if (backToAdmin && hasAdminAccess(currentProfile)) {
  backToAdmin.style.display = 'inline-flex';
}

/* =============================================
   MODULE GATE
============================================= */
const ptoModule = currentProfile.schools?.school_modules?.find(r => r.module === 'pto');
if (!ptoModule?.enabled) {
  showToast('Leave is not enabled for your school.', 'error');
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
  if (!await showConfirm({
    title: `Approve ${ids.length} Request${ids.length !== 1 ? 's' : ''}`,
    body: `Approve ${ids.length} leave request${ids.length !== 1 ? 's' : ''}?`,
    confirmText: 'Approve'
  })) return;

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
    showToast('Failed to approve requests.', 'error');
    return;
  }

  clearPendingSelection();
  await loadPtoRequestCounts();
  loadPto();
  loadPtoCancellationRequests();
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
    .select('pto_type, counts_against_balance, notes_required, sort_order')
    .eq('school_id', currentProfile.school_id)
    .eq('enabled', true)
    .order('sort_order')
    .order('pto_type');

  if (error) {
    console.error('Failed to load PTO types:', error);
    return;
  }
  currentSchoolPtoTypes = data.map(r => r.pto_type);
  currentSchoolPtoTypeMeta = {};
  data.forEach(r => {
    currentSchoolPtoTypeMeta[r.pto_type] = {
      countsAgainstBalance: r.counts_against_balance,
      notesRequired: r.notes_required
    };
  });
}

/* =============================================
   PENDING PTO TABLE
============================================= */
async function loadPto() {
  const tbody = document.querySelector('#ptoTable tbody');
  const emptyState = document.getElementById('pendingEmpty');
  if (!currentProfile.can_approve_pto) {
    if (emptyState) emptyState.hidden = false;
    return;
  }
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
    .limit(500);

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
        showToast('You are not authorized to approve leave requests.', 'error');
        return;
      }
      updatePtoStatus(r.id, 'APPROVED', tr);
    });

    tr.querySelector('.btn-deny').addEventListener('click', () => {
      denyInitialPto(r, tr);
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
  const tbody = document.querySelector('#ptoCancelTable tbody');
  const emptyState = document.getElementById('cancellationsEmpty');
  if (!currentProfile.can_approve_pto) {
    if (emptyState) emptyState.hidden = false;
    return;
  }
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
        showToast('You are not authorized to approve leave cancellations.', 'error');
        return;
      }
      approveCancellation(r);
    });

    tr.querySelector('.btn-deny').addEventListener('click', () => {
      if (!currentProfile.can_approve_pto) {
        showToast('You are not authorized to deny leave cancellations.', 'error');
        return;
      }
      denyCancellation(r);
    });

    tbody.appendChild(tr);
  });
}

function renderCancelBadge(status, startDate) {
  if (status === 'RESCIND_REQUESTED') {
    return '<span class="badge badge-warn">Rescind (Past Leave)</span>';
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
    showToast('You are not authorized to approve leave cancellations.', 'error');
    return;
  }

  if (r.status === 'RESCIND_REQUESTED') {
    if (!await showConfirm({
      title: 'Approve Leave Rescind',
      body: 'This leave was approved for past dates.\nBy approving this rescind, you confirm that the employee did NOT take this time off.\n\n✔ Leave hours will be credited back\n✔ Ledger and balance will be updated\n✔ This action is audit-logged',
      confirmText: 'Approve Rescind'
    })) return;
  } else {
    if (!await showConfirm({
      title: 'Approve Cancellation',
      body: 'Approve this leave cancellation and credit time back?',
      confirmText: 'Approve'
    })) return;
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
    showToast('Failed to approve cancellation.', 'error');
    return;
  }

  // Auto-cancel sub assignments for dates already past (sub already worked; no action needed).
  // Today's and future assignments stay scheduled so the sub manager can see them in the
  // Cancellations screen and manually notify the sub before cancelling.
  const todayStr = new Date().toISOString().slice(0, 10);
  await supabase
    .from('substitute_assignments')
    .update({ status: 'cancelled' })
    .eq('pto_request_id', r.id)
    .eq('status', 'scheduled')
    .lt('start_date', todayStr);

  await loadPtoRequestCounts();
  loadPto();
  loadPtoCancellationRequests();
  ptoCalendar?.refetchEvents();
}

function denyInitialPto(r, rowEl = null) {
  if (!currentProfile.can_approve_pto) {
    showToast('You are not authorized to deny leave requests.', 'error');
    return;
  }

  const emp = r.employees
    ? `${r.employees.first_name} ${r.employees.last_name}`
    : '';
  const dateRange = r.start_date === r.end_date
    ? r.start_date
    : `${r.start_date} → ${r.end_date}`;

  openDenyModal(
    'Deny Leave Request',
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
        showToast('Failed to deny leave request.', 'error');
        return;
      }

      if (rowEl) {
        rowEl.remove();
        selectedPendingIds.delete(String(r.id));
        updatePendingBulkBar();
      } else {
        loadPto();
      }
      await loadPtoRequestCounts();
      ptoCalendar?.refetchEvents();
    }
  );
}

function denyCancellation(r) {
  if (!currentProfile.can_approve_pto) {
    showToast('You are not authorized to deny leave requests.', 'error');
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
        showToast('Failed to deny request.', 'error');
        return;
      }

      await loadPtoRequestCounts();
      loadPto();
      loadPtoCancellationRequests();
      ptoCalendar?.refetchEvents();
    }
  );
}

async function updatePtoStatus(requestId, newStatus, rowEl = null) {
  if (!currentProfile.can_approve_pto) {
    showToast('You are not authorized to approve or deny leave requests.', 'error');
    return;
  }

  if (!await showConfirm({
    title: newStatus === 'APPROVED' ? 'Approve Leave Request' : 'Deny Leave Request',
    body:  newStatus === 'APPROVED' ? 'Approve this leave request?' : 'Deny this leave request?',
    confirmText: newStatus === 'APPROVED' ? 'Approve' : 'Deny',
    danger: newStatus !== 'APPROVED'
  })) return;

  const { error } = await supabase
    .from('pto_requests')
    .update({
      status: newStatus,
      decided_at: new Date().toISOString(),
      decided_by: currentProfile.employee_id
    })
    .eq('id', requestId)
    .eq('school_id', currentProfile.school_id);

  if (error) {
    console.error(error);
    showToast('Failed to update leave request.', 'error');
    return;
  }

  if (rowEl) {
    rowEl.remove();
    selectedPendingIds.delete(String(requestId));
    updatePendingBulkBar();
  } else {
    loadPto();
  }
  await loadPtoRequestCounts();
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
    .eq('employee_id', employeeId)
    .eq('school_id', currentProfile.school_id);

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
    .eq('employee_id', employeeId)
    .eq('school_id', currentProfile.school_id);

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
    .eq('school_id', currentProfile.school_id)
    .order('submitted_at', { ascending: false });

  if (year) {
    const nextYear = Number(year) + 1;
    ledgerQuery = ledgerQuery
      .gte('created_at', `${year}-01-01`)
      .lt('created_at', `${nextYear}-01-01`);
    histQuery = histQuery
      .gte('start_date', `${year}-01-01`)
      .lt('start_date', `${nextYear}-01-01`);
  }

  const [
    { data: ledger, error: ledgerError },
    { data, error }
  ] = await Promise.all([ledgerQuery, histQuery]);

  if (ledgerError) {
    console.error('Failed to load PTO ledger:', ledgerError);
    resetStaffHistoryView();
    const el = document.getElementById('ptoLedgerEmpty');
    if (el) el.textContent = 'Failed to load ledger — try refreshing.';
    return;
  }

  ledger.forEach(l => {
    if (l.reason === 'REQUEST APPROVED') approvedUsed += Math.abs(l.delta_hours);
    if (l.reason === 'REQUEST CANCELLED FUTURE' || l.reason === 'REQUEST RESCINDED RETROACTIVE') {
      cancelled += l.delta_hours;
    }
  });

  if (error) {
    console.error('Failed to load PTO history:', error);
    resetStaffHistoryView();
    const el = document.getElementById('ptoHistoryEmpty');
    if (el) el.textContent = 'Failed to load history — try refreshing.';
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
    .eq('school_id', currentProfile.school_id)
    .order('created_at', { ascending: false });

  if (year) {
    const nextYear = Number(year) + 1;
    ledgerQuery = ledgerQuery
      .gte('created_at', `${year}-01-01`)
      .lt('created_at', `${nextYear}-01-01`);
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
  if (!_canManagePtoBalances) {
    showToast('Not authorized', 'error');
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
    showToast('Annual leave has already been applied for this year.', 'warn');
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
    showToast('Failed to apply annual leave allotment.', 'error');
    return;
  }

  showToast(`Annual leave allotment (${hours} hrs) applied.`, 'success');
}

/* =============================================
   PTO TYPE SETTINGS
============================================= */
async function loadPtoTypeSettings() {
  const tbody = document.querySelector('#ptoTypeSettingsTable tbody');
  if (!tbody) return;

  const { data, error } = await supabase
    .from('school_pto_types')
    .select('pto_type, enabled, counts_against_balance, notes_required, sort_order')
    .eq('school_id', currentProfile.school_id)
    .order('sort_order')
    .order('pto_type');

  if (error || !data) return;

  const dis = _canManagePtoBalances ? '' : 'disabled';
  tbody.innerHTML = '';
  data.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:500;">${esc(row.pto_type)}</td>
      <td style="text-align:center;">
        <input type="checkbox" data-type="${esc(row.pto_type)}" data-field="enabled"
          ${row.enabled ? 'checked' : ''} ${dis} />
      </td>
      <td style="text-align:center;">
        <input type="checkbox" data-type="${esc(row.pto_type)}" data-field="counts_against_balance"
          ${row.counts_against_balance ? 'checked' : ''} ${dis} />
      </td>
      <td style="text-align:center;">
        <input type="checkbox" data-type="${esc(row.pto_type)}" data-field="notes_required"
          ${row.notes_required ? 'checked' : ''} ${dis} />
      </td>
      <td style="text-align:center;">
        <input type="number" min="1" step="1" value="${row.sort_order}"
          style="width:54px; text-align:center;"
          data-type="${esc(row.pto_type)}"
          ${_canManagePtoBalances ? '' : 'disabled'} />
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => savePtoTypeFlag(cb));
  });

  tbody.querySelectorAll('input[type="number"]').forEach(input => {
    input.addEventListener('change', () => savePtoTypeSortOrder(input));
  });
}

async function savePtoTypeFlag(cb) {
  const type = cb.dataset.type;
  const field = cb.dataset.field;

  const { error } = await supabase
    .from('school_pto_types')
    .update({ [field]: cb.checked })
    .eq('school_id', currentProfile.school_id)
    .eq('pto_type', type);

  if (error) {
    showToast('Failed to save leave type setting.', 'error');
    cb.checked = !cb.checked;
    return;
  }

  // Keep in-memory meta in sync
  if (currentSchoolPtoTypeMeta[type]) {
    if (field === 'notes_required') currentSchoolPtoTypeMeta[type].notesRequired = cb.checked;
    if (field === 'counts_against_balance') currentSchoolPtoTypeMeta[type].countsAgainstBalance = cb.checked;
  }
  if (field === 'enabled') {
    if (cb.checked) {
      if (!currentSchoolPtoTypes.includes(type)) currentSchoolPtoTypes.push(type);
    } else {
      currentSchoolPtoTypes = currentSchoolPtoTypes.filter(t => t !== type);
    }
  }
}

async function savePtoTypeSortOrder(input) {
  const type = input.dataset.type;
  const val = parseInt(input.value, 10);
  if (isNaN(val) || val < 1) { showToast('Order must be 1 or greater.', 'warn'); return; }

  const { error } = await supabase
    .from('school_pto_types')
    .update({ sort_order: val })
    .eq('school_id', currentProfile.school_id)
    .eq('pto_type', type);

  if (error) {
    showToast('Failed to save leave type order.', 'error');
    return;
  }
  showToast('Order saved. Reload to see updated column order.', 'success');
}

/* =============================================
   PTO POLICIES
============================================= */
async function loadPtoPolicies() {
  if (!currentProfile || !currentProfile.school_id) return;

  await loadPtoTypeSettings();

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
  bulkTypeSelect.innerHTML = '<option value="">Leave type…</option>';
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
            ${_canManagePtoBalances ? '' : 'disabled'} />
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

  if (!ptoType) { showToast('Select a leave type.', 'warn'); return; }
  if (hoursRaw === '' || isNaN(Number(hoursRaw))) { showToast('Enter a valid number of hours.', 'warn'); return; }
  const hours = parseFloat(hoursRaw);
  if (hours < 0) { showToast('Hours must be 0 or greater.', 'warn'); return; }

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
    showToast('No leave types are enabled for this school.', 'warn');
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
  const btn = document.getElementById('applyAnnualAllotmentBtn');
  if (!btn) return; // allotment section removed for deduction-only users
  const employeeId = document.getElementById('ptoAdjustStaff').value;
  const ptoType = document.getElementById('ptoAdjustType').value;
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
  if (!select) return; // allotment section removed for deduction-only users
  select.innerHTML = '<option value="">Select leave type…</option>';
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
function calToolbar() {
  return window.innerWidth <= 767
    ? { left: 'prev,next', center: 'title', right: 'today' }
    : { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,timeGridDay' };
}

async function initPtoCalendar() {
  const calendarEl = document.getElementById('pto-calendar');

  ptoCalendar = new FullCalendar.Calendar(calendarEl, {
    initialView: 'dayGridMonth',
    height: 'auto',
    fixedWeekCount: false,
    dayMaxEvents: 3,
    headerToolbar: calToolbar(),

    windowResize() {
      ptoCalendar.setOption('headerToolbar', calToolbar());
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
  if (view === 'history' && !currentProfile.can_review_pto && !_canManagePtoBalances) {
    showToast('You are not authorized to view staff leave history.', 'error');
    return;
  }
  if (view === 'adjust' && !_canAdjustPto) {
    showToast('You are not authorized to adjust leave balances.', 'error');
    return;
  }
  if (view === 'policies' && !_canManagePtoBalances) {
    showToast('You are not authorized to modify leave policies.', 'error');
    return;
  }
  if (view === 'reports' && !currentProfile.can_generate_pto_reports) {
    showToast('You are not authorized to generate leave reports.', 'error');
    return;
  }
  if (view === 'rollover' && !_canManagePtoBalances) {
    showToast('You are not authorized to run year-end rollover.', 'error');
    return;
  }
  if (view === 'submit-for-staff' && !(currentProfile.can_submit_on_behalf && currentProfile.can_approve_pto)) {
    showToast('You are not authorized to submit leave on behalf of staff.', 'error');
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

    if (view === 'submit-for-staff' && !ptoViewCache.has('submit-for-staff')) {
      await initProxySubmitView();
      ptoViewCache.add('submit-for-staff');
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
    description: 'All leave ledger entries (approvals, adjustments, allotments) within the selected date range.'
  },
  balances: {
    needsDates: false,
    description: 'Current leave balance snapshot for all active employees as of today.'
  },
  payroll: {
    needsDates: true,
    description: 'Approved leave hours used per employee within the selected date range, for payroll processing.'
  },
  negative_balances: {
    needsDates: false,
    description: 'All employees currently carrying a negative leave balance — use before payroll to identify pay deductions needed.'
  },
  year_end_summary: {
    needsDates: true,
    description: 'Full-year leave summary per employee: allotted, used, adjusted, rollover credited, and current balance. Select your fiscal year start and end dates.'
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
    showToast('You are not authorized to generate leave reports.', 'error');
    return;
  }

  const reportType = document.getElementById('exportReportType')?.value;
  const startDate  = document.getElementById('exportStartDate')?.value;
  const endDate    = document.getElementById('exportEndDate')?.value;
  const campusId   = document.getElementById('exportCampusFilter')?.value || null;

  if (!reportType) {
    showToast('Please select a report type.', 'warn');
    return;
  }

  if (REPORT_META[reportType]?.needsDates && (!startDate || !endDate)) {
    showToast('Please select a start and end date.', 'warn');
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
    showToast('Failed to generate export.', 'error');
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
    showToast('Annual hours must be 0 or greater.', 'warn');
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
    if (!_canAdjustPto) {
      showToast('Not authorized', 'error');
      return;
    }

    const employeeId = document.getElementById('ptoAdjustStaff').value;
    const ptoType    = document.getElementById('ptoAdjustType').value;
    const hours      = Number(document.getElementById('ptoAdjustHours').value);
    const reasonInput = document.getElementById('ptoAdjustReason').value.trim();

    if (!employeeId || hours === 0 || isNaN(hours)) {
      showToast('Select staff and enter hours', 'warn');
      return;
    }

    if (!_canManagePtoBalances && hours > 0) {
      showToast('You can only deduct leave hours. Enter a negative value (e.g. -0.5).', 'error');
      return;
    }

    if (!reasonInput) {
      showToast('Please enter a reason for this adjustment', 'warn');
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
      showToast('Failed to apply leave adjustment', 'error');
      return;
    }

    showToast('Leave adjustment applied', 'success');
    document.getElementById('ptoAdjustHours').value = '';
    document.getElementById('ptoAdjustReason').value = '';
    loadAdjustPtoBalances(employeeId);
    closeModal('adjustPtoModal');
  });

/* =============================================
   ANNUAL ALLOTMENT (SINGLE)
============================================= */
document.getElementById('applyAnnualAllotmentBtn')
  ?.addEventListener('click', async () => {
    if (!_canManagePtoBalances) {
      showToast('You are not authorized to apply leave allotments.', 'error');
      return;
    }

    const employeeId = document.getElementById('ptoAdjustStaff').value;
    const ptoType    = document.getElementById('ptoAdjustType').value;

    if (!employeeId || !ptoType) {
      showToast('Select staff member and leave type first.', 'warn');
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
      showToast('No annual leave policy configured for this employee and leave type.', 'warn');
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
  ?.addEventListener('click', async () => {
    if (!_canManagePtoBalances) {
      showToast('You are not authorized to perform bulk leave changes.', 'error');
      return;
    }

    const ptoType = document.getElementById('bulkAnnualPtoType').value;
    if (!ptoType) {
      showToast('Please select a leave type.', 'warn');
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
      showToast('Failed to load leave policies.', 'error');
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

    if (!await showConfirm({
      title: `Annual Leave Allotment (${year})`,
      body: `Leave Type: ${ptoType}\n\n✅ Will Apply: ${willApply}\n⏭️ Will Skip: ${willSkip}\n\nProceed with applying allotments?`,
      confirmText: 'Apply Allotments'
    })) return;

    const toApply = policies.filter(p => !appliedSet.has(p.employee_id) && p.annual_hours > 0);
    const skipped = policies.length - toApply.length;

    if (toApply.length === 0) {
      showToast(`No allotments to apply — all ${skipped} employees already received theirs.`, 'info');
      updateBulkAllotmentStatus();
      return;
    }

    const ledgerEntries = toApply.map(p => ({
      school_id:   currentProfile.school_id,
      employee_id: p.employee_id,
      pto_type:    ptoType,
      delta_hours: p.annual_hours,
      reason:      `ANNUAL_ALLOTMENT_${year}`,
      created_by:  currentProfile.employee_id
    }));

    const { error: insertError } = await supabase.from('pto_ledger').insert(ledgerEntries);

    if (insertError) {
      console.error('Bulk allotment insert failed:', insertError);
      showToast('Failed to apply allotments. No changes were saved.', 'error');
      return;
    }

    showToast(`Allotments applied: ${toApply.length}${skipped > 0 ? `, skipped: ${skipped} (already applied)` : ''}.`, 'success', 6000);

    updateBulkAllotmentStatus();
  });

/* =============================================
   HASH ROUTING
============================================= */
function getDefaultPtoView() {
  if (currentProfile.can_approve_pto) return 'pending';
  if (currentProfile.can_view_pto_calendar) return 'calendar';
  if (currentProfile.can_review_pto || _canManagePtoBalances) return 'history';
  if (_canAdjustPto) return 'adjust';
  if (currentProfile.can_generate_pto_reports) return 'reports';
  return 'pending';
}

function handlePtoRoute() {
  const view = location.hash.replace('#', '') || getDefaultPtoView();
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

        if (!reportType) { showToast('Please select a report type.', 'warn'); return; }

        if (REPORT_META[reportType]?.needsDates && (!startDate || !endDate)) {
          showToast('Please select a start and end date.', 'warn');
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
            if (status === 401)      showToast('You must be signed in to export leave reports.', 'error');
            else if (status === 403) showToast('You are not authorized to export leave reports.', 'error');
            else                     showToast('Failed to generate export.', 'error');
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
          showToast('Failed to generate export.', 'error');
        } finally {
          generateBtn.disabled = false;
          generateBtn.textContent = 'Generate Export';
        }
      });
    }
  });
}

const _staffSelectEl = document.getElementById('ptoStaffSelect');
if (_staffSelectEl) _staffSelectEl.value = '';
const _histTbodyEl = document.querySelector('#ptoHistoryAdminTable tbody');
if (_histTbodyEl) _histTbodyEl.innerHTML = '';

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
document.getElementById('bulkAnnualPtoType')?.addEventListener('change', updateBulkAllotmentStatus);

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
  if (!ptoType) { showToast('Select a leave type first.', 'warn'); return; }

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
    showToast('Failed to load rollover report.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run Report';
  }
}

function renderRolloverReport(rows, ptoType, workdayHours) {
  // Track the original rolloverReportData index so input handlers update the right employee
  // regardless of how many negative-balance employees are filtered out before positiveRows.
  const positiveRows = rows
    .map((r, origIdx) => ({ ...r, origIdx }))
    .filter(r => r.balance >= 0);
  const negativeRows = rows.filter(r => r.balance < 0);

  const tbody = document.querySelector('#rolloverReportTable tbody');
  tbody.innerHTML = '';

  if (positiveRows.length === 0 && negativeRows.length === 0) {
    document.getElementById('rolloverEmpty').style.display = 'block';
    return;
  }

  positiveRows.forEach(row => {
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
          value="${row.rollover}" data-idx="${row.origIdx}" style="width:80px;" />
      </td>
      <td>
        ${row.isPayoutEligible
          ? `<input type="number" class="payout-input" min="0" max="${row.payoutMax}" step="0.5"
               value="${row.payout}" data-idx="${row.origIdx}" style="width:80px;" />`
          : '<span class="muted">N/A</span>'}
      </td>
      <td class="payout-days-cell" data-idx="${row.origIdx}">${row.isPayoutEligible ? payoutDays : '—'}</td>
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
  if (!_canManagePtoBalances) {
    showToast('Not authorized.', 'error');
    return;
  }

  const ptoType = document.getElementById('rolloverPtoTypeSelect').value;
  const year = new Date().getFullYear();

  const toProcess = rolloverReportData.filter(
    r => r.balance > 0 && (r.rollover > 0 || r.payout > 0)
  );

  if (toProcess.length === 0) {
    showToast('No rollover or payout amounts to commit.', 'warn');
    return;
  }

  for (const row of toProcess) {
    if (row.rollover < 0 || row.payout < 0) {
      showToast(`Invalid amounts for ${row.name}. Hours cannot be negative.`, 'error');
      return;
    }
    if (row.rollover + row.payout > row.balance) {
      showToast(`${row.name}: rollover + payout (${row.rollover + row.payout} hrs) exceeds balance (${row.balance} hrs).`, 'error');
      return;
    }
    if (!row.isPayoutEligible && row.payout > 0) {
      showToast(`${row.name} is not eligible for payout based on employment type.`, 'error');
      return;
    }
  }

  const totalRollover  = toProcess.reduce((s, r) => s + r.rollover, 0);
  const totalPayout    = toProcess.reduce((s, r) => s + r.payout, 0);
  const workdayHours   = toProcess[0]?.workdayHours ?? 8;

  if (!await showConfirm({
    title: `Year-End Rollover Commit (${year})`,
    body: `Leave type: ${ptoType}\nEmployees affected: ${toProcess.length}\n\nTotal rollover to ROLLOVER balance: ${totalRollover} hrs\nTotal payout (handle in payroll): ${totalPayout} hrs (${(totalPayout / workdayHours).toFixed(2)} days)\n\nThis will debit the ${ptoType} balance and credit ROLLOVER for each employee.`,
    confirmText: 'Commit Rollover',
    danger: true
  })) return;

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
    showToast('Failed to commit rollover. No changes were saved.', 'error');
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
    return await showConfirm({
      title: 'Warning: Recent Rollover',
      body: `Year-end rollover was last committed on ${formatted}.\n\nRunning it again within 11 months may result in duplicate rollover credits.\n\nAre you sure you want to continue?`,
      confirmText: 'Continue Anyway',
      danger: true
    });
  }

  return true;
}

document.getElementById('runRolloverReportBtn').addEventListener('click', runRolloverReport);
document.getElementById('commitRolloverBtn').addEventListener('click', commitRollover);

document.getElementById('exportRolloverBtn').addEventListener('click', () => {
  const ptoType = document.getElementById('rolloverPtoTypeSelect').value;
  const year = new Date().getFullYear();
  if (!rolloverReportData.length) { showToast('Run the report first.', 'warn'); return; }
  exportRolloverReport(rolloverReportData, ptoType, year);
});

document.getElementById('downloadCommittedBtn').addEventListener('click', () => {
  if (!committedRolloverMeta) return;
  exportRolloverReport(committedRolloverMeta.data, committedRolloverMeta.ptoType, committedRolloverMeta.year);
});

/* =============================================
   SUBMIT LEAVE ON BEHALF OF STAFF
============================================= */
let proxyDatePicker = null;
let proxySelectedStart = null;
let proxySelectedEnd = null;
let proxyWorkdayHours = 8;
const PROXY_INCREMENT_MINUTES = 30;

async function initProxySubmitView() {
  // Load workday hours from school settings
  const { data: settings } = await supabase
    .from('school_settings')
    .select('workday_hours')
    .eq('school_id', currentProfile.school_id)
    .single();
  proxyWorkdayHours = settings?.workday_hours ?? 8;

  // Populate staff picker
  const staffSelect = document.getElementById('proxyStaffSelect');
  staffSelect.innerHTML = '<option value="">Select staff member…</option>';
  const staff = await loadStaffList();
  staff.forEach(emp => {
    const opt = new Option(`${emp.last_name}, ${emp.first_name}`, emp.id);
    staffSelect.appendChild(opt);
  });

  // Populate leave types
  const typeSelect = document.getElementById('proxyPtoType');
  typeSelect.innerHTML = '<option value="">Select Leave Type</option>';
  currentSchoolPtoTypes.forEach(type => {
    typeSelect.appendChild(new Option(type, type));
  });

  // Duration change → update date picker mode and show/hide time row
  const durationSelect = document.getElementById('proxyDuration');
  durationSelect.addEventListener('change', () => {
    const val = durationSelect.value;
    const isMulti = val === 'multi';
    const isPartial = val === 'partial';
    if (proxyDatePicker) {
      proxyDatePicker.set('mode', isMulti ? 'range' : 'single');
      proxyDatePicker.clear();
      proxySelectedStart = null;
      proxySelectedEnd = null;
    }
    document.getElementById('proxyTimeRow').classList.toggle('visible', isPartial);
    updateProxyComputedHours();
  });

  // Date picker
  proxyDatePicker = flatpickr('#proxyDateRange', {
    mode: 'single',
    dateFormat: 'M j, Y',
    disableMobile: true,
    onChange(dates) {
      if (dates.length === 1) {
        proxySelectedStart = dates[0];
        proxySelectedEnd = dates[0];
      } else if (dates.length === 2) {
        proxySelectedStart = dates[0];
        proxySelectedEnd = dates[1];
      } else {
        proxySelectedStart = null;
        proxySelectedEnd = null;
      }
      updateProxyComputedHours();
    }
  });

  // Time selects
  populateProxyTimeSelects();
  document.getElementById('proxyStartTime').addEventListener('change', updateProxyComputedHours);
  document.getElementById('proxyEndTime').addEventListener('change', updateProxyComputedHours);

  // Submit
  document.getElementById('proxySubmitBtn').addEventListener('click', submitProxyLeave);
}

function populateProxyTimeSelects() {
  const startSel = document.getElementById('proxyStartTime');
  const endSel   = document.getElementById('proxyEndTime');
  startSel.innerHTML = '<option value="">Start time</option>';
  endSel.innerHTML   = '<option value="">End time</option>';
  for (let h = 6; h <= 18; h++) {
    for (let m = 0; m < 60; m += PROXY_INCREMENT_MINUTES) {
      const hh  = String(h).padStart(2, '0');
      const mm  = String(m).padStart(2, '0');
      const val = `${hh}:${mm}`;
      const ampm = h < 12 ? 'AM' : 'PM';
      const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
      const label = `${h12}:${mm} ${ampm}`;
      startSel.appendChild(new Option(label, val));
      endSel.appendChild(new Option(label, val));
    }
  }
}

function updateProxyComputedHours() {
  const el = document.getElementById('proxyComputedHours');
  if (!el) return;
  const start = document.getElementById('proxyStartTime').value;
  const end   = document.getElementById('proxyEndTime').value;
  if (!start || !end) { el.textContent = 'Total: —'; return; }
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) { el.textContent = 'Total: —'; return; }
  const hrs = mins / 60;
  el.textContent = `Total: ${hrs % 1 === 0 ? hrs : hrs.toFixed(1)} hrs`;
}

function proxyCalculateHours({ startDate, endDate, isHalfDay, isPartial, partialHours }) {
  if (isPartial) return partialHours;
  if (isHalfDay) return proxyWorkdayHours / 2;
  const start = new Date(startDate + 'T00:00:00');
  const end   = new Date(endDate   + 'T00:00:00');
  const days  = Math.round((end - start) / 86400000) + 1;
  return days * proxyWorkdayHours;
}

async function submitProxyLeave() {
  const message = document.getElementById('proxyRequestMessage');
  message.textContent = '';

  const employeeId = document.getElementById('proxyStaffSelect').value;
  const type       = document.getElementById('proxyPtoType').value;
  const duration   = document.getElementById('proxyDuration').value;
  const notes      = document.getElementById('proxyNotes').value.trim();
  const subChoice  = document.querySelector('input[name="proxySubCoverage"]:checked')?.value;

  if (!employeeId) { message.textContent = 'Please select a staff member.'; return; }
  if (!type)       { message.textContent = 'Please select a leave type.'; return; }
  if (!proxySelectedStart || !proxySelectedEnd) { message.textContent = 'Please select leave date(s).'; return; }

  const notesRequired = currentSchoolPtoTypeMeta?.[type]?.notesRequired;
  if (notesRequired && !notes) {
    message.textContent = 'Notes are required for this leave type.';
    document.getElementById('proxyNotesRequiredHint').style.display = 'block';
    document.getElementById('proxyNotes').focus();
    return;
  }
  document.getElementById('proxyNotesRequiredHint').style.display = 'none';

  if (!subChoice) { message.textContent = 'Please indicate whether substitute/coverage is needed.'; return; }

  const startDate = proxySelectedStart.toISOString().slice(0, 10);
  const endDate   = proxySelectedEnd.toISOString().slice(0, 10);
  const isHalfDay  = duration === 'half';
  const isPartial  = duration === 'partial';
  const isMultiDay = duration === 'multi';

  if (isMultiDay && startDate === endDate) {
    message.textContent = 'Please select a date range for multi-day leave.';
    return;
  }

  let startTime = null;
  let endTime   = null;
  let customHours = null;

  if (isPartial) {
    startTime = document.getElementById('proxyStartTime').value;
    endTime   = document.getElementById('proxyEndTime').value;
    if (!startTime) { message.textContent = 'Please select a start time.'; return; }
    if (!endTime)   { message.textContent = 'Please select an end time.'; return; }
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    customHours = ((eh * 60 + em) - (sh * 60 + sm)) / 60;
    if (customHours <= 0) { message.textContent = 'End time must be after start time.'; return; }
  }

  const requestedHours = proxyCalculateHours({ startDate, endDate, isHalfDay, isPartial, partialHours: customHours });
  const durationLabel  = isHalfDay ? 'Half Day' : isPartial ? null : `${requestedHours / proxyWorkdayHours === 1 ? '1 Day' : `${requestedHours / proxyWorkdayHours} Days`}`;

  const btn = document.getElementById('proxySubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';

  const { error } = await supabase.from('pto_requests').insert({
    school_id:                currentProfile.school_id,
    employee_id:              employeeId,
    submitted_by:             currentProfile.employee_id,
    pto_type:                 type,
    start_date:               startDate,
    end_date:                 endDate,
    requested_hours:          requestedHours,
    requested_duration_label: durationLabel,
    partial_day:              isPartial,
    partial_hours:            isPartial ? customHours : null,
    start_time:               startTime,
    end_time:                 endTime,
    notes:                    notes || null,
    status:                   'PENDING',
    needs_sub_coverage:       subChoice === 'yes'
  });

  btn.disabled = false;
  btn.textContent = 'Submit Request';

  if (error) {
    console.error('Proxy submit failed:', error);
    message.textContent = 'Failed to submit leave request.';
    return;
  }

  // Reset form
  document.getElementById('proxyStaffSelect').value = '';
  document.getElementById('proxyPtoType').value = '';
  document.getElementById('proxyDuration').value = 'full';
  document.getElementById('proxyTimeRow').classList.remove('visible');
  document.getElementById('proxyNotes').value = '';
  document.querySelectorAll('input[name="proxySubCoverage"]').forEach(r => r.checked = false);
  if (proxyDatePicker) { proxyDatePicker.set('mode', 'single'); proxyDatePicker.clear(); }
  proxySelectedStart = null;
  proxySelectedEnd = null;
  updateProxyComputedHours();

  showToast('Leave request submitted successfully.', 'success');
}

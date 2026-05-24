
import { supabase } from './admin.supabase.js';
import { esc } from './admin.shared.js';

let profile = null;
let initialized = false;

/* ===============================
   PUBLIC API
================================ */

export async function initAccessRequests(currentProfile) {
  profile = currentProfile;
  await loadAccessRequests();

  if (!initialized) {
    wireEvents();
    initialized = true;
  }
}

export async function getAccessRequestCount(schoolId) {
  const { count } = await supabase
    .from('access_requests')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', schoolId)
    .eq('status', 'pending');
  return count ?? 0;
}

/* ===============================
   LOAD
================================ */

async function loadAccessRequests() {
  const container = document.getElementById('accessRequestsBody');
  if (!container) return;

  container.innerHTML = '<p class="muted">Loading…</p>';

  const { data, error } = await supabase
    .from('access_requests')
    .select(`
      id,
      requested_permissions,
      reason,
      created_at,
      employees (
        first_name,
        last_name,
        profiles!profiles_employee_id_fkey (last_sign_in_at)
      )
    `)
    .eq('school_id', profile.school_id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    container.innerHTML = '<p class="muted">Failed to load.</p>';
    console.error('Access requests load error', error);
    return;
  }

  if (!data?.length) {
    container.innerHTML = '<p class="muted">No pending access requests.</p>';
    return;
  }

  container.innerHTML = '';
  data.forEach(req => {
    const name  = req.employees ? `${req.employees.first_name} ${req.employees.last_name}` : '—';
    const perms = (req.requested_permissions ?? []).join(', ') || '—';
    const date  = new Date(req.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });
    const rawSignIn = req.employees?.profiles?.last_sign_in_at;
    const lastSignIn = rawSignIn
      ? new Date(rawSignIn).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';

    const card = document.createElement('div');
    card.className = 'access-req-card';
    card.innerHTML = `
      <div class="access-req-card-main">
        <div class="access-req-name">${esc(name)}</div>
        <div class="access-req-perms">${esc(perms)}</div>
        <div class="access-req-meta">
          ${req.reason ? `<span>Reason: ${esc(req.reason)}</span>` : ''}
          <span>Submitted: ${date}</span>
          <span>Last sign-in: ${lastSignIn}</span>
        </div>
      </div>
      <div class="access-req-actions">
        <button class="btn btn-sm btn-primary ar-approve-btn"
          data-id="${req.id}"
          data-name="${esc(name)}"
          data-perms="${esc(perms)}">Approve</button>
        <button class="btn btn-sm ar-deny-btn"
          data-id="${req.id}"
          data-name="${esc(name)}">Deny</button>
      </div>
    `;
    container.appendChild(card);
  });

  container.querySelectorAll('.ar-approve-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      openReviewModal(btn.dataset.id, 'approved', btn.dataset.name, btn.dataset.perms));
  });
  container.querySelectorAll('.ar-deny-btn').forEach(btn => {
    btn.addEventListener('click', () =>
      openReviewModal(btn.dataset.id, 'denied', btn.dataset.name, ''));
  });
}

/* ===============================
   REVIEW MODAL
================================ */

function openReviewModal(id, action, name, perms) {
  const modal      = document.getElementById('arReviewModal');
  const title      = document.getElementById('arReviewTitle');
  const noteInput  = document.getElementById('arAdminNote');
  const confirmBtn = document.getElementById('arReviewConfirm');

  noteInput.value = '';
  document.getElementById('arReviewEmployee').textContent = name;

  if (action === 'approved') {
    title.textContent       = 'Approve Access Request';
    confirmBtn.textContent  = 'Approve & Send Reply';
    confirmBtn.className    = 'btn btn-primary';
  } else {
    title.textContent       = 'Deny Access Request';
    confirmBtn.textContent  = 'Deny Request';
    confirmBtn.className    = 'btn danger';
  }

  confirmBtn.onclick = () => submitReview(id, action, name, perms, noteInput.value.trim());
  modal.hidden = false;
}

function closeReviewModal() {
  document.getElementById('arReviewModal').hidden = true;
}

async function submitReview(id, status, name, perms, adminNote) {
  const confirmBtn = document.getElementById('arReviewConfirm');
  const origText   = confirmBtn.textContent;
  confirmBtn.disabled    = true;
  confirmBtn.textContent = 'Saving…';

  const { data: { user } } = await supabase.auth.getUser();

  const { error } = await supabase
    .from('access_requests')
    .update({
      status,
      admin_note:  adminNote || null,
      reviewed_by: user?.id ?? null,
      updated_at:  new Date().toISOString()
    })
    .eq('id', id);

  confirmBtn.disabled    = false;
  confirmBtn.textContent = origText;

  if (error) {
    alert('Failed to submit: ' + error.message);
    return;
  }

  closeReviewModal();

  if (status === 'approved') {
    showApprovalReminder(name, perms);
  }

  await loadAccessRequests();
  await refreshBadge();
}

/* ===============================
   APPROVAL REMINDER
================================ */

function showApprovalReminder(name, perms) {
  document.getElementById('arReminderName').textContent  = name;
  document.getElementById('arReminderPerms').textContent = perms;
  document.getElementById('arReminderModal').hidden = false;
}

/* ===============================
   BADGE
================================ */

async function refreshBadge() {
  const count = await getAccessRequestCount(profile.school_id);
  const badge = document.getElementById('accessRequestBadge');
  if (badge) badge.textContent = count > 0 ? String(count) : '';
}

/* ===============================
   EVENTS
================================ */

function wireEvents() {
  document.getElementById('arReviewCancel')?.addEventListener('click', closeReviewModal);
  document.getElementById('arReminderClose')?.addEventListener('click', () => {
    document.getElementById('arReminderModal').hidden = true;
  });
}


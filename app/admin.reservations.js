// admin.reservations.js
import { supabase } from './admin.supabase.js';
import { esc, dbError, fmtShortDate } from './admin.shared.js';

let profile = null;
let initialized = false;
let resources = [];
let pending = [];
let editingResourceId = null;

/* ===============================
   ENTRY POINT
================================ */
export async function initReservationsSection(p) {
  profile = p;

  if (!profile.is_superadmin && profile.role !== 'admin' && !profile.can_manage_reservations) {
    document.getElementById('reservationsRoot').innerHTML =
      '<p class="muted" style="padding:40px;">You are not authorized to manage reservations.</p>';
    return;
  }

  if (!initialized) {
    wireEvents();
    initialized = true;
  }

  await Promise.all([loadResources(), loadPending()]);
}

/* ===============================
   RESOURCE CATALOG
================================ */
async function loadResources() {
  const { data, error } = await supabase
    .from('reservable_resources')
    .select('id, name, description, color, requires_approval, active, sort_order')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { console.error('loadResources', error); return; }
  resources = data ?? [];
  renderResourceTable();
}

function renderResourceTable() {
  const tbody = document.querySelector('#reservationsResourceTable tbody');
  if (!tbody) return;

  if (!resources.length) {
    tbody.innerHTML = `
      <tr><td colspan="5">
        <div class="admin-empty-state">
          <div class="admin-empty-state-icon"><i data-lucide="calendar-clock"></i></div>
          <p class="admin-empty-state-title">No reservable resources yet</p>
          <p class="admin-empty-state-desc">Add a conference room, the school van, the gym, or anything else staff can book — it'll appear on the Reservations calendar right away.</p>
        </div>
      </td></tr>`;
    if (window.lucide) lucide.createIcons({ el: tbody });
    return;
  }

  tbody.innerHTML = resources.map(r => `
    <tr>
      <td>
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(r.color)};margin-right:8px;vertical-align:middle;"></span>
        ${esc(r.name)}
      </td>
      <td class="staff-cell-muted">${esc(r.description ?? '—')}</td>
      <td>${r.requires_approval ? '<span class="module-pill">Requires approval</span>' : '<span class="staff-cell-muted">Instant booking</span>'}</td>
      <td>${r.active ? '<span class="module-pill">Active</span>' : '<span class="staff-cell-muted">Inactive</span>'}</td>
      <td class="staff-cell-actions">
        <button class="btn btn-sm res-edit-btn" data-id="${esc(r.id)}">Edit</button>
        <button class="btn btn-sm res-delete-btn" data-id="${esc(r.id)}" style="color:#dc2626;border-color:#fca5a5;">Delete</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.res-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEditResourceDrawer(btn.dataset.id)));
  tbody.querySelectorAll('.res-delete-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteResource(btn.dataset.id)));
}

function openAddResourceDrawer() {
  editingResourceId = null;
  document.getElementById('resDrawerTitle').textContent = 'Add Resource';
  document.getElementById('resNameInput').value = '';
  document.getElementById('resDescInput').value = '';
  document.getElementById('resColorInput').value = '#2563eb';
  document.getElementById('resApprovalInput').checked = false;
  document.getElementById('resActiveRow').style.display = 'none';
  window.openDrawer?.('resourceDrawer');
}

function openEditResourceDrawer(id) {
  const r = resources.find(x => x.id === id);
  if (!r) return;
  editingResourceId = id;
  document.getElementById('resDrawerTitle').textContent = 'Edit Resource';
  document.getElementById('resNameInput').value = r.name;
  document.getElementById('resDescInput').value = r.description ?? '';
  document.getElementById('resColorInput').value = r.color ?? '#2563eb';
  document.getElementById('resApprovalInput').checked = !!r.requires_approval;
  document.getElementById('resActiveInput').checked = !!r.active;
  document.getElementById('resActiveRow').style.display = '';
  window.openDrawer?.('resourceDrawer');
}

async function saveResource() {
  const name = document.getElementById('resNameInput').value.trim();
  const description = document.getElementById('resDescInput').value.trim();
  const color = document.getElementById('resColorInput').value || '#2563eb';
  const requiresApproval = document.getElementById('resApprovalInput').checked;

  if (!name) { alert('Resource name is required.'); return; }

  const btn = document.getElementById('resSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  let error;
  if (editingResourceId) {
    const active = document.getElementById('resActiveInput').checked;
    ({ error } = await supabase
      .from('reservable_resources')
      .update({ name, description: description || null, color, requires_approval: requiresApproval, active })
      .eq('id', editingResourceId));
  } else {
    ({ error } = await supabase
      .from('reservable_resources')
      .insert({
        school_id: profile.school_id,
        name,
        description: description || null,
        color,
        requires_approval: requiresApproval,
        sort_order: resources.length,
      }));
  }

  btn.disabled = false;
  btn.textContent = 'Save';

  if (error) { dbError(error, 'Failed to save resource'); alert('Failed to save resource: ' + error.message); return; }

  window.closeDrawer?.('resourceDrawer');
  await loadResources();
}

async function deleteResource(id) {
  const r = resources.find(x => x.id === id);
  if (!r) return;

  const { count, error: countErr } = await supabase
    .from('reservations')
    .select('id', { count: 'exact', head: true })
    .eq('resource_id', id);

  if (countErr) { alert('Failed to check existing reservations.'); return; }

  if (count && count > 0) {
    if (!confirm(`"${r.name}" has ${count} reservation(s) on record and can't be deleted. Deactivate it instead so it no longer accepts new bookings?`)) return;
    const { error } = await supabase.from('reservable_resources').update({ active: false }).eq('id', id);
    if (error) { alert('Failed to deactivate resource: ' + error.message); return; }
    await loadResources();
    return;
  }

  if (!confirm(`Delete "${r.name}"? This cannot be undone.`)) return;
  const { error } = await supabase.from('reservable_resources').delete().eq('id', id);
  if (error) { alert('Failed to delete resource: ' + error.message); return; }
  await loadResources();
}

/* ===============================
   PENDING APPROVALS
================================ */
async function loadPending() {
  const { data, error } = await supabase
    .from('reservations')
    .select('id, title, notes, starts_at, ends_at, reserved_by_name, resource_id, reservable_resources(name)')
    .eq('school_id', profile.school_id)
    .eq('status', 'pending')
    .order('starts_at');

  if (error) { console.error('loadPending', error); return; }
  pending = data ?? [];
  renderPending();
}

function renderPending() {
  const wrap = document.getElementById('reservationsPendingList');
  if (!wrap) return;

  if (!pending.length) {
    wrap.innerHTML = `
      <div class="admin-empty-state" style="padding:24px 16px;">
        <div class="admin-empty-state-icon"><i data-lucide="check"></i></div>
        <p class="admin-empty-state-title">Nothing waiting on you</p>
        <p class="admin-empty-state-desc">Bookings for resources marked "Requires approval" will show up here.</p>
      </div>`;
    if (window.lucide) lucide.createIcons({ el: wrap });
    return;
  }

  wrap.innerHTML = pending.map(r => `
    <div class="access-req-card" data-id="${esc(r.id)}">
      <div class="access-req-card-main">
        <div class="access-req-name">${esc(r.title)} — ${esc(r.reservable_resources?.name ?? 'Unknown resource')}</div>
        <div class="access-req-email">${esc(r.reserved_by_name)} · ${fmtRange(r.starts_at, r.ends_at)}</div>
        ${r.notes ? `<div class="staff-cell-muted" style="margin-top:4px;">${esc(r.notes)}</div>` : ''}
      </div>
      <div class="access-req-actions">
        <button class="btn btn-sm btn-primary res-approve-btn" data-id="${esc(r.id)}">Approve</button>
        <button class="btn btn-sm res-deny-btn" data-id="${esc(r.id)}" style="color:#dc2626;border-color:#fca5a5;">Deny</button>
      </div>
    </div>
  `).join('');

  wrap.querySelectorAll('.res-approve-btn').forEach(btn =>
    btn.addEventListener('click', () => decidePending(btn.dataset.id, 'confirmed')));
  wrap.querySelectorAll('.res-deny-btn').forEach(btn =>
    btn.addEventListener('click', () => decidePending(btn.dataset.id, 'denied')));
}

function fmtRange(startsAt, endsAt) {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  const dateStr = fmtShortDate(startsAt);
  const timeFmt = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${dateStr}, ${timeFmt(s)} – ${timeFmt(e)}`;
}

async function decidePending(id, status) {
  const { error } = await supabase
    .from('reservations')
    .update({ status, decided_by: profile.id, decided_at: new Date().toISOString() })
    .eq('id', id);

  if (error) { alert('Failed to update reservation: ' + error.message); return; }
  await loadPending();
}

/* ===============================
   EVENTS
================================ */
function wireEvents() {
  document.getElementById('resAddResourceBtn')?.addEventListener('click', openAddResourceDrawer);
  document.getElementById('resSaveBtn')?.addEventListener('click', saveResource);
  document.getElementById('resCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceDrawer'));
  document.getElementById('resCloseBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceDrawer'));
}

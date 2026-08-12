// admin.reservations.js
import { supabase } from './admin.supabase.js?v=2';
import { esc, dbError, fmtShortDate } from './admin.shared.js?v=2';

let profile = null;
let initialized = false;
let resources = [];
let groups = [];
let pending = [];
let editingResourceId = null;
let editingGroupId = null;
let resMode = 'single';

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

  await loadGroups();
  await Promise.all([loadResources(), loadPending()]);
}

/* ===============================
   RESOURCE CATALOG
================================ */
async function loadGroups() {
  const { data, error } = await supabase
    .from('resource_groups')
    .select('id, name, description, color, requires_approval, sort_order')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { console.error('loadGroups', error); return; }
  groups = data ?? [];
}

async function loadResources() {
  const { data, error } = await supabase
    .from('reservable_resources')
    .select('id, name, description, color, requires_approval, active, sort_order, group_id')
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

  if (!resources.length && !groups.length) {
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

  const memberRow = r => `
    <tr>
      <td style="padding-left:${r.group_id ? '30px' : '16px'};">
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
    </tr>`;

  const groupHeaderRow = (g, memberCount) => `
    <tr style="background:#f8fafc;">
      <td colspan="4">
        <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${esc(g.color)};margin-right:8px;vertical-align:middle;"></span>
        <strong>${esc(g.name)}</strong>
        <span class="staff-cell-muted">(${memberCount} resource${memberCount === 1 ? '' : 's'})</span>
      </td>
      <td class="staff-cell-actions">
        <button class="btn btn-sm res-add-member-btn" data-group-id="${esc(g.id)}">+ Add</button>
        <button class="btn btn-sm res-edit-group-btn" data-group-id="${esc(g.id)}">Edit Group</button>
      </td>
    </tr>`;

  const ungrouped = resources.filter(r => !r.group_id);

  let html = '';
  groups.forEach(g => {
    const members = resources.filter(r => r.group_id === g.id);
    html += groupHeaderRow(g, members.length);
    html += members.length
      ? members.map(memberRow).join('')
      : `<tr><td colspan="4" class="staff-cell-muted" style="padding-left:30px;">No resources yet — click "+ Add" to create one.</td><td></td></tr>`;
  });
  if (ungrouped.length) {
    if (groups.length) {
      html += `<tr><td colspan="5" style="font-weight:700;padding-top:14px;color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.03em;">Ungrouped</td></tr>`;
    }
    html += ungrouped.map(memberRow).join('');
  }

  tbody.innerHTML = html;

  tbody.querySelectorAll('.res-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEditResourceDrawer(btn.dataset.id)));
  tbody.querySelectorAll('.res-delete-btn').forEach(btn =>
    btn.addEventListener('click', () => deleteResource(btn.dataset.id)));
  tbody.querySelectorAll('.res-add-member-btn').forEach(btn =>
    btn.addEventListener('click', () => openAddResourceDrawer(btn.dataset.groupId)));
  tbody.querySelectorAll('.res-edit-group-btn').forEach(btn =>
    btn.addEventListener('click', () => openEditGroupDrawer(btn.dataset.groupId)));
}

function setResMode(mode) {
  resMode = mode;
  document.getElementById('resModeSingle').checked = mode === 'single';
  document.getElementById('resModeGroup').checked = mode === 'group';
  document.getElementById('resNameLabel').textContent = mode === 'group' ? 'Group name' : 'Name';
  document.getElementById('resNameInput').placeholder =
    mode === 'group' ? 'e.g. Upper School Chromebook Carts' : 'e.g. Conference Room, School Van';
  document.getElementById('resGroupSelectRow').style.display = mode === 'group' ? 'none' : '';
  document.getElementById('resGroupModeFields').style.display = mode === 'group' ? '' : 'none';
}

function populateGroupSelect(selectedId) {
  const sel = document.getElementById('resGroupSelectInput');
  if (!sel) return;
  sel.innerHTML = '<option value="">No group</option>' +
    groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  sel.value = selectedId || '';
}

function openAddResourceDrawer(prefillGroupId) {
  editingResourceId = null;
  document.getElementById('resDrawerTitle').textContent = 'Add Resource';
  document.getElementById('resModeRow').style.display = '';
  setResMode('single');
  document.getElementById('resNameInput').value = '';
  document.getElementById('resDescInput').value = '';
  document.getElementById('resColorInput').value = '#2563eb';
  document.getElementById('resApprovalInput').checked = false;
  document.getElementById('resActiveRow').style.display = 'none';
  document.getElementById('resMembersInput').value = '';
  document.getElementById('resMemberPrefix').value = '';
  document.getElementById('resMemberFrom').value = '';
  document.getElementById('resMemberTo').value = '';
  populateGroupSelect(typeof prefillGroupId === 'string' ? prefillGroupId : '');
  window.openDrawer?.('resourceDrawer');
}

function openEditResourceDrawer(id) {
  const r = resources.find(x => x.id === id);
  if (!r) return;
  editingResourceId = id;
  document.getElementById('resDrawerTitle').textContent = 'Edit Resource';
  document.getElementById('resModeRow').style.display = 'none';
  setResMode('single');
  document.getElementById('resNameInput').value = r.name;
  document.getElementById('resDescInput').value = r.description ?? '';
  document.getElementById('resColorInput').value = r.color ?? '#2563eb';
  document.getElementById('resApprovalInput').checked = !!r.requires_approval;
  document.getElementById('resActiveInput').checked = !!r.active;
  document.getElementById('resActiveRow').style.display = '';
  populateGroupSelect(r.group_id || '');
  window.openDrawer?.('resourceDrawer');
}

async function saveResource() {
  const name = document.getElementById('resNameInput').value.trim();
  const description = document.getElementById('resDescInput').value.trim();
  const color = document.getElementById('resColorInput').value || '#2563eb';
  const requiresApproval = document.getElementById('resApprovalInput').checked;
  const creatingGroup = !editingResourceId && resMode === 'group';

  if (!name) { alert(`${creatingGroup ? 'Group' : 'Resource'} name is required.`); return; }

  let memberNames = [];
  if (creatingGroup) {
    memberNames = document.getElementById('resMembersInput').value
      .split('\n').map(s => s.trim()).filter(Boolean);
    if (!memberNames.length) {
      alert('Add at least one member (e.g. "Cart 1"), one per line.');
      return;
    }
  }

  const btn = document.getElementById('resSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  let error;

  if (creatingGroup) {
    const { data: group, error: groupErr } = await supabase
      .from('resource_groups')
      .insert({
        school_id: profile.school_id,
        name,
        description: description || null,
        color,
        requires_approval: requiresApproval,
        sort_order: groups.length,
      })
      .select('id')
      .single();

    if (groupErr || !group) {
      btn.disabled = false;
      btn.textContent = 'Save';
      alert('Failed to create group: ' + (groupErr?.message ?? 'unknown error'));
      return;
    }

    const { error: membersErr } = await supabase.from('reservable_resources').insert(
      memberNames.map((n, i) => ({
        school_id: profile.school_id,
        group_id: group.id,
        name: n,
        color,
        requires_approval: requiresApproval,
        sort_order: i,
      }))
    );

    btn.disabled = false;
    btn.textContent = 'Save';

    if (membersErr) {
      // The group itself was already created even though the members
      // failed partway through — refresh and close so the admin can see
      // the (possibly empty) group and use "+ Add" to retry, rather than
      // leaving the drawer open on an error while a group silently exists
      // in the background.
      console.error('Failed to insert group members:', membersErr);
      alert(`The group "${name}" was created, but adding its members failed: ${membersErr.message}\n\nUse "+ Add" on the group to add them.`);
      window.closeDrawer?.('resourceDrawer');
      await loadGroups();
      await loadResources();
      return;
    }

    window.closeDrawer?.('resourceDrawer');
    await loadGroups();
    await loadResources();
    return;
  } else if (editingResourceId) {
    const active = document.getElementById('resActiveInput').checked;
    const groupId = document.getElementById('resGroupSelectInput').value || null;
    ({ error } = await supabase
      .from('reservable_resources')
      .update({ name, description: description || null, color, requires_approval: requiresApproval, active, group_id: groupId })
      .eq('id', editingResourceId));
  } else {
    const groupId = document.getElementById('resGroupSelectInput').value || null;
    ({ error } = await supabase
      .from('reservable_resources')
      .insert({
        school_id: profile.school_id,
        group_id: groupId,
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
  await loadGroups();
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
   RESOURCE GROUPS
================================ */
function openEditGroupDrawer(id) {
  const g = groups.find(x => x.id === id);
  if (!g) return;
  editingGroupId = id;
  document.getElementById('resGroupDrawerTitle').textContent = 'Edit Group';
  document.getElementById('resGroupNameInput').value = g.name;
  document.getElementById('resGroupDescInput').value = g.description ?? '';
  document.getElementById('resGroupColorInput').value = g.color ?? '#2563eb';
  document.getElementById('resGroupApprovalInput').checked = !!g.requires_approval;

  const memberCount = resources.filter(r => r.group_id === id).length;
  const delBtn = document.getElementById('resGroupDeleteBtn');
  delBtn.disabled = memberCount > 0;
  delBtn.title = memberCount > 0 ? 'Remove all resources from this group first.' : '';

  window.openDrawer?.('resourceGroupDrawer');
}

async function saveGroup() {
  if (!editingGroupId) return;

  const name = document.getElementById('resGroupNameInput').value.trim();
  const description = document.getElementById('resGroupDescInput').value.trim();
  const color = document.getElementById('resGroupColorInput').value || '#2563eb';
  const requiresApproval = document.getElementById('resGroupApprovalInput').checked;

  if (!name) { alert('Group name is required.'); return; }

  const btn = document.getElementById('resGroupSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await supabase
    .from('resource_groups')
    .update({ name, description: description || null, color, requires_approval: requiresApproval })
    .eq('id', editingGroupId);

  btn.disabled = false;
  btn.textContent = 'Save';

  if (error) { alert('Failed to save group: ' + error.message); return; }

  window.closeDrawer?.('resourceGroupDrawer');
  await loadGroups();
  renderResourceTable();
}

async function deleteGroup(id) {
  const g = groups.find(x => x.id === id);
  if (!g) return;

  const memberCount = resources.filter(r => r.group_id === id).length;
  if (memberCount > 0) {
    alert(`"${g.name}" still has ${memberCount} resource(s) in it. Move or delete them first.`);
    return;
  }

  if (!confirm(`Delete the group "${g.name}"? This cannot be undone.`)) return;
  const { error } = await supabase.from('resource_groups').delete().eq('id', id);
  if (error) { alert('Failed to delete group: ' + error.message); return; }

  await loadGroups();
  renderResourceTable();
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
  document.getElementById('resAddResourceBtn')?.addEventListener('click', () => openAddResourceDrawer());
  document.getElementById('resSaveBtn')?.addEventListener('click', saveResource);
  document.getElementById('resCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceDrawer'));
  document.getElementById('resCloseBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceDrawer'));
  document.getElementById('resModeSingle')?.addEventListener('change', () => setResMode('single'));
  document.getElementById('resModeGroup')?.addEventListener('change', () => setResMode('group'));
  document.getElementById('resMemberGenBtn')?.addEventListener('click', generateMembers);

  document.getElementById('resGroupSaveBtn')?.addEventListener('click', saveGroup);
  document.getElementById('resGroupCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceGroupDrawer'));
  document.getElementById('resGroupCloseBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceGroupDrawer'));
  document.getElementById('resGroupDeleteBtn')?.addEventListener('click', () => {
    if (!editingGroupId) return;
    const id = editingGroupId;
    window.closeDrawer?.('resourceGroupDrawer');
    deleteGroup(id);
  });
}

function generateMembers() {
  const prefix = document.getElementById('resMemberPrefix').value.trim();
  const from = parseInt(document.getElementById('resMemberFrom').value, 10);
  const to = parseInt(document.getElementById('resMemberTo').value, 10);

  if (!prefix || isNaN(from) || isNaN(to) || to < from) {
    alert('Enter a prefix and a valid from/to range.');
    return;
  }
  if (to - from > 200) { alert('That range is too large — please narrow it.'); return; }

  const lines = [];
  for (let i = from; i <= to; i++) lines.push(`${prefix} ${i}`);
  document.getElementById('resMembersInput').value = lines.join('\n');
}

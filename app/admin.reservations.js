// admin.reservations.js
import { supabase } from './admin.supabase.js?v=2';
import { esc, dbError, fmtShortDate } from './admin.shared.js?v=3';

let profile = null;
let initialized = false;
let resources = [];
let groups = [];
let pending = [];
let campuses = [];
let timeBlocks = [];
let editingResourceId = null;
let editingGroupId = null;
let editingTimeBlockId = null;
let resMode = 'single';

const FIELD_SETTINGS_COLUMNS = 'campus_id, use_time_blocks, title_label, title_input_type, title_max_value, policy_text';

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

  await loadCampuses();
  await loadGroups();
  await Promise.all([loadResources(), loadPending(), loadTimeBlocks()]);
}

/* ===============================
   CAMPUSES (for scoping resources/groups/blocks)
================================ */
async function loadCampuses() {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', profile.school_id)
    .order('name');

  if (error) { console.error('loadCampuses', error); return; }
  campuses = data ?? [];
}

function populateCampusSelect(selectEl, selectedId) {
  if (!selectEl) return;
  selectEl.innerHTML = '<option value="">All campuses</option>' +
    campuses.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  selectEl.value = selectedId || '';
}

/* ===============================
   RESOURCE CATALOG
================================ */
async function loadGroups() {
  const { data, error } = await supabase
    .from('resource_groups')
    .select(`id, name, description, color, requires_approval, sort_order, ${FIELD_SETTINGS_COLUMNS}`)
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { console.error('loadGroups', error); return; }
  groups = data ?? [];
}

async function loadResources() {
  const { data, error } = await supabase
    .from('reservable_resources')
    .select(`id, name, description, color, requires_approval, active, sort_order, group_id, ${FIELD_SETTINGS_COLUMNS}`)
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { console.error('loadResources', error); return; }
  resources = data ?? [];
  renderResourceTable();
}

/* ===============================
   RESERVATION FIELD SETTINGS
   (campus, title label/type/max, policy text, time blocks) — shared
   between single resources and groups; locked to the group's values
   when a resource belongs to one, so the whole group stays consistent.
================================ */
function readFieldSettingsFromForm(prefix) {
  const type = document.getElementById(`${prefix}TitleTypeInput`).value === 'number' ? 'number' : 'text';
  return {
    campus_id: document.getElementById(`${prefix}CampusInput`).value || null,
    title_label: document.getElementById(`${prefix}TitleLabelInput`).value.trim() || 'Title',
    title_input_type: type,
    title_max_value: type === 'number'
      ? (parseInt(document.getElementById(`${prefix}TitleMaxInput`).value, 10) || null)
      : null,
    policy_text: document.getElementById(`${prefix}PolicyTextInput`).value.trim() || null,
    use_time_blocks: document.getElementById(`${prefix}UseTimeBlocksInput`).checked,
  };
}

function fieldSettingsFromGroup(g) {
  return {
    campus_id: g?.campus_id || null,
    title_label: g?.title_label || 'Title',
    title_input_type: g?.title_input_type || 'text',
    title_max_value: g?.title_max_value ?? null,
    policy_text: g?.policy_text || null,
    use_time_blocks: !!g?.use_time_blocks,
  };
}

function updateTitleTypeUI(prefix) {
  const type = document.getElementById(`${prefix}TitleTypeInput`).value;
  const maxRowId = prefix === 'res' ? 'resTitleMaxRow' : 'resGroupTitleMaxRow';
  document.getElementById(maxRowId).style.display = type === 'number' ? '' : 'none';
}

// A resource's campus/title/policy/time-block settings are locked to its
// group's once it belongs to one (set here in the resource drawer, edited
// only via the group drawer) — otherwise every member could drift out of
// sync with what the group's booking modal is supposed to look like.
function refreshCustomFieldsLock() {
  const groupSel = document.getElementById('resGroupSelectInput');
  const groupId = groupSel ? groupSel.value : '';
  const isNewGroup = resMode === 'group' && !editingResourceId;
  const locked = !isNewGroup && !!groupId;

  document.getElementById('resCampusRow').style.display = locked ? 'none' : '';
  document.getElementById('resCustomFieldsBlock').style.display = locked ? 'none' : '';
  const note = document.getElementById('resCustomFieldsNote');
  if (locked) {
    const g = groups.find(x => x.id === groupId);
    note.style.display = '';
    note.textContent = `Campus and reservation-field settings are managed on the group "${g ? g.name : ''}" — edit the group to change them for all its members.`;
  } else {
    note.style.display = 'none';
  }
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
  refreshCustomFieldsLock();
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
  populateCampusSelect(document.getElementById('resCampusInput'), '');
  document.getElementById('resTitleLabelInput').value = 'Title';
  document.getElementById('resTitleTypeInput').value = 'text';
  document.getElementById('resTitleMaxInput').value = '';
  document.getElementById('resPolicyTextInput').value = '';
  document.getElementById('resUseTimeBlocksInput').checked = false;
  updateTitleTypeUI('res');
  populateGroupSelect(typeof prefillGroupId === 'string' ? prefillGroupId : '');
  refreshCustomFieldsLock();
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
  populateCampusSelect(document.getElementById('resCampusInput'), r.campus_id || '');
  document.getElementById('resTitleLabelInput').value = r.title_label || 'Title';
  document.getElementById('resTitleTypeInput').value = r.title_input_type || 'text';
  document.getElementById('resTitleMaxInput').value = r.title_max_value ?? '';
  document.getElementById('resPolicyTextInput').value = r.policy_text ?? '';
  document.getElementById('resUseTimeBlocksInput').checked = !!r.use_time_blocks;
  updateTitleTypeUI('res');
  populateGroupSelect(r.group_id || '');
  refreshCustomFieldsLock();
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
    const groupFieldSettings = readFieldSettingsFromForm('res');
    const { data: group, error: groupErr } = await supabase
      .from('resource_groups')
      .insert({
        school_id: profile.school_id,
        name,
        description: description || null,
        color,
        requires_approval: requiresApproval,
        sort_order: groups.length,
        ...groupFieldSettings,
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
        ...groupFieldSettings,
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
    const fieldSettings = groupId
      ? fieldSettingsFromGroup(groups.find(g => g.id === groupId))
      : readFieldSettingsFromForm('res');
    ({ error } = await supabase
      .from('reservable_resources')
      .update({ name, description: description || null, color, requires_approval: requiresApproval, active, group_id: groupId, ...fieldSettings })
      .eq('id', editingResourceId));
  } else {
    const groupId = document.getElementById('resGroupSelectInput').value || null;
    const fieldSettings = groupId
      ? fieldSettingsFromGroup(groups.find(g => g.id === groupId))
      : readFieldSettingsFromForm('res');
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
        ...fieldSettings,
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
  populateCampusSelect(document.getElementById('resGroupCampusInput'), g.campus_id || '');
  document.getElementById('resGroupTitleLabelInput').value = g.title_label || 'Title';
  document.getElementById('resGroupTitleTypeInput').value = g.title_input_type || 'text';
  document.getElementById('resGroupTitleMaxInput').value = g.title_max_value ?? '';
  document.getElementById('resGroupPolicyTextInput').value = g.policy_text ?? '';
  document.getElementById('resGroupUseTimeBlocksInput').checked = !!g.use_time_blocks;
  updateTitleTypeUI('resGroup');

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
  const fieldSettings = readFieldSettingsFromForm('resGroup');

  if (!name) { alert('Group name is required.'); return; }

  const btn = document.getElementById('resGroupSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = await supabase
    .from('resource_groups')
    .update({ name, description: description || null, color, requires_approval: requiresApproval, ...fieldSettings })
    .eq('id', editingGroupId);

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Save';
    alert('Failed to save group: ' + error.message);
    return;
  }

  // Cascade the booking-field settings (not color/requires_approval, which
  // stay per-member by design) to every current member so the group's
  // booking modal stays consistent across all its resources.
  const { error: cascadeErr } = await supabase
    .from('reservable_resources')
    .update(fieldSettings)
    .eq('group_id', editingGroupId);

  btn.disabled = false;
  btn.textContent = 'Save';

  if (cascadeErr) {
    console.error('Failed to cascade group field settings to members', cascadeErr);
    alert(`The group was saved, but updating its members' booking fields failed: ${cascadeErr.message}`);
  }

  window.closeDrawer?.('resourceGroupDrawer');
  await loadGroups();
  await loadResources();
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
   TIME BLOCKS
================================ */
async function loadTimeBlocks() {
  const { data, error } = await supabase
    .from('resource_time_blocks')
    .select('id, label, start_time, end_time, campus_id, sort_order, active')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('start_time');

  if (error) { console.error('loadTimeBlocks', error); return; }
  timeBlocks = data ?? [];
  renderTimeBlockTable();
}

function fmtBlockTime(t) {
  if (!t) return '—';
  const [h, m] = t.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function renderTimeBlockTable() {
  const tbody = document.querySelector('#reservationsTimeBlockTable tbody');
  if (!tbody) return;

  if (!timeBlocks.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="staff-cell-muted" style="padding:16px;">No time blocks yet — add one so resources can offer preset booking periods instead of exact times.</td></tr>`;
    return;
  }

  const campusLookup = Object.fromEntries(campuses.map(c => [c.id, c.name]));

  tbody.innerHTML = timeBlocks.map(b => `
    <tr>
      <td>${esc(b.label)}</td>
      <td class="staff-cell-muted">${esc(fmtBlockTime(b.start_time))}</td>
      <td class="staff-cell-muted">${esc(fmtBlockTime(b.end_time))}</td>
      <td class="staff-cell-muted">${esc(b.campus_id ? (campusLookup[b.campus_id] ?? 'Unknown') : 'All campuses')}</td>
      <td>${b.active ? '<span class="module-pill">Active</span>' : '<span class="staff-cell-muted">Inactive</span>'}</td>
      <td class="staff-cell-actions">
        <button class="btn btn-sm tb-edit-btn" data-id="${esc(b.id)}">Edit</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.tb-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEditTimeBlockDrawer(btn.dataset.id)));
}

function openAddTimeBlockDrawer() {
  editingTimeBlockId = null;
  document.getElementById('tbDrawerTitle').textContent = 'Add Time Block';
  document.getElementById('tbLabelInput').value = '';
  document.getElementById('tbStartInput').value = '';
  document.getElementById('tbEndInput').value = '';
  populateCampusSelect(document.getElementById('tbCampusInput'), '');
  document.getElementById('tbActiveRow').style.display = 'none';
  document.getElementById('tbDeleteBtn').style.display = 'none';
  window.openDrawer?.('timeBlockDrawer');
}

function openEditTimeBlockDrawer(id) {
  const b = timeBlocks.find(x => x.id === id);
  if (!b) return;
  editingTimeBlockId = id;
  document.getElementById('tbDrawerTitle').textContent = 'Edit Time Block';
  document.getElementById('tbLabelInput').value = b.label;
  document.getElementById('tbStartInput').value = (b.start_time || '').slice(0, 5);
  document.getElementById('tbEndInput').value = (b.end_time || '').slice(0, 5);
  populateCampusSelect(document.getElementById('tbCampusInput'), b.campus_id || '');
  document.getElementById('tbActiveInput').checked = !!b.active;
  document.getElementById('tbActiveRow').style.display = '';
  document.getElementById('tbDeleteBtn').style.display = '';
  window.openDrawer?.('timeBlockDrawer');
}

async function saveTimeBlock() {
  const label = document.getElementById('tbLabelInput').value.trim();
  const start = document.getElementById('tbStartInput').value;
  const end = document.getElementById('tbEndInput').value;
  const campusId = document.getElementById('tbCampusInput').value || null;

  if (!label || !start || !end) { alert('Label, start time, and end time are required.'); return; }
  if (end <= start) { alert('End time must be after the start time.'); return; }

  const btn = document.getElementById('tbSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  let error;
  if (editingTimeBlockId) {
    const active = document.getElementById('tbActiveInput').checked;
    ({ error } = await supabase
      .from('resource_time_blocks')
      .update({ label, start_time: start, end_time: end, campus_id: campusId, active })
      .eq('id', editingTimeBlockId));
  } else {
    ({ error } = await supabase
      .from('resource_time_blocks')
      .insert({ school_id: profile.school_id, label, start_time: start, end_time: end, campus_id: campusId, sort_order: timeBlocks.length }));
  }

  btn.disabled = false;
  btn.textContent = 'Save';

  if (error) { alert('Failed to save time block: ' + error.message); return; }

  window.closeDrawer?.('timeBlockDrawer');
  await loadTimeBlocks();
}

async function deleteTimeBlock() {
  if (!editingTimeBlockId) return;
  if (!confirm('Delete this time block? Resources using time blocks will no longer offer it as an option.')) return;

  const { error } = await supabase.from('resource_time_blocks').delete().eq('id', editingTimeBlockId);
  if (error) { alert('Failed to delete time block: ' + error.message); return; }

  window.closeDrawer?.('timeBlockDrawer');
  editingTimeBlockId = null;
  await loadTimeBlocks();
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
  document.getElementById('resGroupSelectInput')?.addEventListener('change', refreshCustomFieldsLock);
  document.getElementById('resTitleTypeInput')?.addEventListener('change', () => updateTitleTypeUI('res'));

  document.getElementById('resGroupSaveBtn')?.addEventListener('click', saveGroup);
  document.getElementById('resGroupCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceGroupDrawer'));
  document.getElementById('resGroupCloseBtn')?.addEventListener('click', () => window.closeDrawer?.('resourceGroupDrawer'));
  document.getElementById('resGroupDeleteBtn')?.addEventListener('click', () => {
    if (!editingGroupId) return;
    const id = editingGroupId;
    window.closeDrawer?.('resourceGroupDrawer');
    deleteGroup(id);
  });
  document.getElementById('resGroupTitleTypeInput')?.addEventListener('change', () => updateTitleTypeUI('resGroup'));

  document.getElementById('resAddTimeBlockBtn')?.addEventListener('click', openAddTimeBlockDrawer);
  document.getElementById('tbSaveBtn')?.addEventListener('click', saveTimeBlock);
  document.getElementById('tbCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('timeBlockDrawer'));
  document.getElementById('tbCloseBtn')?.addEventListener('click', () => window.closeDrawer?.('timeBlockDrawer'));
  document.getElementById('tbDeleteBtn')?.addEventListener('click', deleteTimeBlock);
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

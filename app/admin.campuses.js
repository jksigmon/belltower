import { supabase } from './admin.supabase.js';
import { esc, getAvatarColor, fmtTime, dbError } from './admin.shared.js';

let currentProfile;
let campuses = [];
let staffGroups = [];
let eventsWired = false;
let editingCampusId = null;
let editingGroupId = null;

/* ===============================
   ENTRY POINT
================================ */

export async function initCampusesSection(profile) {
  currentProfile = profile;
  if (!eventsWired) {
    wireStaticEvents();
    eventsWired = true;
    await Promise.all([loadCampuses(), loadStaffGroups()]);
  }
}

/* ===============================
   DATA
================================ */

async function loadCampuses() {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, name, day_start_time, day_end_time, workday_hours, pto_increment_minutes')
    .eq('school_id', currentProfile.school_id)
    .order('name');

  if (error) { console.error('Failed to load campuses', error); return; }
  campuses = data || [];
  renderCampusTable();
}

async function loadStaffGroups() {
  const { data, error } = await supabase
    .from('staff_groups')
    .select('id, name, sort_order')
    .eq('school_id', currentProfile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { console.error('Failed to load staff groups', error); return; }
  staffGroups = data || [];
  renderStaffGroupTable();
}

/* ===============================
   HELPERS
================================ */

/* ===============================
   RENDER TABLE
================================ */

function renderCampusTable() {
  const tbody = document.querySelector('#campusTable tbody');
  const empty = document.getElementById('campusEmpty');
  const table = document.getElementById('campusTable');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!campuses.length) {
    if (empty) empty.hidden = false;
    if (table) table.style.display = 'none';
    return;
  }

  if (empty) empty.hidden = true;
  if (table) table.style.display = '';

  campuses.forEach(c => {
    const initial = (c.name ?? '?')[0].toUpperCase();
    const color   = getAvatarColor(c.name ?? '');

    const hoursVal     = c.workday_hours != null ? `${c.workday_hours} hrs` : '—';
    const incrementVal = c.pto_increment_minutes != null ? `${c.pto_increment_minutes} min` : '—';

    const tr = document.createElement('tr');
    tr.className = 'dir-row-link';
    tr.innerHTML = `
      <td>
        <div class="staff-name-cell">
          <div class="staff-avatar" style="background:${color}">${initial}</div>
          <div class="staff-name-group">
            <span class="staff-fullname">${esc(c.name)}</span>
          </div>
        </div>
      </td>
      <td class="staff-cell-muted">${esc(fmtTime(c.day_start_time))}</td>
      <td class="staff-cell-muted">${esc(fmtTime(c.day_end_time))}</td>
      <td class="staff-cell-muted">${esc(hoursVal)}</td>
      <td class="staff-cell-muted">${esc(incrementVal)}</td>
      <td class="staff-cell-chevron">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </td>
    `;

    tr.addEventListener('click', () => openEditCampusDrawer(c));
    tbody.appendChild(tr);
  });
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditCampusDrawer(c) {
  editingCampusId = c.id;

  const initial = (c.name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(c.name ?? '');

  const avatar = document.getElementById('ecAvatar');
  avatar.textContent      = initial;
  avatar.style.background = color;

  document.getElementById('ecTitle').textContent    = c.name;
  document.getElementById('ecSubtitle').textContent =
    (c.day_start_time && c.day_end_time)
      ? `${fmtTime(c.day_start_time)} – ${fmtTime(c.day_end_time)}`
      : '';

  document.getElementById('ecName').value      = c.name ?? '';
  document.getElementById('ecStart').value     = c.day_start_time ? c.day_start_time.slice(0, 5) : '';
  document.getElementById('ecEnd').value       = c.day_end_time   ? c.day_end_time.slice(0, 5)   : '';
  document.getElementById('ecHours').value     = c.workday_hours ?? '';
  document.getElementById('ecIncrement').value = c.pto_increment_minutes ?? '';

  const saveBtn = document.getElementById('ecSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editCampusDrawer');
}

async function saveEditCampus() {
  if (!editingCampusId) return;

  const name = document.getElementById('ecName').value.trim();
  if (!name) { alert('Campus name is required.'); return; }

  const updated = {
    name,
    day_start_time:        document.getElementById('ecStart').value     || null,
    day_end_time:          document.getElementById('ecEnd').value       || null,
    workday_hours:         parseFloat(document.getElementById('ecHours').value)     || null,
    pto_increment_minutes: parseInt(document.getElementById('ecIncrement').value)   || null,
  };

  const saveBtn = document.getElementById('ecSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('campuses').update(updated).eq('id', editingCampusId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { dbError(error, 'Failed to save campus'); return; }
  window.closeDrawer?.('editCampusDrawer');
  await loadCampuses();
}

function confirmDeleteCampus() {
  if (!editingCampusId) return;
  const name = document.getElementById('ecName').value;
  document.getElementById('deleteCampusMsg').textContent =
    `Are you sure you want to delete "${name}"?\n\nStaff, students, and licensure records assigned to this campus will become unassigned. This cannot be undone.`;
  document.getElementById('deleteCampusModal').hidden = false;
}

async function executeDeleteCampus() {
  if (!editingCampusId) return;
  const { error } = await supabase.from('campuses').delete().eq('id', editingCampusId);
  document.getElementById('deleteCampusModal').hidden = true;
  if (error) { dbError(error, 'Failed to delete campus'); return; }
  window.closeDrawer?.('editCampusDrawer');
  editingCampusId = null;
  await loadCampuses();
}

/* ===============================
   CREATE
================================ */

async function createCampus() {
  const name      = document.getElementById('campusName').value.trim();
  const startTime = document.getElementById('campusStart').value || null;
  const endTime   = document.getElementById('campusEnd').value   || null;
  const hours     = parseFloat(document.getElementById('campusHours').value)     || null;
  const increment = parseInt(document.getElementById('campusIncrement').value)   || null;

  if (!name) { alert('Campus name is required.'); return; }

  const { error } = await supabase.from('campuses').insert({
    school_id:             currentProfile.school_id,
    name,
    day_start_time:        startTime,
    day_end_time:          endTime,
    workday_hours:         hours,
    pto_increment_minutes: increment,
  });

  if (error) { dbError(error, 'Failed to create campus'); return; }

  ['campusName', 'campusStart', 'campusEnd', 'campusHours', 'campusIncrement']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

  window.closeDrawer?.('campusDrawer');
  await loadCampuses();
}

/* ===============================
   STAFF GROUPS — RENDER
================================ */

function renderStaffGroupTable() {
  const tbody = document.querySelector('#staffGroupTable tbody');
  const empty = document.getElementById('staffGroupEmpty');
  const table = document.getElementById('staffGroupTable');
  if (!tbody) return;

  tbody.innerHTML = '';

  if (!staffGroups.length) {
    if (empty) empty.hidden = false;
    if (table) table.style.display = 'none';
    return;
  }

  if (empty) empty.hidden = true;
  if (table) table.style.display = '';

  staffGroups.forEach(g => {
    const tr = document.createElement('tr');
    tr.className = 'dir-row-link';
    tr.innerHTML = `
      <td style="font-weight:500;">${esc(g.name)}</td>
      <td class="staff-cell-muted">${g.sort_order}</td>
      <td class="staff-cell-chevron">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </td>
    `;
    tr.addEventListener('click', () => openEditStaffGroupDrawer(g));
    tbody.appendChild(tr);
  });
}

/* ===============================
   STAFF GROUPS — EDIT DRAWER
================================ */

function openEditStaffGroupDrawer(g) {
  editingGroupId = g.id;
  document.getElementById('esgName').value      = g.name ?? '';
  document.getElementById('esgSortOrder').value = g.sort_order ?? 99;

  const saveBtn = document.getElementById('esgSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editStaffGroupDrawer');
}

async function saveEditStaffGroup() {
  if (!editingGroupId) return;

  const name      = document.getElementById('esgName').value.trim();
  const sortOrder = parseInt(document.getElementById('esgSortOrder').value) || 99;
  if (!name) { alert('Group name is required.'); return; }

  const saveBtn = document.getElementById('esgSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('staff_groups')
    .update({ name, sort_order: sortOrder })
    .eq('id', editingGroupId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { dbError(error, 'Failed to save staff group'); return; }
  window.closeDrawer?.('editStaffGroupDrawer');
  await loadStaffGroups();
}

function confirmDeleteStaffGroup() {
  if (!editingGroupId) return;
  const name = document.getElementById('esgName').value;
  document.getElementById('deleteStaffGroupMsg').textContent =
    `Are you sure you want to delete "${name}"? Staff assigned to this group will become unassigned.`;
  document.getElementById('deleteStaffGroupModal').hidden = false;
}

async function executeDeleteStaffGroup() {
  if (!editingGroupId) return;
  const { error } = await supabase.from('staff_groups').delete().eq('id', editingGroupId);
  document.getElementById('deleteStaffGroupModal').hidden = true;
  if (error) { dbError(error, 'Failed to delete staff group'); return; }
  window.closeDrawer?.('editStaffGroupDrawer');
  editingGroupId = null;
  await loadStaffGroups();
}

/* ===============================
   STAFF GROUPS — CREATE
================================ */

async function createStaffGroup() {
  const name      = document.getElementById('sgName').value.trim();
  const sortOrder = parseInt(document.getElementById('sgSortOrder').value) || 99;
  if (!name) { alert('Group name is required.'); return; }

  const { error } = await supabase.from('staff_groups').insert({
    school_id:  currentProfile.school_id,
    name,
    sort_order: sortOrder,
  });

  if (error) { dbError(error, 'Failed to create staff group'); return; }

  document.getElementById('sgName').value      = '';
  document.getElementById('sgSortOrder').value = '99';

  window.closeDrawer?.('staffGroupDrawer');
  await loadStaffGroups();
}

/* ===============================
   EVENTS
================================ */

function wireStaticEvents() {
  document.getElementById('addCampus')?.addEventListener('click', createCampus);

  // Campus edit drawer
  document.getElementById('ecSaveBtn')?.addEventListener('click',   saveEditCampus);
  document.getElementById('ecCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editCampusDrawer'));
  document.getElementById('ecCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editCampusDrawer'));
  document.getElementById('ecDeleteBtn')?.addEventListener('click', confirmDeleteCampus);

  // Campus delete modal
  document.getElementById('deleteCampusCancel')?.addEventListener('click',  () => { document.getElementById('deleteCampusModal').hidden = true; });
  document.getElementById('deleteCampusConfirm')?.addEventListener('click', executeDeleteCampus);

  // Staff group create
  document.getElementById('addStaffGroup')?.addEventListener('click', createStaffGroup);

  // Staff group edit drawer
  document.getElementById('esgSaveBtn')?.addEventListener('click',   saveEditStaffGroup);
  document.getElementById('esgCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editStaffGroupDrawer'));
  document.getElementById('esgCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editStaffGroupDrawer'));
  document.getElementById('esgDeleteBtn')?.addEventListener('click', confirmDeleteStaffGroup);

  // Staff group delete modal
  document.getElementById('deleteStaffGroupCancel')?.addEventListener('click',  () => { document.getElementById('deleteStaffGroupModal').hidden = true; });
  document.getElementById('deleteStaffGroupConfirm')?.addEventListener('click', executeDeleteStaffGroup);
}

/* ===============================
   SHARED LOOKUP (used by staff module)
================================ */

export function getCampusLookup() {
  return Object.fromEntries(campuses.map(c => [c.id, c.name]));
}

export function getStaffGroups() {
  return staffGroups;
}

export function getStaffGroupLookup() {
  return Object.fromEntries(staffGroups.map(g => [g.id, g.name]));
}

import { supabase } from './admin.supabase.js';
import { esc, getAvatarColor } from './admin.shared.js';

let currentProfile;
let campuses = [];
let eventsWired = false;
let editingCampusId = null;

/* ===============================
   ENTRY POINT
================================ */

export async function initCampusesSection(profile) {
  currentProfile = profile;
  if (!eventsWired) {
    wireStaticEvents();
    eventsWired = true;
  }
  await loadCampuses();
}

/* ===============================
   DATA
================================ */

async function loadCampuses() {
  const { data, error } = await supabase
    .from('campuses')
    .select('*')
    .eq('school_id', currentProfile.school_id)
    .order('name');

  if (error) { console.error('Failed to load campuses', error); return; }
  campuses = data || [];
  renderCampusTable();
}

/* ===============================
   HELPERS
================================ */

function fmtTime(t) {
  return t ? t.slice(0, 5) : '—';
}

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

  if (error) { alert('Failed to save campus.'); return; }
  window.closeDrawer?.('editCampusDrawer');
  await loadCampuses();
}

function confirmDeleteCampus() {
  if (!editingCampusId) return;
  const name = document.getElementById('ecName').value;
  document.getElementById('deleteCampusMsg').textContent =
    `Are you sure you want to delete "${name}"? Staff assigned to it will become unassigned.`;
  document.getElementById('deleteCampusModal').hidden = false;
}

async function executeDeleteCampus() {
  if (!editingCampusId) return;
  const { error } = await supabase.from('campuses').delete().eq('id', editingCampusId);
  document.getElementById('deleteCampusModal').hidden = true;
  if (error) { alert('Failed to delete campus.'); return; }
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

  if (error) { alert('Failed to create campus.'); return; }

  ['campusName', 'campusStart', 'campusEnd', 'campusHours', 'campusIncrement']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

  window.closeDrawer?.('campusDrawer');
  await loadCampuses();
}

/* ===============================
   EVENTS
================================ */

function wireStaticEvents() {
  document.getElementById('addCampus')?.addEventListener('click', createCampus);

  // Edit drawer
  document.getElementById('ecSaveBtn')?.addEventListener('click',   saveEditCampus);
  document.getElementById('ecCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editCampusDrawer'));
  document.getElementById('ecCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editCampusDrawer'));
  document.getElementById('ecDeleteBtn')?.addEventListener('click', confirmDeleteCampus);

  // Delete modal
  document.getElementById('deleteCampusCancel')?.addEventListener('click',  () => { document.getElementById('deleteCampusModal').hidden = true; });
  document.getElementById('deleteCampusConfirm')?.addEventListener('click', executeDeleteCampus);
}

/* ===============================
   SHARED LOOKUP (used by staff module)
================================ */

export function getCampusLookup() {
  return Object.fromEntries(campuses.map(c => [c.id, c.name]));
}

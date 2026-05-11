import { supabase } from './admin.supabase.js';

let currentProfile;
let campuses = [];
let eventsWired = false;

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
   RENDERING
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
    const startView = c.day_start_time ? c.day_start_time.slice(0, 5) : '—';
    const endView   = c.day_end_time   ? c.day_end_time.slice(0, 5)   : '—';
    const startVal  = c.day_start_time ? c.day_start_time.slice(0, 5) : '';
    const endVal    = c.day_end_time   ? c.day_end_time.slice(0, 5)   : '';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        <span class="view">${c.name}</span>
        <input class="form-input edit campus-name" hidden value="${c.name}">
      </td>
      <td>
        <span class="view">${startView}</span>
        <input type="time" class="form-input edit campus-start" hidden value="${startVal}">
      </td>
      <td>
        <span class="view">${endView}</span>
        <input type="time" class="form-input edit campus-end" hidden value="${endVal}">
      </td>
      <td>
        <span class="view">${c.workday_hours ?? '—'}</span>
        <input type="number" step="0.5" class="form-input edit campus-hours" hidden
          value="${c.workday_hours ?? ''}" placeholder="hrs">
      </td>
      <td>
        <span class="view">${c.pto_increment_minutes != null ? c.pto_increment_minutes + ' min' : '—'}</span>
        <input type="number" step="5" class="form-input edit campus-increment" hidden
          value="${c.pto_increment_minutes ?? ''}" placeholder="min">
      </td>
      <td>
        <button class="btn editBtn">Edit</button>
        <button class="btn saveBtn" hidden>Save</button>
        <button class="btn cancelBtn" hidden>Cancel</button>
        <button class="btn danger deleteBtn">Delete</button>
      </td>
    `;

    wireCampusRow(tr, c.id);
    tbody.appendChild(tr);
  });
}

/* ===============================
   ROW WIRING
================================ */
function wireCampusRow(tr, campusId) {
  const editBtn   = tr.querySelector('.editBtn');
  const saveBtn   = tr.querySelector('.saveBtn');
  const cancelBtn = tr.querySelector('.cancelBtn');
  const deleteBtn = tr.querySelector('.deleteBtn');
  const views = tr.querySelectorAll('.view');
  const edits = tr.querySelectorAll('.edit');

  editBtn.onclick = () => {
    views.forEach(v => (v.hidden = true));
    edits.forEach(e => (e.hidden = false));
    editBtn.hidden = true;
    saveBtn.hidden = false;
    cancelBtn.hidden = false;
    deleteBtn.hidden = true;
  };

  saveBtn.onclick = async () => {
    const name      = tr.querySelector('.campus-name').value.trim();
    const startTime = tr.querySelector('.campus-start').value || null;
    const endTime   = tr.querySelector('.campus-end').value   || null;
    const hours     = parseFloat(tr.querySelector('.campus-hours').value)     || null;
    const increment = parseInt(tr.querySelector('.campus-increment').value)   || null;

    if (!name) { alert('Campus name is required.'); return; }

    const { error } = await supabase
      .from('campuses')
      .update({ name, day_start_time: startTime, day_end_time: endTime,
                workday_hours: hours, pto_increment_minutes: increment })
      .eq('id', campusId);

    if (error) { alert('Failed to save campus.'); return; }
    await loadCampuses();
  };

  cancelBtn.onclick = () => loadCampuses();

  deleteBtn.onclick = async () => {
    if (!confirm('Delete this campus?\n\nStaff assigned to it will become unassigned.')) return;
    const { error } = await supabase.from('campuses').delete().eq('id', campusId);
    if (error) { alert('Failed to delete campus.'); return; }
    await loadCampuses();
  };
}

/* ===============================
   CREATE
================================ */
function wireStaticEvents() {
  document.getElementById('addCampus')?.addEventListener('click', createCampus);
}

async function createCampus() {
  const name      = document.getElementById('campusName').value.trim();
  const startTime = document.getElementById('campusStart').value || null;
  const endTime   = document.getElementById('campusEnd').value   || null;
  const hours     = parseFloat(document.getElementById('campusHours').value)     || null;
  const increment = parseInt(document.getElementById('campusIncrement').value)   || null;

  if (!name) { alert('Campus name is required.'); return; }

  const { error } = await supabase.from('campuses').insert({
    school_id: currentProfile.school_id,
    name,
    day_start_time: startTime,
    day_end_time:   endTime,
    workday_hours:  hours,
    pto_increment_minutes: increment,
  });

  if (error) { alert('Failed to create campus.'); return; }

  ['campusName', 'campusStart', 'campusEnd', 'campusHours', 'campusIncrement']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

  await loadCampuses();
}

/* ===============================
   SHARED LOOKUP (used by staff module)
================================ */
export function getCampusLookup() {
  return Object.fromEntries(campuses.map(c => [c.id, c.name]));
}


// admin.busgroups.v2.js
import { supabase } from './admin.supabase.js';

let currentProfile;
let initialized = false;

/* ===============================
   ENTRY POINT
================================ */
export async function initBusGroupsSection(profile) {
  currentProfile = profile;

  if (!initialized) {
    wireBusGroupEvents();
    initialized = true;
  }

  await loadBusGroups();
}

/* ===============================
   LOAD / RENDER
================================ */
async function loadBusGroups() {
  const tbody = document.querySelector('#busTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('bus_groups')
    .select('id, name, route_number')
    .eq('school_id', currentProfile.school_id)
    .order('name', { ascending: true });

  if (error) {
    console.error('Failed to load bus groups', error);
    return;
  }

  (data || []).forEach(bg => {
    tbody.appendChild(renderBusGroupRow(bg));
  });
}

function renderBusGroupRow(bg) {
  const tr = document.createElement('tr');

  tr.innerHTML = `
    <td>
      <span class="view">${bg.name}</span>
      <input
        class="form-input edit name"
        hidden
        value="${bg.name}"
      >
    </td>

    <td>
      <span class="view">${bg.route_number ?? ''}</span>
      <input
        class="form-input edit route"
        hidden
        value="${bg.route_number ?? ''}"
      >
    </td>

    <td>
      <button class="btn editBtn">Edit</button>
<button class="btn saveBtn" hidden>Save</button>
<button class="btn cancelBtn" hidden>Cancel</button>
<button class="btn danger deleteBtn">Delete</button>
    </td>
  `;

  wireBusGroupRow(tr, bg.id);
  return tr;
}

/* ===============================
   ROW LOGIC
================================ */

function wireBusGroupRow(tr, busGroupId) {
  const editBtn   = tr.querySelector('.editBtn');
  const saveBtn   = tr.querySelector('.saveBtn');
  const cancelBtn = tr.querySelector('.cancelBtn');
  const deleteBtn = tr.querySelector('.deleteBtn');

  const views = tr.querySelectorAll('.view');
  const edits = tr.querySelectorAll('.edit');

  /* ---------- EDIT ---------- */
  editBtn.onclick = () => {
    views.forEach(v => (v.hidden = true));
    edits.forEach(e => (e.hidden = false));

    editBtn.hidden   = true;
    saveBtn.hidden   = false;
    cancelBtn.hidden = false;
    deleteBtn.hidden = true;
  };

  /* ---------- SAVE ---------- */
  saveBtn.onclick = async () => {
    const updated = {
      name: tr.querySelector('.name').value.trim(),
      route_number: tr.querySelector('.route').value.trim() || null
    };

    if (!updated.name) {
      alert('Bus group name is required.');
      return;
    }

    const { error } = await supabase
      .from('bus_groups')
      .update(updated)
      .eq('id', busGroupId);

    if (error) {
      console.error('Failed to update bus group', error);
      alert('Failed to update bus group');
      return;
    }

    // Reload restores default button state
    loadBusGroups();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
    loadBusGroups();
  };

  /* ---------- DELETE ---------- */
  deleteBtn.onclick = async () => {
    if (!confirm('Delete this bus group?')) return;

    const { error } = await supabase
      .from('bus_groups')
      .delete()
      .eq('id', busGroupId);

    if (error) {
      console.error('Delete bus group failed', error);
      alert('Failed to delete bus group');
      return;
    }

    loadBusGroups();
  };
}


/* ===============================
   CREATE
================================ */
async function createBusGroup() {
  const name = document.getElementById('busName')?.value.trim();
  const route = document.getElementById('busRoute')?.value.trim();

  if (!name) {
    alert('Please enter a bus group name.');
    return;
  }

  const { error } = await supabase.from('bus_groups').insert({
    school_id: currentProfile.school_id,
    name,
    route_number: route || null
  });

  if (error) {
    console.error('Failed to create bus group', error);
    alert('Failed to create bus group');
    return;
  }

  document.getElementById('busName').value = '';
  document.getElementById('busRoute').value = '';

  loadBusGroups();
}

/* ===============================
   EVENTS
================================ */
function wireBusGroupEvents() {
  document
    .getElementById('addBusGroup')
    ?.addEventListener('click', createBusGroup);
}

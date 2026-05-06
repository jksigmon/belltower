
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';


let currentProfile;
let initialized = false;
let busGroupsDirectory;
/* ===============================
   ENTRY POINT
================================ */

export async function initBusGroupsSection(profile) {
  currentProfile = profile;

  if (!busGroupsDirectory) {
    busGroupsDirectory = createDirectory({
      table: 'bus_groups',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        name,
        route_number
      `,

      searchFields: ['name', 'route_number'],
      defaultSort: { column: 'name', ascending: true },

      tbodySelector: '#busTable tbody',
      renderRow: renderBusGroupRow
    });
  }

  if (!initialized) {
    wireBusGroupEvents();
    initialized = true;
  }

  busGroupsDirectory.load();
}


/* ===============================
   LOAD / RENDER
================================ */

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
    busGroupsDirectory.load();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
    busGroupsDirectory.load();
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

    busGroupsDirectory.load();
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

  busGroupsDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireBusGroupEvents() {
  document
    .getElementById('addBusGroup')
    ?.addEventListener('click', createBusGroup);

  const searchInput = document.getElementById('busSearch');
  const sortSelect = document.getElementById('busSort');

  // 🔍 Search
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', e => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        busGroupsDirectory.setSearch(e.target.value.trim());
      }, 300);
    });
  }

  // ↕️ Sort
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      busGroupsDirectory.setSort(column, dir === 'asc');
    });
  }

  // 📤 Export current view
  document
    .getElementById('exportBusGroupsCurrent')
    ?.addEventListener('click', () =>
      busGroupsDirectory.exportFiltered()
    );

  // 📤 Export all
  document
    .getElementById('exportBusGroupsAll')
    ?.addEventListener('click', () =>
      busGroupsDirectory.exportAll()
    );
}

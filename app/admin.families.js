import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';


let currentProfile;
let initialized = false;
let familiesDirectory;
/* ===============================
   ENTRY POINT
================================ */

export async function initFamiliesSection(profile) {
  currentProfile = profile;

  // ✅ Ensure directory exists first
  if (!familiesDirectory) {
    familiesDirectory = createDirectory({
      table: 'families',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        carline_tag_number,
        family_name,
        active
      `,

      searchFields: [
        'carline_tag_number',
        'family_name'
      ],

      defaultSort: {
        column: 'carline_tag_number',
        ascending: true
      },

      tbodySelector: '#familiesTable tbody',
      paginationContainer: '#familiesPagination',
      renderRow: renderFamilyRow
    });
  }

  if (!initialized) {
    wireFamilyEvents();
    initialized = true;
  }

  familiesDirectory.load();
}


/* ===============================
   LOAD / RENDER
================================ */

function renderFamilyRow(f) {
  const tr = document.createElement('tr');

  tr.innerHTML = `
    <td>
      <span class="view">${f.carline_tag_number}</span>
      <input
        class="form-input edit tag"
        hidden
        value="${f.carline_tag_number}"
      >
    </td>

    <td>
      <span class="view">${f.family_name ?? ''}</span>
      <input
        class="form-input edit name"
        hidden
        value="${f.family_name ?? ''}"
      >
    </td>

    <td>
      <span class="view">${f.active ? '' : '<span style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;font-size:0.72rem;padding:2px 8px;border-radius:4px;font-weight:600;white-space:nowrap;">Inactive</span>'}</span>
      <input type="checkbox" class="edit active" hidden ${f.active ? 'checked' : ''}>
    </td>

    <td>
      <button class="btn editBtn">Edit</button>
<button class="btn saveBtn" hidden>Save</button>
<button class="btn cancelBtn" hidden>Cancel</button>
<button class="btn danger deleteBtn">Delete</button>
    </td>
  `;

  wireFamilyRow(tr, f.id);
  return tr;
}

/* ===============================
   ROW LOGIC
================================ */

function wireFamilyRow(tr, familyId) {
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
      carline_tag_number: tr.querySelector('.tag').value.trim(),
      family_name: tr.querySelector('.name').value.trim() || null,
      active: tr.querySelector('.active').checked
    };

    if (!updated.carline_tag_number) {
      alert('Carline tag number is required.');
      return;
    }

    const { error } = await supabase
      .from('families')
      .update(updated)
      .eq('id', familyId);

    if (error) {
      console.error('Update family failed', error);
      alert('Failed to update family (duplicate tag?)');
      return;
    }

    // Reload resets buttons and view state
    familiesDirectory.load();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
   familiesDirectory.load();
  };

  /* ---------- DELETE ---------- */
  deleteBtn.onclick = async () => {
    if (!confirm('Delete this family?')) return;

    const { error } = await supabase
      .from('families')
      .delete()
      .eq('id', familyId);

    if (error) {
      console.error('Delete family failed', error);
      alert('Failed to delete family.');
      return;
    }

    familiesDirectory.load();
  };
}

/* ===============================
   CREATE
================================ */
async function createFamily() {
  const tag = document.getElementById('familyTag')?.value.trim();
  const name = document.getElementById('familyName')?.value.trim();

  if (!tag) {
    alert('Carline tag number is required.');
    return;
  }

  const { error } = await supabase.from('families').insert({
    school_id: currentProfile.school_id,
    carline_tag_number: tag,
    family_name: name || null,
    active: true
  });

  if (error) {
    console.error('Create family failed', error);
    alert('Failed to add family (duplicate tag?)');
    return;
  }

  document.getElementById('familyTag').value = '';
  document.getElementById('familyName').value = '';

  window.closeDrawer?.('familyDrawer');
  familiesDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireFamilyEvents() {
  document
    .getElementById('addFamily')
    ?.addEventListener('click', createFamily);

  const searchInput = document.getElementById('familySearch');
  const sortSelect = document.getElementById('familySort');

  // 🔍 Search
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', e => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        familiesDirectory.setSearch(e.target.value.trim());
      }, 300);
    });
  }

  // ↕️ Sort
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      familiesDirectory.setSort(column, dir === 'asc');
    });
  }

  // 📤 Export current view
  document
    .getElementById('exportFamiliesCurrent')
    ?.addEventListener('click', () =>
      familiesDirectory.exportFiltered()
    );

  // 📤 Export all
  document
    .getElementById('exportFamiliesAll')
    ?.addEventListener('click', () =>
      familiesDirectory.exportAll()
    );
}

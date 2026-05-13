
import { supabase } from './admin.supabase.js';
import { loadFamilyOptions } from './admin.shared.js';
import { createDirectory } from './admin.directory.js';

let currentProfile;
let initialized = false;
let guardiansDirectory;

/* ===============================
   ENTRY POINT
================================ */

export async function initGuardiansSection(profile) {
  currentProfile = profile;

  // Shared dropdown
  await loadFamilyOptions(['#guardianFamily']);

  // ✅ Ensure directory exists first
  if (!guardiansDirectory) {
 guardiansDirectory = createDirectory({
  table: 'guardians',
  schoolId: () => currentProfile.school_id,

  select: `
    id,
    first_name,
    last_name,
    email,
    phone,
    active,
    families!inner(carline_tag_number, family_name)
  `,

  // ✅ ONLY base-table fields here
  searchFields: [
    'first_name',
    'last_name',
    'email',
    'phone'
  ],

  defaultSort: {
    column: 'last_name',
    ascending: true
  },

  tbodySelector: '#guardiansTable tbody',
  paginationContainer: '#guardiansPagination',
  renderRow: renderGuardianRow,


augmentQuery(query, searchTerm) {
  if (!searchTerm) return query;

  const term = `%${searchTerm}%`;
  const isNumeric = /^\d+$/.test(searchTerm);

  // 🔢 Numeric → family carline tag ONLY
  if (isNumeric) {
    return {
      query: query.or(
        `carline_tag_number.ilike.${term}`,
        { foreignTable: 'families' }
      ),
      skipBaseSearch: true
    };
  }

  // 🔤 Text → guardian search only (engine handles it)
  return query;
}


});


  }

  if (!initialized) {
    wireGuardianEvents();
    initialized = true;
  }

  guardiansDirectory.load();
}

/* ===============================
   LOAD / RENDER
================================ */
function renderGuardianRow(g) {
  const familyLabel = g.families
    ? `${g.families.carline_tag_number} – ${g.families.family_name ?? '(no name)'}`
    : '';

  const tr = document.createElement('tr');

  tr.innerHTML = `
    <td>
      <span class="view">${g.first_name} ${g.last_name}</span>
      <div class="edit" hidden>
        <input class="form-input first" value="${g.first_name}">
        <input class="form-input last" value="${g.last_name}">
      </div>
    </td>

    <td>${familyLabel}</td>

    <td>
      <span class="view">${g.email ?? ''}</span>
      <input class="form-input edit email" hidden value="${g.email ?? ''}">
    </td>

    <td>
      <span class="view">${g.phone ?? ''}</span>
      <input class="form-input edit phone" hidden value="${g.phone ?? ''}">
    </td>

    <td>
      <span class="view">${g.active ? '' : '<span style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;font-size:0.72rem;padding:2px 8px;border-radius:4px;font-weight:600;white-space:nowrap;">Inactive</span>'}</span>
      <input type="checkbox" class="edit active" hidden ${g.active ? 'checked' : ''}>
    </td>

    <td>
    <button class="btn editBtn">Edit</button>
	<button class="btn saveBtn" hidden>Save</button>
	<button class="btn cancelBtn" hidden>Cancel</button>
	<button class="btn danger deleteBtn">Delete</button>
	</td>
  `;

  wireGuardianRow(tr, g.id);
  return tr;
}

/* ===============================
   ROW LOGIC
================================ */

function wireGuardianRow(tr, guardianId) {
  const editBtn   = tr.querySelector('.editBtn');
  const saveBtn   = tr.querySelector('.saveBtn');
  const cancelBtn = tr.querySelector('.cancelBtn');
  const deleteBtn = tr.querySelector('.deleteBtn');

  const views = tr.querySelectorAll('.view');
  const edits = tr.querySelectorAll('.edit');

  /* ---------- Permission Guard ---------- */
  if (!currentProfile?.can_manage_guardians) {
    editBtn?.remove();
    saveBtn?.remove();
    cancelBtn?.remove();
    deleteBtn?.remove();
    return;
  }

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
      first_name: tr.querySelector('.first').value.trim(),
      last_name: tr.querySelector('.last').value.trim(),
      email: tr.querySelector('.email').value.trim(),
      phone: tr.querySelector('.phone').value.trim(),
      active: tr.querySelector('.active').checked
    };

    const { error } = await supabase
      .from('guardians')
      .update(updated)
      .eq('id', guardianId);

    if (error) {
      console.error('Failed to update guardian', error);
      alert('Failed to update guardian');
      return;
    }

    // Reload resets everything
    guardiansDirectory.load();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
   guardiansDirectory.load();
  };

  /* ---------- DELETE ---------- */
  deleteBtn.onclick = async () => {
    if (!confirm('Delete this guardian?')) return;

    const { error } = await supabase
      .from('guardians')
      .delete()
      .eq('id', guardianId);

    if (error) {
      console.error('Failed to delete guardian', error);
      alert('Failed to delete guardian');
      return;
    }

    guardiansDirectory.load();
  };
}


/* ===============================
   CREATE
================================ */
async function createGuardian() {
  if (!currentProfile?.can_manage_guardians) {
    alert('You do not have permission to manage guardians.');
    return;
  }

  const guardian = {
    school_id: currentProfile.school_id,
    family_id: document.getElementById('guardianFamily').value,
    first_name: document.getElementById('guardianFirst').value.trim(),
    last_name: document.getElementById('guardianLast').value.trim(),
    email: document.getElementById('guardianEmail').value.trim(),
    phone: document.getElementById('guardianPhone').value.trim(),
    active: true
  };

  if (!guardian.first_name || !guardian.last_name || !guardian.family_id) {
    alert('First name, last name, and family are required.');
    return;
  }

  const { error } = await supabase.from('guardians').insert(guardian);
  if (error) {
    console.error('Failed to create guardian', error);
    alert('Failed to add guardian');
    return;
  }

  document.getElementById('guardianFirst').value = '';
  document.getElementById('guardianLast').value = '';
  document.getElementById('guardianEmail').value = '';
  document.getElementById('guardianPhone').value = '';
  document.getElementById('guardianFamily').value = '';

  window.closeDrawer?.('guardianDrawer');
  guardiansDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireGuardianEvents() {
  document
    .getElementById('addGuardian')
    ?.addEventListener('click', createGuardian);

  const searchInput = document.getElementById('guardianSearch');
  const sortSelect = document.getElementById('guardianSort');

  // 🔍 Search
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', e => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        guardiansDirectory.setSearch(e.target.value.trim());
      }, 300);
    });
  }

  // ↕️ Sort
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      guardiansDirectory.setSort(column, dir === 'asc');
    });
  }

  // 📤 Export current view
  document
    .getElementById('exportGuardiansCurrent')
    ?.addEventListener('click', () =>
      guardiansDirectory.exportFiltered()
    );

  // 📤 Export all
  document
    .getElementById('exportGuardiansAll')
    ?.addEventListener('click', () =>
      guardiansDirectory.exportAll()
    );
}


import { supabase } from './admin.supabase.js';
import { loadFamilyOptions } from './admin.shared.js';

let currentProfile;
let initialized = false;

/* ===============================
   ENTRY POINT
================================ */
export async function initGuardiansSection(profile) {
  currentProfile = profile;

  if (!initialized) {
    wireGuardianEvents();
    initialized = true;
  }

  // Shared dropdown
  await loadFamilyOptions(['#guardianFamily']);
  await loadGuardians();
}

/* ===============================
   LOAD / RENDER
================================ */
async function loadGuardians() {
  const tbody = document.querySelector('#guardiansTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('guardians')
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      active,
      families(carline_tag_number, family_name)
    `)
    .eq('school_id', currentProfile.school_id)
    .order('last_name');

  if (error) {
    console.error('Failed to load guardians', error);
    return;
  }

  (data || []).forEach(g => {
    tbody.appendChild(renderGuardianRow(g));
  });
}

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
      <span class="view">${g.active ? 'Yes' : 'No'}</span>
      <input
        type="checkbox"
        class="edit active"
        hidden
        ${g.active ? 'checked' : ''}
      >
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
    loadGuardians();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
    loadGuardians();
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

    loadGuardians();
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

  loadGuardians();
}

/* ===============================
   EVENTS
================================ */
function wireGuardianEvents() {
  document
    .getElementById('addGuardian')
    ?.addEventListener('click', createGuardian);
}

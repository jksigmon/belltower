import { supabase } from './admin.supabase.js';

let currentProfile;
let initialized = false;

/* ===============================
   ENTRY POINT
================================ */
export async function initFamiliesSection(profile) {
  currentProfile = profile;

  if (!initialized) {
    wireFamilyEvents();
    initialized = true;
  }

  await loadFamilies();
}

/* ===============================
   LOAD / RENDER
================================ */
async function loadFamilies() {
  const tbody = document.querySelector('#familiesTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('families')
    .select('id, carline_tag_number, family_name, active')
    .eq('school_id', currentProfile.school_id)
    .order('carline_tag_number');

  if (error) {
    console.error('Failed to load families', error);
    return;
  }

  (data || []).forEach(family => {
    tbody.appendChild(renderFamilyRow(family));
  });
}

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
      <span class="view">${f.active ? 'Yes' : 'No'}</span>
      <input
        type="checkbox"
        class="edit active"
        hidden
        ${f.active ? 'checked' : ''}
      >
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
    loadFamilies();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
    loadFamilies();
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

    loadFamilies();
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

  loadFamilies();
}

/* ===============================
   EVENTS
================================ */
function wireFamilyEvents() {
  document
    .getElementById('addFamily')
    ?.addEventListener('click', createFamily);
}

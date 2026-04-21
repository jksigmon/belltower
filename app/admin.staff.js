import { supabase } from './admin.supabase.js';

let currentProfile;
let supervisorLookup = {};
let initialized = false;

/* ===============================
   ENTRY POINT
================================ */

export async function initStaffSection(profile) {
  currentProfile = profile;

  if (!initialized) {
    wireStaticEvents();
    initialized = true;
  }

  supervisorLookup = {};
  await loadSupervisorLookup();

  populateAddStaffSupervisorSelect();

  await loadStaff();
}


/* ===============================
   DATA LOADERS
================================ */
async function loadStaff() {
  const tbody = document.querySelector('#staffTable tbody');
  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('employees')
    .select(`
      id,
      first_name,
      last_name,
      email,
      position,
      active,
      supervisor_id
    `)
    .eq('school_id', currentProfile.school_id)
    .order('last_name');

  if (error) {
    console.error(error);
    return;
  }

  data.forEach(emp => {
    tbody.appendChild(renderStaffRow(emp));
  });
}


async function loadSupervisorLookup() {
  if (Object.keys(supervisorLookup).length > 0) return;

  const { data, error } = await supabase
    .from('supervisor_candidates')
    .select('id, first_name, last_name')
    .eq('school_id', currentProfile.school_id);

  if (error) {
    console.error('Failed to load supervisors', error);
    return;
  }

  supervisorLookup = {};

  data.forEach(emp => {
    supervisorLookup[emp.id] = `${emp.first_name} ${emp.last_name}`;
  });
}

function populateAddStaffSupervisorSelect() {
  const select = document.getElementById('staffSupervisor');
  if (!select) return;

  select.innerHTML = '';

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Supervisor / PTO Approver (optional)';
  placeholder.selected = true;
  placeholder.disabled = true;   // ✅ important UX detail
  select.appendChild(placeholder);

  populateSupervisorSelect(select, null, false);
}

/* ===============================
   RENDERING
================================ */
window.__STAFF_RENDER__ = renderStaffRow;
function renderStaffRow(emp) {
  const tr = document.createElement('tr');

  tr.innerHTML = `
    <td>
      <span class="view">${emp.first_name} ${emp.last_name}</span>
      <div class="edit" hidden>
        <input class="form-input first" value="${emp.first_name}">
        <input class="form-input last" value="${emp.last_name}">
      </div>
    </td>

    <td>
      <span class="view">${emp.email ?? ''}</span>
      <input class="form-input edit email" hidden value="${emp.email ?? ''}">
    </td>

    <td>
      <span class="view">${emp.position ?? ''}</span>
      <input class="form-input edit position" hidden value="${emp.position ?? ''}">
    </td>

    <td>
      <span class="view">
        ${supervisorLookup[emp.supervisor_id] ?? '—'}
      </span>
      <select class="form-input edit supervisor" hidden></select>
    </td>

    <td>
      <span class="view">${emp.active ? 'Yes' : 'No'}</span>
      <input type="checkbox" class="edit active" ${
        emp.active ? 'checked' : ''
      } hidden>
    </td>

    <td>
     <button class="btn editBtn">Edit</button>
<button class="btn saveBtn" hidden>Save</button>
<button class="btn cancelBtn" hidden>Cancel</button>
<button class="btn danger deleteBtn">Delete</button>
    </td>
  `;

  wireRow(tr, emp.id, emp.supervisor_id);
  return tr;
}


/* ===============================
   EVENT WIRING
================================ */
function wireStaticEvents() {
  document
    .getElementById('addStaff')
    .addEventListener('click', createStaff);
}


function wireRow(tr, empId, supervisorId) {
  const editBtn   = tr.querySelector('.editBtn');
  const saveBtn   = tr.querySelector('.saveBtn');
  const cancelBtn = tr.querySelector('.cancelBtn');
  const deleteBtn = tr.querySelector('.deleteBtn');

  const views = tr.querySelectorAll('.view');
  const edits = tr.querySelectorAll('.edit');
  const supervisorSelect = tr.querySelector('.supervisor');

  populateSupervisorSelect(supervisorSelect, supervisorId, true);

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
      position: tr.querySelector('.position').value.trim(),
      supervisor_id: supervisorSelect.value || null,
      active: tr.querySelector('.active').checked
    };

    await supabase
      .from('employees')
      .update(updated)
      .eq('id', empId);

    // Reload resets view + buttons
    loadStaff();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
    loadStaff();
  };

  /* ---------- DELETE ---------- */
  deleteBtn.onclick = async () => {
    if (!confirm('Delete this staff member?')) return;

    await supabase
      .from('employees')
      .delete()
      .eq('id', empId);

    loadStaff();
  };
}

/* ===============================
   SUPERVISOR DROPDOWN
================================ */


function populateSupervisorSelect(select, selectedId, includeNone = true) {
  if (includeNone) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— None —';

    if (!selectedId) {
      none.selected = true;
    }

    select.appendChild(none);
  }

  Object.entries(supervisorLookup).forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;

    if (id === selectedId) {
      opt.selected = true;
    }

    select.appendChild(opt);
  });
}



/* ===============================
   CREATE STAFF
================================ */
async function createStaff() {
  const first = document.getElementById('staffFirst').value.trim();
  const last = document.getElementById('staffLast').value.trim();
  const email = document.getElementById('staffEmail').value.trim();
  const position = document.getElementById('staffPosition').value.trim();
  const supervisorId =
    document.getElementById('staffSupervisor')?.value || null;

  if (!first || !last) {
    alert('First and last name required');
    return;
  }

  await supabase.from('employees').insert({
    school_id: currentProfile.school_id,
    first_name: first,
    last_name: last,
    email,
    position,
    supervisor_id: supervisorId,
    active: true
  });

  loadStaff();
}

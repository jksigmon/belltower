
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';


let currentProfile;
let supervisorLookup = {};
let campusLookup = {};
let initialized = false;
let staffDirectory;

/* ===============================
   ENTRY POINT
================================ */


export async function initStaffSection(profile) {
  currentProfile = profile;

  supervisorLookup = {};
  campusLookup = {};
  await Promise.all([loadSupervisorLookup(), loadCampusLookup()]);
  populateAddStaffSupervisorSelect();
  populateAddStaffCampusSelect();
  
  if (!initialized) {
    wireStaticEvents();
    initialized = true;
  }

  if (!staffDirectory) {
  staffDirectory = createDirectory({
    table: 'employees',
    schoolId: () => currentProfile.school_id,

    select: `
      id,
      first_name,
      last_name,
      email,
      position,
      active,
      supervisor_id,
      campus_id,
      employment_months
    `,

    searchFields: [
      'first_name',
      'last_name',
      'email',
      'position'
    ],

    filters: {
      active: val =>
        val === 'true' || val === 'false'
          ? { column: 'active', op: 'eq', value: val === 'true' }
          : null,
      campus: val => val ? { column: 'campus_id', op: 'eq', value: val } : null
    },

    defaultSort: { column: 'last_name', ascending: true },

    tbodySelector: '#staffTable tbody',
    paginationContainer: '#staffPagination',
    renderRow: renderStaffRow
  });
  }

 if (!initialized) {
    wireStaticEvents();
    initialized = true;
  }

  staffDirectory.load();
}


/* ===============================
   DATA LOADERS
================================ */

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

async function loadCampusLookup() {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', currentProfile.school_id)
    .order('name');

  if (error) { console.error('Failed to load campuses', error); return; }

  campusLookup = {};
  (data || []).forEach(c => { campusLookup[c.id] = c.name; });

  const filterSelect = document.getElementById('staffCampusFilter');
  if (filterSelect) {
    filterSelect.innerHTML = '<option value="">All campuses</option>';
    (data || []).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      filterSelect.appendChild(opt);
    });
  }
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

function populateAddStaffCampusSelect() {
  const select = document.getElementById('staffCampusAdd');
  if (!select) return;
  select.innerHTML = '<option value="">Campus (optional)</option>';
  Object.entries(campusLookup).forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    select.appendChild(opt);
  });
}

function debounce(fn, delay = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
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
      <span class="view">${campusLookup[emp.campus_id] ?? '—'}</span>
      <select class="form-input edit campus" hidden></select>
    </td>

    <td>
      <span class="view">${emp.employment_months ? emp.employment_months + 'mo' : '—'}</span>
      <select class="form-input edit emp-months" hidden>
        <option value="">—</option>
        <option value="10" ${emp.employment_months === 10 ? 'selected' : ''}>10-month</option>
        <option value="11" ${emp.employment_months === 11 ? 'selected' : ''}>11-month</option>
        <option value="12" ${emp.employment_months === 12 ? 'selected' : ''}>12-month</option>
      </select>
    </td>

    <td>
     <button class="btn editBtn">Edit</button>
<button class="btn saveBtn" hidden>Save</button>
<button class="btn cancelBtn" hidden>Cancel</button>
<button class="btn danger deleteBtn">Delete</button>
    </td>
  `;

  wireRow(tr, emp.id, emp.supervisor_id, emp.campus_id);
  return tr;
}


/* ===============================
   EVENT WIRING
================================ */

function wireStaticEvents() {
  document
    .getElementById('addStaff')
    .addEventListener('click', createStaff);

  const searchInput = document.getElementById('staffSearch');
  const activeFilter = document.getElementById('staffActiveFilter');
  const campusFilter = document.getElementById('staffCampusFilter');
  const sortSelect = document.getElementById('staffSort');

  if (searchInput) {
    const debounced = debounce(e =>
      staffDirectory.setSearch(e.target.value.trim()),
      300
    );
    searchInput.addEventListener('input', debounced);
  }

  if (activeFilter) {
    activeFilter.addEventListener('change', e =>
      staffDirectory.setFilter('active', e.target.value)
    );
  }

  if (campusFilter) {
    campusFilter.addEventListener('change', e =>
      staffDirectory.setFilter('campus', e.target.value)
    );
  }

  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      staffDirectory.setSort(column, dir === 'asc');
    });
  }

  document
    .getElementById('exportStaffCurrent')
    ?.addEventListener('click', () =>
      staffDirectory.exportFiltered()
    );

  document
    .getElementById('exportStaffAll')
    ?.addEventListener('click', () =>
      staffDirectory.exportAll()
    );
}

function wireRow(tr, empId, supervisorId, campusId) {
  const editBtn   = tr.querySelector('.editBtn');
  const saveBtn   = tr.querySelector('.saveBtn');
  const cancelBtn = tr.querySelector('.cancelBtn');
  const deleteBtn = tr.querySelector('.deleteBtn');

  const views = tr.querySelectorAll('.view');
  const edits = tr.querySelectorAll('.edit');
  const supervisorSelect = tr.querySelector('.supervisor');
  const campusSelect = tr.querySelector('.campus');

  populateSupervisorSelect(supervisorSelect, supervisorId, true);
  populateCampusSelect(campusSelect, campusId);

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
    const empMonthsVal = tr.querySelector('.emp-months').value;
    const updated = {
      first_name: tr.querySelector('.first').value.trim(),
      last_name: tr.querySelector('.last').value.trim(),
      email: tr.querySelector('.email').value.trim(),
      position: tr.querySelector('.position').value.trim(),
      supervisor_id: supervisorSelect.value || null,
      active: tr.querySelector('.active').checked,
      campus_id: campusSelect.value || null,
      employment_months: empMonthsVal ? parseInt(empMonthsVal) : null
    };

    await supabase
      .from('employees')
      .update(updated)
      .eq('id', empId);

    // Reload resets view + buttons
    staffDirectory.load();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore defaults
    staffDirectory.load();
  };

  /* ---------- DELETE ---------- */
  deleteBtn.onclick = async () => {
    if (!confirm('Delete this staff member?')) return;

    await supabase
      .from('employees')
      .delete()
      .eq('id', empId);

    staffDirectory.load();
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



function populateCampusSelect(select, selectedId) {
  select.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— None —';
  if (!selectedId) none.selected = true;
  select.appendChild(none);

  Object.entries(campusLookup).forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    if (id === selectedId) opt.selected = true;
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
  const campusId =
    document.getElementById('staffCampusAdd')?.value || null;
  const empMonthsRaw = document.getElementById('staffEmploymentMonths')?.value;
  const employmentMonths = empMonthsRaw ? parseInt(empMonthsRaw) : null;

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
    campus_id: campusId,
    employment_months: employmentMonths,
    active: true
  });

  staffDirectory.load();
}

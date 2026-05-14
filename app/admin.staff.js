
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';


let currentProfile;
let supervisorLookup = {};
let campusLookup = {};
let initialized = false;
let staffDirectory;
let editingEmpId = null;

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
  const { data, error } = await supabase
    .from('supervisor_candidates')
    .select('id, first_name, last_name')
    .eq('school_id', currentProfile.school_id);

  if (error) { console.error('Failed to load supervisors', error); return; }

  supervisorLookup = {};
  (data || []).forEach(emp => {
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
  placeholder.disabled = true;
  select.appendChild(placeholder);
  populateSupervisorOptions(select, null, false);
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

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getAvatarColor(name) {
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function contractBadgeHTML(months) {
  if (!months) return '<span class="staff-cell-muted">—</span>';
  return `<span class="contract-badge mo-${months}">${months}-Month</span>`;
}

function renderStaffRow(emp) {
  const initials = `${emp.first_name?.[0] ?? ''}${emp.last_name?.[0] ?? ''}`.toUpperCase();
  const color    = getAvatarColor((emp.first_name ?? '') + (emp.last_name ?? ''));
  const inactive = emp.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';
  const position = emp.position
    ? `<span class="staff-position-badge">${esc(emp.position)}</span>`
    : '<span class="staff-cell-muted">—</span>';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initials}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(emp.first_name)} ${esc(emp.last_name)}</span>
          ${inactive}
        </div>
      </div>
    </td>
    <td class="staff-cell-email">${esc(emp.email ?? '')}</td>
    <td>${position}</td>
    <td class="staff-cell-muted">${esc(supervisorLookup[emp.supervisor_id] ?? '—')}</td>
    <td class="staff-cell-muted">${esc(campusLookup[emp.campus_id] ?? '—')}</td>
    <td>${contractBadgeHTML(emp.employment_months)}</td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;

  tr.addEventListener('click', () => openEditStaffDrawer(emp));
  return tr;
}


/* ===============================
   EDIT DRAWER
================================ */

function openEditStaffDrawer(emp) {
  editingEmpId = emp.id;

  const initials = `${emp.first_name?.[0] ?? ''}${emp.last_name?.[0] ?? ''}`.toUpperCase();
  const color    = getAvatarColor((emp.first_name ?? '') + (emp.last_name ?? ''));

  const avatar = document.getElementById('esAvatar');
  avatar.textContent    = initials;
  avatar.style.background = color;

  document.getElementById('esTitle').textContent    = `${emp.first_name} ${emp.last_name}`;
  document.getElementById('esSubtitle').textContent = emp.position ?? '';

  document.getElementById('esFirst').value   = emp.first_name ?? '';
  document.getElementById('esLast').value    = emp.last_name ?? '';
  document.getElementById('esEmail').value   = emp.email ?? '';
  document.getElementById('esPosition').value = emp.position ?? '';
  document.getElementById('esMonths').value  = emp.employment_months ?? '';
  document.getElementById('esActive').checked = !!emp.active;

  // Supervisor dropdown
  const supSel = document.getElementById('esSupervisor');
  supSel.innerHTML = '';
  populateSupervisorOptions(supSel, emp.supervisor_id, true);

  // Campus dropdown
  const camSel = document.getElementById('esCampus');
  populateCampusSelect(camSel, emp.campus_id);

  // Reset save button state
  const saveBtn = document.getElementById('esSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editStaffDrawer');
}

async function saveEditStaff() {
  if (!editingEmpId) return;

  const first = document.getElementById('esFirst').value.trim();
  const last  = document.getElementById('esLast').value.trim();
  if (!first || !last) { alert('First and last name are required.'); return; }

  const empMonthsVal = document.getElementById('esMonths').value;
  const updated = {
    first_name:        first,
    last_name:         last,
    email:             document.getElementById('esEmail').value.trim(),
    position:          document.getElementById('esPosition').value.trim(),
    supervisor_id:     document.getElementById('esSupervisor').value || null,
    campus_id:         document.getElementById('esCampus').value || null,
    employment_months: empMonthsVal ? parseInt(empMonthsVal) : null,
    active:            document.getElementById('esActive').checked,
  };

  const saveBtn = document.getElementById('esSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('employees').update(updated).eq('id', editingEmpId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { alert('Failed to save: ' + error.message); return; }
  window.closeDrawer?.('editStaffDrawer');
  staffDirectory.load();
}

function confirmDeleteStaff() {
  if (!editingEmpId) return;
  const first = document.getElementById('esFirst').value;
  const last  = document.getElementById('esLast').value;
  document.getElementById('deleteStaffMsg').textContent =
    `Are you sure you want to delete ${first} ${last}? This cannot be undone.`;
  document.getElementById('deleteStaffModal').hidden = false;
}

async function executeDeleteStaff() {
  if (!editingEmpId) return;
  const { error } = await supabase.from('employees').delete().eq('id', editingEmpId);
  document.getElementById('deleteStaffModal').hidden = true;
  if (error) { alert('Failed to delete: ' + error.message); return; }
  window.closeDrawer?.('editStaffDrawer');
  editingEmpId = null;
  staffDirectory.load();
}


/* ===============================
   EVENT WIRING
================================ */

function wireStaticEvents() {
  document.getElementById('addStaff')?.addEventListener('click', createStaff);

  // Filters / search / sort
  const searchInput  = document.getElementById('staffSearch');
  const activeFilter = document.getElementById('staffActiveFilter');
  const campusFilter = document.getElementById('staffCampusFilter');
  const sortSelect   = document.getElementById('staffSort');

  if (searchInput) {
    searchInput.addEventListener('input', debounce(e =>
      staffDirectory.setSearch(e.target.value.trim()), 300));
  }
  if (activeFilter) {
    activeFilter.addEventListener('change', e =>
      staffDirectory.setFilter('active', e.target.value));
  }
  if (campusFilter) {
    campusFilter.addEventListener('change', e =>
      staffDirectory.setFilter('campus', e.target.value));
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      staffDirectory.setSort(column, dir === 'asc');
    });
  }

  document.getElementById('exportStaffCurrent')?.addEventListener('click', () =>
    staffDirectory.exportFiltered());
  document.getElementById('exportStaffAll')?.addEventListener('click', () =>
    staffDirectory.exportAll());

  // Edit drawer buttons
  document.getElementById('esSaveBtn')?.addEventListener('click', saveEditStaff);
  document.getElementById('esCancelBtn')?.addEventListener('click', () =>
    window.closeDrawer?.('editStaffDrawer'));
  document.getElementById('esCloseBtn')?.addEventListener('click', () =>
    window.closeDrawer?.('editStaffDrawer'));
  document.getElementById('esDeleteBtn')?.addEventListener('click', confirmDeleteStaff);

  // Delete confirmation modal
  document.getElementById('deleteStaffCancel')?.addEventListener('click', () => {
    document.getElementById('deleteStaffModal').hidden = true;
  });
  document.getElementById('deleteStaffConfirm')?.addEventListener('click', executeDeleteStaff);
}


/* ===============================
   SUPERVISOR / CAMPUS DROPDOWNS
================================ */

function populateSupervisorOptions(select, selectedId, includeNone = true) {
  if (includeNone) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— None —';
    if (!selectedId) none.selected = true;
    select.appendChild(none);
  }
  Object.entries(supervisorLookup).forEach(([id, name]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    if (id === selectedId) opt.selected = true;
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
  const last  = document.getElementById('staffLast').value.trim();
  const email = document.getElementById('staffEmail').value.trim();
  const position = document.getElementById('staffPosition').value.trim();
  const supervisorId = document.getElementById('staffSupervisor')?.value || null;
  const campusId     = document.getElementById('staffCampusAdd')?.value || null;
  const empMonthsRaw = document.getElementById('staffEmploymentMonths')?.value;
  const employmentMonths = empMonthsRaw ? parseInt(empMonthsRaw) : null;

  if (!first || !last) { alert('First and last name required'); return; }

  const { error } = await supabase.from('employees').insert({
    school_id:         currentProfile.school_id,
    first_name:        first,
    last_name:         last,
    email,
    position,
    supervisor_id:     supervisorId,
    campus_id:         campusId,
    employment_months: employmentMonths,
    active:            true
  });

  if (error) { console.error('Failed to add staff', error); alert('Failed to add staff member.'); return; }

  ['staffFirst', 'staffLast', 'staffEmail', 'staffPosition'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const sup = document.getElementById('staffSupervisor'); if (sup) sup.value = '';
  const cam = document.getElementById('staffCampusAdd');  if (cam) cam.value = '';
  const mos = document.getElementById('staffEmploymentMonths'); if (mos) mos.value = '';

  window.closeDrawer?.('staffDrawer');
  staffDirectory.load();
}

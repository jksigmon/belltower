
import { supabase } from './admin.supabase.js';
import { loadFamilyOptions, loadBusGroupOptions, esc, getAvatarColor, cloneSelectOptions } from './admin.shared.js';
import { createDirectory } from './admin.directory.js';

let currentProfile;
let initialized = false;
let studentsDirectory;
let editingStudentId = null;

/* ===============================
   ENTRY POINT
================================ */

export async function initStudentsSection(profile) {
  currentProfile = profile;

  await Promise.all([
    loadFamilyOptions(['#studentFamily'], currentProfile.school_id),
    loadBusGroupOptions('#studentBusGroup', currentProfile.school_id),
    loadHomeroomOptions(),
    loadCampusOptions()
  ]);

  if (!studentsDirectory) {
    studentsDirectory = createDirectory({
      table: 'students',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        student_number,
        first_name,
        last_name,
        grade_level,
        homeroom_teacher_id,
        campus_id,
        family_id,
        active,
        withdrawn_at,
        withdrawal_reason,
        families!inner(carline_tag_number, family_name),
        employees!left(id, first_name, last_name),
        bus_groups(id, name),
        campuses(id, name)
      `,

      searchFields: ['first_name', 'last_name', 'student_number'],

      filters: {
        grade:    val => val ? { column: 'grade_level',        op: 'eq', value: val } : null,
        homeroom: val => val ? { column: 'homeroom_teacher_id', op: 'eq', value: val } : null,
        campus:   val => val ? { column: 'campus_id',           op: 'eq', value: val } : null
      },

      defaultSort: { column: 'last_name', ascending: true },

      columnCount: 8,
      tbodySelector: '#studentsTable tbody',
      paginationContainer: '#studentsPagination',
      renderRow: renderStudentRow,

      augmentQuery(query, searchTerm) {
        if (!searchTerm) return query;
        const term = `%${searchTerm}%`;
        if (/^\d+$/.test(searchTerm)) {
          return {
            query: query.or(`carline_tag_number.ilike.${term}`, { foreignTable: 'families' }),
            skipBaseSearch: true
          };
        }
        return query;
      }
    });
  }

  if (!initialized) {
    wireStudentEvents();
    initialized = true;
  }

  studentsDirectory.load();
}

/* ===============================
   DATA LOADERS
================================ */

async function loadHomeroomOptions() {
  const { data, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .eq('school_id', currentProfile.school_id)
    .eq('active', true)
    .ilike('position', '%teacher%')
    .order('last_name');

  if (error) { console.error('Failed to load teachers', error); return; }

  const addSelect    = document.getElementById('studentHomeroom');
  const filterSelect = document.getElementById('studentHomeroomFilter');

  if (addSelect) {
    addSelect.innerHTML = '';
    addSelect.appendChild(new Option('Select homeroom teacher', ''));
    (data || []).forEach(t => addSelect.appendChild(new Option(`${t.first_name} ${t.last_name}`, t.id)));
  }
  if (filterSelect) {
    filterSelect.innerHTML = '';
    filterSelect.appendChild(new Option('All homerooms', ''));
    (data || []).forEach(t => filterSelect.appendChild(new Option(`${t.first_name} ${t.last_name}`, t.id)));
  }
}

async function loadCampusOptions() {
  const { data } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', currentProfile.school_id)
    .order('name');

  const addSelect    = document.getElementById('studentCampus');
  const filterSelect = document.getElementById('studentCampusFilter');

  [addSelect, filterSelect].forEach((sel, i) => {
    if (!sel) return;
    sel.innerHTML = i === 0
      ? '<option value="">Campus (optional)</option>'
      : '<option value="">All campuses</option>';
    (data || []).forEach(c => sel.appendChild(new Option(c.name, c.id)));
    if (!data || data.length === 0) sel.style.display = 'none';
  });
}

/* ===============================
   HELPERS
================================ */


/* ===============================
   RENDER ROW
================================ */

function renderStudentRow(r) {
  const initials = `${r.first_name?.[0] ?? ''}${r.last_name?.[0] ?? ''}`.toUpperCase();
  const color    = getAvatarColor((r.first_name ?? '') + (r.last_name ?? ''));
  const inactive = r.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';

  const familyLabel = r.families
    ? `${r.families.carline_tag_number ? '#' + r.families.carline_tag_number + ' · ' : ''}${r.families.family_name ?? ''}`
    : '—';

  const teacherName = r.employees
    ? `${r.employees.first_name} ${r.employees.last_name}`
    : '—';

  const gradeBadge = r.grade_level
    ? `<span class="grade-badge">${esc(r.grade_level)}</span>`
    : '<span class="staff-cell-muted">—</span>';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initials}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(r.first_name)} ${esc(r.last_name)}</span>
          ${inactive}
        </div>
      </div>
    </td>
    <td class="staff-cell-muted">${esc(r.student_number ?? '—')}</td>
    <td class="staff-cell-muted">${esc(familyLabel)}</td>
    <td>${gradeBadge}</td>
    <td class="staff-cell-muted">${esc(teacherName)}</td>
    <td class="staff-cell-muted">${esc(r.bus_groups?.name ?? '—')}</td>
    <td class="staff-cell-muted">${esc(r.campuses?.name ?? '—')}</td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;

  tr.addEventListener('click', () => openEditStudentDrawer(r));
  return tr;
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditStudentDrawer(r) {
  editingStudentId = r.id;

  const initials = `${r.first_name?.[0] ?? ''}${r.last_name?.[0] ?? ''}`.toUpperCase();
  const color    = getAvatarColor((r.first_name ?? '') + (r.last_name ?? ''));

  const avatar = document.getElementById('estuAvatar');
  avatar.textContent      = initials;
  avatar.style.background = color;

  document.getElementById('estuTitle').textContent    = `${r.first_name} ${r.last_name}`;
  document.getElementById('estuSubtitle').textContent = r.grade_level
    ? `Grade ${r.grade_level}`
    : (r.families?.family_name ?? '');

  document.getElementById('estuFirst').value  = r.first_name ?? '';
  document.getElementById('estuLast').value   = r.last_name ?? '';
  document.getElementById('estuGrade').value  = r.grade_level ?? '';
  document.getElementById('estuNumber').value = r.student_number ?? '';
  document.getElementById('estuActive').checked = !!r.active;

  // Withdrawal state
  const isWithdrawn = !r.active && !!r.withdrawn_at;
  const withdrawnSection = document.getElementById('estuWithdrawnSection');
  if (withdrawnSection) {
    withdrawnSection.hidden = !isWithdrawn;
    if (isWithdrawn) {
      const d = new Date(r.withdrawn_at + 'T00:00:00');
      document.getElementById('estuWithdrawnDate').textContent =
        `Withdrawn on ${d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`;
      document.getElementById('estuWithdrawnReason').textContent = r.withdrawal_reason ?? '';
    }
  }
  document.getElementById('estuWithdrawBtn').style.display  = isWithdrawn ? 'none' : '';
  document.getElementById('estuReenrollBtn').style.display  = isWithdrawn ? ''     : 'none';

  // Populate selects from the add-drawer source selects
  cloneSelectOptions('#studentFamily',   document.getElementById('estuFamily'),   r.family_id);
  cloneSelectOptions('#studentHomeroom', document.getElementById('estuHomeroom'), r.homeroom_teacher_id);
  cloneSelectOptions('#studentBusGroup', document.getElementById('estuBus'),      r.bus_groups?.id);
  cloneSelectOptions('#studentCampus',   document.getElementById('estuCampus'),   r.campus_id);

  const saveBtn = document.getElementById('estuSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  loadDrawerGuardians(r.family_id);

  window.openDrawer?.('editStudentDrawer');
}

async function saveEditStudent() {
  if (!editingStudentId) return;

  const first = document.getElementById('estuFirst').value.trim();
  const last  = document.getElementById('estuLast').value.trim();
  const family = document.getElementById('estuFamily').value;
  if (!first || !last || !family) { alert('First name, last name, and family are required.'); return; }

  const updated = {
    first_name:          first,
    last_name:           last,
    family_id:           family,
    grade_level:         document.getElementById('estuGrade').value || null,
    student_number:      document.getElementById('estuNumber').value.trim() || null,
    homeroom_teacher_id: document.getElementById('estuHomeroom').value || null,
    bus_group_id:        document.getElementById('estuBus').value || null,
    campus_id:           document.getElementById('estuCampus').value || null,
    active:              document.getElementById('estuActive').checked,
  };

  const saveBtn = document.getElementById('estuSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('students').update(updated).eq('id', editingStudentId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { alert('Failed to save: ' + error.message); return; }
  window.closeDrawer?.('editStudentDrawer');
  studentsDirectory.load();
}

function openWithdrawModal() {
  if (!editingStudentId) return;
  const name = `${document.getElementById('estuFirst').value} ${document.getElementById('estuLast').value}`;
  document.getElementById('withdrawStudentMsg').textContent = `Enter withdrawal details for ${name}.`;
  document.getElementById('withdrawDate').value   = new Date().toISOString().slice(0, 10);
  document.getElementById('withdrawReason').value = '';
  document.getElementById('withdrawStudentModal').hidden = false;
}

async function executeWithdrawStudent() {
  if (!editingStudentId) return;
  const date   = document.getElementById('withdrawDate').value;
  const reason = document.getElementById('withdrawReason').value.trim();
  if (!date) { alert('Please enter a withdrawal date.'); return; }

  const { error } = await supabase.from('students').update({
    active:            false,
    withdrawn_at:      date,
    withdrawal_reason: reason || null,
  }).eq('id', editingStudentId);

  document.getElementById('withdrawStudentModal').hidden = true;
  if (error) { alert('Failed to withdraw student: ' + error.message); return; }
  window.closeDrawer?.('editStudentDrawer');
  editingStudentId = null;
  studentsDirectory.load();
}

function openReenrollModal() {
  if (!editingStudentId) return;
  const name = `${document.getElementById('estuFirst').value} ${document.getElementById('estuLast').value}`;
  document.getElementById('reenrollStudentMsg').textContent =
    `Re-enroll ${name}? This will mark them as active and clear their withdrawal record.`;
  document.getElementById('reenrollStudentModal').hidden = false;
}

async function executeReenrollStudent() {
  if (!editingStudentId) return;
  const { error } = await supabase.from('students').update({
    active:            true,
    withdrawn_at:      null,
    withdrawal_reason: null,
  }).eq('id', editingStudentId);

  document.getElementById('reenrollStudentModal').hidden = true;
  if (error) { alert('Failed to re-enroll student: ' + error.message); return; }
  window.closeDrawer?.('editStudentDrawer');
  editingStudentId = null;
  studentsDirectory.load();
}

async function loadDrawerGuardians(familyId) {
  const list = document.getElementById('estuGuardiansList');
  if (!list) return;
  if (!familyId) {
    list.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">No family linked.</span>';
    return;
  }
  list.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">Loading…</span>';
  const { data } = await supabase
    .from('guardians')
    .select('first_name, last_name, phone, relationship')
    .eq('family_id', familyId)
    .order('last_name');
  if (!data?.length) {
    list.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">No guardians on file.</span>';
    return;
  }
  list.innerHTML = data.map(g => `
    <div class="guardian-chip">
      <span class="guardian-chip-name">${esc(g.first_name)} ${esc(g.last_name)}</span>
      ${g.relationship ? `<span class="guardian-chip-rel">${esc(g.relationship)}</span>` : ''}
      ${g.phone ? `<a class="guardian-chip-phone" href="tel:${esc(g.phone)}">${esc(g.phone)}</a>` : ''}
    </div>
  `).join('');
}

/* ===============================
   EVENTS
================================ */

function wireStudentEvents() {
  document.getElementById('addStudent')?.addEventListener('click', createStudent);

  const searchInput    = document.getElementById('studentSearch');
  const sortSelect     = document.getElementById('studentSort');
  const gradeFilter    = document.getElementById('studentGradeFilter');
  const homeroomFilter = document.getElementById('studentHomeroomFilter');
  const campusFilter   = document.getElementById('studentCampusFilter');

  if (searchInput) {
    let t;
    searchInput.addEventListener('input', e => {
      clearTimeout(t);
      t = setTimeout(() => studentsDirectory.setSearch(e.target.value.trim()), 300);
    });
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      studentsDirectory.setSort(column, dir === 'asc');
    });
  }
  if (gradeFilter)    gradeFilter.addEventListener('change',    e => studentsDirectory.setFilter('grade',    e.target.value));
  if (homeroomFilter) homeroomFilter.addEventListener('change', e => studentsDirectory.setFilter('homeroom', e.target.value));
  if (campusFilter)   campusFilter.addEventListener('change',   e => studentsDirectory.setFilter('campus',   e.target.value));

  document.getElementById('exportStudentsCurrent')?.addEventListener('click', () => studentsDirectory.exportFiltered());
  document.getElementById('exportStudentsAll')?.addEventListener('click',     () => studentsDirectory.exportAll());

  // Edit drawer
  document.getElementById('estuSaveBtn')?.addEventListener('click',   saveEditStudent);
  document.getElementById('estuCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editStudentDrawer'));
  document.getElementById('estuCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editStudentDrawer'));
  document.getElementById('estuWithdrawBtn')?.addEventListener('click', openWithdrawModal);
  document.getElementById('estuReenrollBtn')?.addEventListener('click', openReenrollModal);

  // Withdraw modal
  document.getElementById('withdrawStudentCancel')?.addEventListener('click',  () => { document.getElementById('withdrawStudentModal').hidden = true; });
  document.getElementById('withdrawStudentConfirm')?.addEventListener('click', executeWithdrawStudent);

  // Re-enroll modal
  document.getElementById('reenrollStudentCancel')?.addEventListener('click',  () => { document.getElementById('reenrollStudentModal').hidden = true; });
  document.getElementById('reenrollStudentConfirm')?.addEventListener('click', executeReenrollStudent);

  // Guardian nav
  document.getElementById('estuGuardiansLink')?.addEventListener('click', () => {
    window.closeDrawer?.('editStudentDrawer');
    window.location.hash = '#guardians';
  });
}

/* ===============================
   CREATE STUDENT
================================ */

async function createStudent() {
  const student = {
    school_id:           currentProfile.school_id,
    family_id:           document.getElementById('studentFamily').value,
    first_name:          document.getElementById('studentFirst').value.trim(),
    last_name:           document.getElementById('studentLast').value.trim(),
    grade_level:         document.getElementById('studentGrade').value || null,
    homeroom_teacher_id: document.getElementById('studentHomeroom').value || null,
    bus_group_id:        document.getElementById('studentBusGroup').value || null,
    campus_id:           document.getElementById('studentCampus')?.value || null,
    student_number:      document.getElementById('studentNumber').value.trim() || null,
    active:              true
  };

  if (!student.first_name || !student.last_name || !student.family_id) {
    alert('First name, last name, and family are required.');
    return;
  }

  const { error } = await supabase.from('students').insert(student);
  if (error) { console.error('Create student error', error); alert('Failed to add student'); return; }

  ['studentFirst', 'studentLast', 'studentGrade', 'studentHomeroom', 'studentNumber']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });

  window.closeDrawer?.('studentDrawer');
  studentsDirectory.load();
}

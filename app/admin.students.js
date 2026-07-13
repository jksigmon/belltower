
import { supabase } from './admin.supabase.js';
import { loadFamilyOptions, loadBusGroupOptions, searchFamilies, esc, getAvatarColor, cloneSelectOptions, debounce, loadSchoolConfig, GRADE_ORDER, todayISO, dbError, showToast } from './admin.shared.js';
import { createDirectory } from './admin.directory.js';

let currentProfile;
let schoolConfig = null;
let initialized = false;
let studentsDirectory;
let selectedFamilyId = null;
let editingStudentId = null;
let schoolFlags = []; // { id, label, color, sort_order, archived_at }

/* ===============================
   ENTRY POINT
================================ */

export async function initStudentsSection(profile) {
  currentProfile = profile;
  if (!schoolConfig) schoolConfig = await loadSchoolConfig(profile.school_id);

  const usesHomerooms = schoolConfig?.uses_homerooms !== false;

  // Hide homeroom UI elements for schools that don't use them
  if (!usesHomerooms) {
    document.getElementById('studentHomeroomFilter')?.closest('label, div')?.style.setProperty('display', 'none');
    document.getElementById('studentHomeroom')?.closest('.drawer-field, .form-field, div')?.style.setProperty('display', 'none');
    document.getElementById('estuHomeroom')?.closest('.drawer-field, .form-field, div')?.style.setProperty('display', 'none');
  }

  await Promise.all([
    loadFamilyOptions([], currentProfile.school_id),
    loadBusGroupOptions('#studentBusGroup', currentProfile.school_id),
    usesHomerooms ? loadHomeroomOptions() : Promise.resolve(),
    loadCampusOptions(),
    loadSchoolPlacementFlags()
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
        preferred_name,
        grade_level,
        homeroom_teacher_id,
        campus_id,
        family_id,
        active,
        is_retained,
        retained,
        birthdate,
        withdrawn_at,
        withdrawal_reason,
        families(carline_tag_number, carline_tag_sort, family_name),
        employees!left(id, first_name, last_name),
        bus_groups(id, name),
        campuses(id, name),
        student_placement_flags(flag_id)
      `,

      searchFields: ['first_name', 'last_name', 'student_number'],

      filters: {
        grade:    val => val ? { column: 'grade_level',        op: 'eq', value: val } : null,
        homeroom: val => val ? { column: 'homeroom_teacher_id', op: 'eq', value: val } : null,
        campus:   val => val ? { column: 'campus_id',           op: 'eq', value: val } : null,
        family:   val => val === 'none' ? { column: 'family_id', op: 'is', value: null } : null
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
    populateGradeSelects();
    wireStudentEvents();
    initialized = true;
    studentsDirectory.load();
  }
}

/* ===============================
   GRADE SELECT POPULATION
================================ */

function populateGradeSelects() {
  const grades = schoolConfig?.grade_levels ?? GRADE_ORDER;
  ['studentGradeFilter', 'studentGrade', 'estuGrade'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const placeholder = id === 'studentGradeFilter' ? 'All grades' : 'Select grade';
    sel.innerHTML = `<option value="">${placeholder}</option>`;
    grades.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = g;
      sel.appendChild(opt);
    });
  });
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
    .eq('is_teacher', true)
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

async function loadSchoolPlacementFlags() {
  const { data } = await supabase
    .from('placement_flags')
    .select('id, label, color, sort_order, archived_at')
    .eq('school_id', currentProfile.school_id)
    .order('sort_order');
  schoolFlags = data ?? [];
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
  const inactive  = r.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';
  const retained  = r.retained    ? '<span class="student-retained-badge">Retained</span>'
                 : r.is_retained  ? '<span class="student-retained-badge">Retention Flagged</span>'
                 : '';

  const familyLabel = r.families
    ? `${r.families.carline_tag_number ? '#' + r.families.carline_tag_number + ' · ' : ''}${r.families.family_name ?? ''}`
    : '—';

  const teacherName = r.employees
    ? `${r.employees.first_name} ${r.employees.last_name}`
    : '—';

  const gradeBadge = r.grade_level
    ? `<span class="grade-badge">${esc(r.grade_level)}</span>`
    : '<span class="staff-cell-muted">—</span>';

  const flagDots = schoolFlags.length
    ? (r.student_placement_flags ?? [])
        .map(sf => schoolFlags.find(f => f.id === sf.flag_id))
        .filter(Boolean)
        .map(f => `<span class="student-flag-row-dot" style="background:${esc(f.color)}" title="${esc(f.label)}"></span>`)
        .join('')
    : '';
  const flagDotsHtml = flagDots
    ? `<div class="student-flags-row-dots">${flagDots}</div>`
    : '';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initials}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(r.first_name)} ${esc(r.last_name)}</span>
          ${retained}${inactive}
          ${flagDotsHtml}
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

async function openEditStudentDrawer(r) {
  editingStudentId = r.id;

  const initials = `${r.first_name?.[0] ?? ''}${r.last_name?.[0] ?? ''}`.toUpperCase();
  const color    = getAvatarColor((r.first_name ?? '') + (r.last_name ?? ''));

  const avatar = document.getElementById('estuAvatar');
  avatar.textContent      = initials;
  avatar.style.background = color;

  const displayName = r.preferred_name ? `${r.preferred_name} (${r.first_name} ${r.last_name})` : `${r.first_name} ${r.last_name}`;
  document.getElementById('estuTitle').textContent    = displayName;
  document.getElementById('estuSubtitle').textContent = r.grade_level
    ? `Grade ${r.grade_level}`
    : (r.families?.family_name ?? '');

  document.getElementById('estuFirst').value      = r.first_name ?? '';
  document.getElementById('estuLast').value       = r.last_name ?? '';
  document.getElementById('estuPreferred').value  = r.preferred_name ?? '';
  document.getElementById('estuGrade').value      = r.grade_level ?? '';
  document.getElementById('estuNumber').value     = r.student_number ?? '';
  document.getElementById('estuBirthdate').value  = r.birthdate ?? '';
  document.getElementById('estuRetained').checked = !!r.is_retained;
  const retainedNotice = document.getElementById('estuRetainedNotice');
  if (retainedNotice) retainedNotice.hidden = !r.retained;
  document.getElementById('estuActive').checked   = !!r.active;

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

  // Populate selects; family uses cache directly since add-drawer no longer has a <select> to clone
  await loadFamilyOptions(['#estuFamily'], currentProfile.school_id);
  const estuFamily = document.getElementById('estuFamily');
  if (estuFamily) estuFamily.value = r.family_id;
  cloneSelectOptions('#studentHomeroom', document.getElementById('estuHomeroom'), r.homeroom_teacher_id);
  cloneSelectOptions('#studentBusGroup', document.getElementById('estuBus'),      r.bus_groups?.id);
  cloneSelectOptions('#studentCampus',   document.getElementById('estuCampus'),   r.campus_id);

  const saveBtn = document.getElementById('estuSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  loadDrawerGuardians(r.family_id);
  loadStudentFlagsSection(r.id);

  window.openDrawer?.('editStudentDrawer');
}

async function saveEditStudent() {
  if (!editingStudentId) return;

  const first = document.getElementById('estuFirst').value.trim();
  const last  = document.getElementById('estuLast').value.trim();
  const family = document.getElementById('estuFamily').value || null;
  if (!first || !last) { alert('First name and last name are required.'); return; }

  const updated = {
    first_name:          first,
    last_name:           last,
    preferred_name:      document.getElementById('estuPreferred').value.trim() || null,
    family_id:           family,
    grade_level:         document.getElementById('estuGrade').value || null,
    student_number:      document.getElementById('estuNumber').value.trim() || null,
    homeroom_teacher_id: document.getElementById('estuHomeroom').value || null,
    bus_group_id:        document.getElementById('estuBus').value || null,
    campus_id:           document.getElementById('estuCampus').value || null,
    birthdate:           document.getElementById('estuBirthdate').value || null,
    is_retained:         document.getElementById('estuRetained').checked,
    active:              document.getElementById('estuActive').checked,
  };

  const saveBtn = document.getElementById('estuSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('students').update(updated).eq('id', editingStudentId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { dbError(error, 'Failed to save student'); return; }
  window.closeDrawer?.('editStudentDrawer');
  studentsDirectory.load();

  if (!family) {
    showToast('Changes saved — no family assigned. Carline and dismissal will not work until a family number is linked.', 'warn', 8000);
  }
}

function openWithdrawModal() {
  if (!editingStudentId) return;
  const name = `${document.getElementById('estuFirst').value} ${document.getElementById('estuLast').value}`;
  document.getElementById('withdrawStudentMsg').textContent = `Enter withdrawal details for ${name}.`;
  document.getElementById('withdrawDate').value   = todayISO();
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
  if (error) { dbError(error, 'Failed to withdraw student'); return; }
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
  if (error) { dbError(error, 'Failed to re-enroll student'); return; }
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
    .select('first_name, last_name, phone')
    .eq('family_id', familyId)
    .order('last_name');
  if (!data?.length) {
    list.innerHTML = '<span style="font-size:13px;color:var(--text-muted);">No guardians on file.</span>';
    return;
  }
  list.innerHTML = data.map(g => `
    <div class="guardian-chip">
      <span class="guardian-chip-name">${esc(g.first_name)} ${esc(g.last_name)}</span>
      ${g.phone ? `<a class="guardian-chip-phone" href="tel:${esc(g.phone)}">${esc(g.phone)}</a>` : ''}
    </div>
  `).join('');
}

/* ===============================
   PLACEMENT FLAGS
================================ */

async function loadStudentFlagsSection(studentId) {
  const section   = document.getElementById('estuFlagsSection');
  const container = document.getElementById('estuFlagsContainer');
  if (!section || !container) return;

  const activeFlags   = schoolFlags.filter(f => !f.archived_at);
  const archivedFlags = schoolFlags.filter(f => !!f.archived_at);

  // If school has no flags at all, hide the section
  if (schoolFlags.length === 0) { section.hidden = true; return; }

  // Load this student's current flag assignments
  const { data } = await supabase
    .from('student_placement_flags')
    .select('flag_id')
    .eq('student_id', studentId);

  const activeFlagIds = new Set((data ?? []).map(r => r.flag_id));

  // Archived flags the student currently has (can only be removed, not added back)
  const archivedAssigned = archivedFlags.filter(f => activeFlagIds.has(f.id));

  // Hide section if there's nothing to show
  if (activeFlags.length === 0 && archivedAssigned.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  container.innerHTML = '';
  const canManage = !!currentProfile?.can_manage_placement;

  // Active flags — full toggle chips
  activeFlags.forEach(flag => {
    const isOn = activeFlagIds.has(flag.id);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `student-flag-chip ${isOn ? 'active' : 'inactive'}`;
    chip.style.setProperty('--flag-color', flag.color);
    chip.innerHTML = `<span class="flag-dot"></span>${esc(flag.label)}`;
    chip.title = flag.label;
    chip.disabled = !canManage;
    if (canManage) {
      chip.addEventListener('click', () => toggleStudentFlag(chip, studentId, flag.id, activeFlagIds));
    }
    container.appendChild(chip);
  });

  // Archived flags the student has — remove-only
  archivedAssigned.forEach(flag => {
    const chip = document.createElement('span');
    chip.className = 'student-flag-chip archived';
    chip.innerHTML = `<span class="flag-dot"></span>${esc(flag.label)}`;
    chip.title = `${flag.label} (archived)`;
    if (canManage) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'flag-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove flag';
      removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        await supabase.from('student_placement_flags')
          .delete()
          .eq('student_id', studentId)
          .eq('flag_id', flag.id);
        activeFlagIds.delete(flag.id);
        chip.remove();
      });
      chip.appendChild(removeBtn);
    }
    container.appendChild(chip);
  });
}

async function toggleStudentFlag(chip, studentId, flagId, activeFlagIds) {
  chip.disabled = true;
  if (activeFlagIds.has(flagId)) {
    const { error } = await supabase.from('student_placement_flags')
      .delete().eq('student_id', studentId).eq('flag_id', flagId);
    if (!error) {
      activeFlagIds.delete(flagId);
      chip.classList.replace('active', 'inactive');
    }
  } else {
    const { error } = await supabase.from('student_placement_flags')
      .upsert({ student_id: studentId, flag_id: flagId });
    if (!error) {
      activeFlagIds.add(flagId);
      chip.classList.replace('inactive', 'active');
    }
  }
  chip.disabled = false;
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
  const familyFilter   = document.getElementById('studentFamilyFilter');

  if (searchInput) {
    searchInput.addEventListener('input', debounce(e =>
      studentsDirectory.setSearch(e.target.value.trim()), 300));
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
  if (familyFilter)   familyFilter.addEventListener('change',   e => studentsDirectory.setFilter('family',   e.target.value));

  document.getElementById('exportStudentsCurrent')?.addEventListener('click', () => studentsDirectory.exportFiltered());
  document.getElementById('exportStudentsAll')?.addEventListener('click',     () => studentsDirectory.exportAll());

  // Family typeahead
  document.getElementById('studentFamilySearch')?.addEventListener('input', debounce(onFamilySearchInput, 200));
  document.getElementById('studentFamilySearch')?.addEventListener('blur', () => {
    setTimeout(() => { const r = document.getElementById('studentFamilyResults'); if (r) r.style.display = 'none'; }, 150);
  });

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
   FAMILY TYPEAHEAD
================================ */

function onFamilySearchInput(e) {
  const term = e.target.value.trim();
  const resultsEl = document.getElementById('studentFamilyResults');
  if (!resultsEl) return;

  const matches = searchFamilies(currentProfile.school_id, term);

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="ft-typeahead-empty">No families found.</div>`;
    resultsEl.style.display = 'block';
    return;
  }

  resultsEl.innerHTML = matches.map(f => {
    const label = f.carline_tag_number
      ? `${f.carline_tag_number} – ${esc(f.family_name ?? '(no name)')}`
      : esc(f.family_name ?? '(no name)');
    return `<div class="ft-typeahead-item" data-id="${esc(f.id)}" data-label="${esc(label)}"><strong>${label}</strong></div>`;
  }).join('');

  resultsEl.querySelectorAll('.ft-typeahead-item').forEach(item => {
    item.addEventListener('mousedown', () => selectFamily(item.dataset.id, item.dataset.label));
  });

  resultsEl.style.display = 'block';
}

function selectFamily(id, label) {
  selectedFamilyId = id;
  const searchEl = document.getElementById('studentFamilySearch');
  const hiddenEl = document.getElementById('studentFamily');
  const resultsEl = document.getElementById('studentFamilyResults');
  if (searchEl)  searchEl.value = label;
  if (hiddenEl)  hiddenEl.value = id;
  if (resultsEl) resultsEl.style.display = 'none';
}

function resetFamilyTypeahead() {
  selectedFamilyId = null;
  const searchEl = document.getElementById('studentFamilySearch');
  const hiddenEl = document.getElementById('studentFamily');
  const resultsEl = document.getElementById('studentFamilyResults');
  if (searchEl)  searchEl.value = '';
  if (hiddenEl)  hiddenEl.value = '';
  if (resultsEl) resultsEl.style.display = 'none';
}

/* ===============================
   CREATE STUDENT
================================ */

async function createStudent() {
  const student = {
    school_id:           currentProfile.school_id,
    family_id:           selectedFamilyId,
    first_name:          document.getElementById('studentFirst').value.trim(),
    last_name:           document.getElementById('studentLast').value.trim(),
    preferred_name:      document.getElementById('studentPreferred').value.trim() || null,
    grade_level:         document.getElementById('studentGrade').value || null,
    homeroom_teacher_id: document.getElementById('studentHomeroom').value || null,
    bus_group_id:        document.getElementById('studentBusGroup').value || null,
    campus_id:           document.getElementById('studentCampus')?.value || null,
    student_number:      document.getElementById('studentNumber').value.trim() || null,
    birthdate:           document.getElementById('studentBirthdate').value || null,
    active:              true
  };

  if (!student.first_name || !student.last_name) {
    alert('First name and last name are required.');
    return;
  }

  const { error } = await supabase.from('students').insert(student);
  if (error) { dbError(error, 'Failed to add student'); return; }

  ['studentFirst', 'studentLast', 'studentPreferred', 'studentGrade', 'studentHomeroom',
   'studentNumber', 'studentCampus', 'studentBusGroup', 'studentBirthdate']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  resetFamilyTypeahead();

  window.closeDrawer?.('studentDrawer');
  studentsDirectory.load();

  if (!student.family_id) {
    showToast('Student added — no family assigned. Carline and dismissal will not work until a family number is linked.', 'warn', 8000);
  }
}

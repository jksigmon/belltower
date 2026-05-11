
import { supabase } from './admin.supabase.js';
import { loadFamilyOptions, loadBusGroupOptions } from './admin.shared.js';
import { createDirectory } from './admin.directory.js';

let currentProfile;
let initialized = false;
let studentsDirectory;
/* ===============================
   ENTRY POINT
================================ */

export async function initStudentsSection(profile) {
  currentProfile = profile;

  // Shared dropdowns
 await Promise.all([
  loadFamilyOptions(['#studentFamily']),
  loadBusGroupOptions('#studentBusGroup'),
  loadHomeroomTeacherOptions(),
  loadHomeroomFilterOptions(),
  loadCampusOptions()
])


  // ✅ Ensure directory exists first
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
	  active,
	  families!inner(carline_tag_number, family_name),
	  employees!left(id, first_name, last_name),
	  bus_groups(id, name),
	  campuses(id, name)
	`,


      // ✅ Base-table search only
      searchFields: [
        'first_name',
        'last_name',
        'student_number'
      ],

      // ✅ Filters
      filters: {
        grade: val =>
          val ? { column: 'grade_level', op: 'eq', value: val } : null,
        homeroom: val =>
          val ? { column: 'homeroom_teacher_id', op: 'eq', value: val } : null,
        campus: val =>
          val ? { column: 'campus_id', op: 'eq', value: val } : null
      },

      defaultSort: {
        column: 'last_name',
        ascending: true
      },

      tbodySelector: '#studentsTable tbody',
      paginationContainer: '#studentsPagination',
      renderRow: renderStudentRow,

      // ✅ Family / carline search (same pattern as Guardians)
      augmentQuery(query, searchTerm) {
        if (!searchTerm) return query;

        const term = `%${searchTerm}%`;
        const isNumeric = /^\d+$/.test(searchTerm);

        if (isNumeric) {
          return {
            query: query.or(
              `carline_tag_number.ilike.${term}`,
              { foreignTable: 'families' }
            ),
            skipBaseSearch: true
          };
        }

        // text search → base-table search only
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

async function loadHomeroomTeacherOptions() {
  const select = document.getElementById('studentHomeroom');
  if (!select) return;

  select.innerHTML = '';
  select.appendChild(new Option('Select homeroom teacher', ''));

  const { data, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .eq('school_id', currentProfile.school_id)
    .eq('active', true)
    .ilike('position', '%teacher%')
    .order('last_name');

  if (error) {
    console.error('Failed to load teachers', error);
    return;
  }

  data.forEach(t => {
    select.appendChild(
      new Option(`${t.first_name} ${t.last_name}`, t.id)
    );
  });
}

async function loadHomeroomFilterOptions() {
  const select = document.getElementById('studentHomeroomFilter');
  if (!select) return;

  select.innerHTML = '';
  select.appendChild(new Option('All homerooms', ''));

  const { data, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name')
    .eq('school_id', currentProfile.school_id)
    .eq('active', true)
    .ilike('position', '%teacher%')
    .order('last_name');

  if (!error) {
    data.forEach(t =>
      select.appendChild(
        new Option(`${t.first_name} ${t.last_name}`, t.id)
      )
    );
  }
}

async function loadCampusOptions() {
  const { data } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', currentProfile.school_id)
    .order('name');

  const addSelect = document.getElementById('studentCampus');
  const filterSelect = document.getElementById('studentCampusFilter');

  [addSelect, filterSelect].forEach((sel, i) => {
    if (!sel) return;
    sel.innerHTML = i === 0
      ? '<option value="">Campus (optional)</option>'
      : '<option value="">All campuses</option>';
    (data || []).forEach(c => {
      sel.appendChild(new Option(c.name, c.id));
    });
    if (!data || data.length === 0) sel.style.display = 'none';
  });
}

/* ===============================
   RENDER ROW
================================ */
function renderStudentRow(r) {
  const tr = document.createElement('tr');

  const familyLabel = r.families
    ? `${r.families.carline_tag_number} – ${r.families.family_name ?? '(no name)'}`
    : '';

  tr.innerHTML = `
    <td>
      <span class="view">${r.first_name} ${r.last_name}</span>
      <div class="edit" hidden>
        <input class="form-input first" value="${r.first_name}">
        <input class="form-input last" value="${r.last_name}">
      </div>
    </td>

    <td>
      <input
        class="form-input readonly student-number"
        readonly
        value="${r.student_number ?? ''}"
      >
    </td>

    <td>${familyLabel}</td>

    <td>
      <span class="view">${r.grade_level ?? ''}</span>
      <input class="form-input edit grade" hidden value="${r.grade_level ?? ''}">
    </td>

    <td>
      		<span class="view">
		  ${r.employees
			? `${r.employees.first_name} ${r.employees.last_name}`
			: ''}
		</span>
		<select class="form-input edit homeroom" hidden></select>
    </td>

    <td>
      <span class="view">${r.bus_groups?.name ?? ''}</span>
      <select class="form-input edit bus" hidden></select>
    </td>

    <td>
      <span class="view">${r.campuses?.name ?? '—'}</span>
      <select class="form-input edit campus" hidden></select>
    </td>

    <td>
      <span class="view">${r.active ? 'Yes' : 'No'}</span>
      <input type="checkbox" class="edit active" ${r.active ? 'checked' : ''} hidden>
    </td>

<td class="col-actions">
  <div class="action-buttons">
    <button class="btn editBtn">Edit</button>
    <button class="btn saveBtn" hidden>Save</button>
    <button class="btn cancelBtn" hidden>Cancel</button>
    <button class="btn danger deleteBtn">Delete</button>
  </div>
</td>


  `;

  wireStudentRow(tr, r);
  return tr;
}

/* ===============================
   ROW LOGIC
================================ */

function wireStudentRow(tr, r) {
  const editBtn   = tr.querySelector('.editBtn');
  const saveBtn   = tr.querySelector('.saveBtn');
  const cancelBtn = tr.querySelector('.cancelBtn');
  const deleteBtn = tr.querySelector('.deleteBtn');

  const views = tr.querySelectorAll('.view');
  const edits = tr.querySelectorAll('.edit');

  const busSelect = tr.querySelector('.bus');
  document.querySelectorAll('#studentBusGroup option').forEach(opt =>
    busSelect.appendChild(opt.cloneNode(true))
  );
  busSelect.value = r.bus_groups?.id ?? '';

  const campusSelect = tr.querySelector('.campus');
  document.querySelectorAll('#studentCampus option').forEach(opt =>
    campusSelect.appendChild(opt.cloneNode(true))
  );
  campusSelect.value = r.campus_id ?? '';
    
const homeroomSelect = tr.querySelector('.homeroom');

document
  .querySelectorAll('#studentHomeroom option')
  .forEach(opt => homeroomSelect.appendChild(opt.cloneNode(true)));

homeroomSelect.value = r.homeroom_teacher_id ?? '';


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
      grade_level: tr.querySelector('.grade').value.trim() || null,
      homeroom_teacher_id: tr.querySelector('.homeroom').value || null,
      bus_group_id: busSelect.value || null,
      campus_id: campusSelect.value || null,
      active: tr.querySelector('.active').checked
    };

    if (!updated.first_name || !updated.last_name) {
      alert('First and last name are required.');
      return;
    }

    const { error } = await supabase
      .from('students')
      .update(updated)
      .eq('id', r.id);

    if (error) {
      console.error('Student update error', error);
      alert('Failed to update student');
      return;
    }

    // Reset everything by reloading
    studentsDirectory.load();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore default state
    studentsDirectory.load();
  };

  /* ---------- DELETE ---------- */
  deleteBtn.onclick = async () => {
    if (!confirm('Delete this student?')) return;

    const { error } = await supabase
      .from('students')
      .delete()
      .eq('id', r.id);

    if (error) {
      console.error('Delete student failed', error);
      alert('Failed to delete student');
      return;
    }

    studentsDirectory.load();
  };
}

/* ===============================
   CREATE / DELETE
================================ */
async function createStudent() {
  const student = {
    school_id: currentProfile.school_id,
    family_id: document.getElementById('studentFamily').value,
    first_name: document.getElementById('studentFirst').value.trim(),
    last_name: document.getElementById('studentLast').value.trim(),
    grade_level: document.getElementById('studentGrade').value.trim() || null,
    homeroom_teacher_id: document.getElementById('studentHomeroom').value || null,
    bus_group_id: document.getElementById('studentBusGroup').value || null,
    campus_id: document.getElementById('studentCampus')?.value || null,
    student_number: document.getElementById('studentNumber').value.trim() || null,
    active: true
  };

  if (!student.first_name || !student.last_name || !student.family_id) {
    alert('First, last name, and family are required.');
    return;
  }

  const { error } = await supabase.from('students').insert(student);
  if (error) {
    console.error('Create student error', error);
    alert('Failed to add student');
    return;
  }

  ['studentFirst','studentLast','studentGrade','studentHomeroom','studentNumber']
    .forEach(id => (document.getElementById(id).value = ''));

  studentsDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireStudentEvents() {
  document
    .getElementById('addStudent')
    ?.addEventListener('click', createStudent);

  const searchInput = document.getElementById('studentSearch');
  const sortSelect = document.getElementById('studentSort');
  const gradeFilter = document.getElementById('studentGradeFilter');
  const homeroomFilter = document.getElementById('studentHomeroomFilter');

  // 🔍 Search
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', e => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        studentsDirectory.setSearch(e.target.value.trim());
      }, 300);
    });
  }

  // ↕️ Sort
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      studentsDirectory.setSort(column, dir === 'asc');
    });
  }

  // 🎓 Grade filter
  if (gradeFilter) {
    gradeFilter.addEventListener('change', e =>
      studentsDirectory.setFilter('grade', e.target.value)
    );
  }

  // 🏫 Homeroom filter
  if (homeroomFilter) {
    homeroomFilter.addEventListener('change', e =>
      studentsDirectory.setFilter('homeroom', e.target.value)
    );
  }

  const campusFilter = document.getElementById('studentCampusFilter');
  if (campusFilter) {
    campusFilter.addEventListener('change', e =>
      studentsDirectory.setFilter('campus', e.target.value)
    );
  }

  // 📤 Export view
  document
    .getElementById('exportStudentsCurrent')
    ?.addEventListener('click', () =>
      studentsDirectory.exportFiltered()
    );

  // 📤 Export all
  document
    .getElementById('exportStudentsAll')
    ?.addEventListener('click', () =>
      studentsDirectory.exportAll()
    );
}


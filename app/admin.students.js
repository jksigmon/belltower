
import { supabase } from './admin.supabase.js';
import { loadFamilyOptions, loadBusGroupOptions } from './admin.shared.js';

let currentProfile;
let initialized = false;

/* ===============================
   ENTRY POINT
================================ */
export async function initStudentsSection(profile) {
  currentProfile = profile;

  if (!initialized) {
    wireStudentEvents();
    initialized = true;
  }

  await Promise.all([
    loadFamilyOptions(['#studentFamily']),
    loadBusGroupOptions('#studentBusGroup')
  ]);

  await loadStudents();
}

/* ===============================
   LOAD STUDENTS
================================ */
async function loadStudents() {
  const tbody = document.querySelector('#studentsTable tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  const { data, error } = await supabase
    .from('students')
    .select(`
      id,
      student_number,
      first_name,
      last_name,
      grade_level,
      homeroom_teacher,
      active,
      families(carline_tag_number, family_name),
      bus_groups(id, name)
    `)
    .eq('school_id', currentProfile.school_id)
    .order('last_name');

  if (error) {
    console.error('Load students failed', error);
    return;
  }

  (data || []).forEach(student => {
    tbody.appendChild(renderStudentRow(student));
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
      <span class="view">${r.homeroom_teacher ?? ''}</span>
      <input class="form-input edit homeroom" hidden value="${r.homeroom_teacher ?? ''}">
    </td>

    <td>
      <span class="view">${r.bus_groups?.name ?? ''}</span>
      <select class="form-input edit bus" hidden></select>
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
      homeroom_teacher: tr.querySelector('.homeroom').value.trim() || null,
      bus_group_id: busSelect.value || null,
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
    loadStudents();
  };

  /* ---------- CANCEL ---------- */
  cancelBtn.onclick = () => {
    // Discard edits, restore default state
    loadStudents();
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

    loadStudents();
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
    homeroom_teacher: document.getElementById('studentHomeroom').value.trim() || null,
    bus_group_id: document.getElementById('studentBusGroup').value || null,
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

  loadStudents();
}

/* ===============================
   EVENTS
================================ */
function wireStudentEvents() {
  document
    .getElementById('addStudent')
    ?.addEventListener('click', createStudent);
}

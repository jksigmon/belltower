
import { supabase } from './admin.supabase.js?v=2';
import { createDirectory } from './admin.directory.js?v=2';
import { esc, getAvatarColor, debounce, dbError, showToast, findTagConflict, gradeLabel } from './admin.shared.js?v=3';

let currentProfile;
let initialized    = false;
let carpoolsDir;
let editingId      = null;
let editingTagNumber = null; // tag as loaded, so an unchanged tag skips the conflict check
let allFamilies    = [];
let editingMembers = []; // family_ids currently in the open carpool
let editingStudentMembers = []; // student_ids currently in the open carpool

/* ===============================
   ENTRY POINT
================================ */

export async function initCarpoolsSection(profile) {
  currentProfile = profile;

  if (!carpoolsDir) {
    carpoolsDir = createDirectory({
      table:        'carpools',
      schoolId:     () => currentProfile.school_id,
      select:       `id, tag_number, label, active,
                     carline_tags ( id, family_id,
                       families ( family_name, carline_tag_number ) ),
                     carpool_students ( id, student_id,
                       students ( first_name, last_name, grade_level ) )`,
      searchFields: ['tag_number', 'label'],
      defaultSort:  { column: 'tag_number', ascending: true },
      tbodySelector: '#carpoolsTable tbody',
      renderRow:    renderCarpoolRow,
    });
  }

  // Always refresh so the inherit dropdown is current
  await loadAllFamilies();

  if (!initialized) {
    wireCarpoolEvents();
    initialized = true;
    carpoolsDir.load();
  }
}

/* ===============================
   HELPERS
================================ */


async function loadAllFamilies() {
  const { data, error } = await supabase
    .from('families')
    .select('id, family_name, carline_tag_number')
    .eq('school_id', currentProfile.school_id)
    .order('family_name');
  if (error) {
    console.error('[Carpools] Failed to load families:', error.message);
    return;
  }
  allFamilies = data || [];
}

/* ===============================
   RENDER ROW
================================ */

function renderCarpoolRow(cp) {
  const members       = cp.carline_tags || [];
  const studentMembers = cp.carpool_students || [];
  const count         = members.length + studentMembers.length;
  const color         = getAvatarColor(cp.tag_number ?? '');
  const inactive      = cp.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';
  const memberNames   = [
    ...members.map(ct => ct.families?.family_name ?? '?'),
    ...studentMembers.map(cs => cs.students
      ? `${cs.students.first_name} ${cs.students.last_name}`
      : '?'),
  ].join(', ');
  const displayName   = cp.label || `Pickup tag #${cp.tag_number}`;

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar carpool-avatar" style="background:${color}">#</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(displayName)}</span>
          ${inactive}
          <span class="staff-meta muted" style="font-size:12px;">${esc(memberNames) || 'No members assigned'}</span>
        </div>
        <span class="carline-tag-badge">#${esc(cp.tag_number)} &middot; ${count} member${count === 1 ? '' : 's'}</span>
      </div>
    </td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;
  tr.addEventListener('click', () => openEditDrawer(cp));
  return tr;
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditDrawer(cp) {
  editingId             = cp.id;
  editingTagNumber      = cp.tag_number ?? '';
  editingMembers        = (cp.carline_tags || []).map(ct => ct.family_id);
  editingStudentMembers = (cp.carpool_students || []).map(cs => cs.student_id);

  const color  = getAvatarColor(cp.tag_number ?? '');
  const avatar = document.getElementById('ecpAvatar');
  avatar.textContent      = '#';
  avatar.style.background = color;

  document.getElementById('ecpTitle').textContent    = cp.label || `Pickup tag #${cp.tag_number}`;
  document.getElementById('ecpSubtitle').textContent = `Tag #${cp.tag_number}`;

  document.getElementById('ecpTag').value      = cp.tag_number ?? '';
  document.getElementById('ecpLabel').value    = cp.label ?? '';
  document.getElementById('ecpActive').checked = !!cp.active;

  document.getElementById('ecpAddFamilyPicker').hidden  = true;
  document.getElementById('ecpAddStudentPicker').hidden = true;
  renderMemberList(cp.carline_tags || [], cp.carpool_students || []);

  const saveBtn = document.getElementById('ecpSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  window.openDrawer?.('editCarpoolDrawer');
}

// Builds one row for either member type. Families call every student in the
// household; a student member calls only that child — the sub-label says which
// so the distinction is visible without opening anything else.
function memberRow({ name, badge, subLabel, onRemove }) {
  const color = getAvatarColor(name);
  const row = document.createElement('div');
  row.className = 'carpool-member-row';
  row.innerHTML = `
    <div class="staff-avatar" style="background:${color};width:28px;height:28px;min-width:28px;font-size:12px;border-radius:50%;">${esc(name[0]?.toUpperCase() ?? '?')}</div>
    <div style="flex:1;min-width:0;">
      <span style="font-size:13px;font-weight:600;">${esc(name)}</span>
      ${badge ? `<span class="carline-tag-badge" style="margin-left:6px;">${esc(badge)}</span>` : ''}
      <span class="muted" style="display:block;font-size:11px;">${esc(subLabel)}</span>
    </div>
    <button class="btn danger" style="padding:3px 10px;font-size:12px;">Remove</button>
  `;
  row.querySelector('button').addEventListener('click', onRemove);
  return row;
}

function renderMemberList(tags, studentTags) {
  const container = document.getElementById('ecpMemberList');
  container.innerHTML = '';

  if (!tags.length && !studentTags.length) {
    container.innerHTML = '<div class="muted" style="font-size:13px;padding:4px 0;">No members assigned yet.</div>';
    return;
  }

  tags.forEach(ct => {
    const f    = ct.families;
    const name = f?.family_name ?? '(Unnamed)';
    container.appendChild(memberRow({
      name,
      badge:    f?.carline_tag_number ? `#${f.carline_tag_number}` : '',
      subLabel: 'Whole family — calls every student in this household',
      onRemove: () => removeMember(ct.family_id, ct.id),
    }));
  });

  studentTags.forEach(cs => {
    const s    = cs.students;
    const name = s ? `${s.first_name} ${s.last_name}` : '(Unknown student)';
    const grade = s?.grade_level ? gradeLabel(s.grade_level) : '';
    container.appendChild(memberRow({
      name,
      badge:    grade,
      subLabel: 'Individual student — calls only this child',
      onRemove: () => removeStudentMember(cs.student_id, cs.id),
    }));
  });
}

async function removeMember(familyId, tagRowId) {
  const { error } = await supabase.from('carline_tags').delete().eq('id', tagRowId);
  if (error) { dbError(error, 'Failed to remove family'); return; }
  editingMembers = editingMembers.filter(id => id !== familyId);
  await refreshMemberList();
}

async function removeStudentMember(studentId, rowId) {
  const { error } = await supabase.from('carpool_students').delete().eq('id', rowId);
  if (error) { dbError(error, 'Failed to remove student'); return; }
  editingStudentMembers = editingStudentMembers.filter(id => id !== studentId);
  await refreshMemberList();
}

async function refreshMemberList() {
  const { data } = await supabase
    .from('carpools')
    .select(`carline_tags ( id, family_id, families ( family_name, carline_tag_number ) ),
             carpool_students ( id, student_id, students ( first_name, last_name, grade_level ) )`)
    .eq('id', editingId)
    .single();
  if (!data) return;
  const tags        = data.carline_tags     || [];
  const studentTags = data.carpool_students || [];
  editingMembers        = tags.map(ct => ct.family_id);
  editingStudentMembers = studentTags.map(cs => cs.student_id);
  renderMemberList(tags, studentTags);
}

/* ── Add-family picker ── */

function toggleAddFamilyPicker() {
  const picker = document.getElementById('ecpAddFamilyPicker');
  picker.hidden = !picker.hidden;
  if (!picker.hidden) {
    document.getElementById('ecpFamilySearch').value = '';
    renderFamilyOptions('');
    document.getElementById('ecpFamilySearch').focus();
  }
}

function renderFamilyOptions(search) {
  const list = document.getElementById('ecpFamilyOptions');
  const term = search.toLowerCase();
  const available = allFamilies.filter(f =>
    !editingMembers.includes(f.id) &&
    (!term ||
      (f.family_name ?? '').toLowerCase().includes(term) ||
      (f.carline_tag_number ?? '').includes(term))
  );

  list.innerHTML = '';
  if (!available.length) {
    list.innerHTML = '<div class="muted" style="font-size:13px;padding:6px 8px;">No families available</div>';
    return;
  }
  available.forEach(f => {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'carpool-family-option';
    btn.innerHTML = `
      <span>${esc(f.family_name ?? '(Unnamed)')}</span>
      ${f.carline_tag_number ? `<span class="carline-tag-badge">#${esc(f.carline_tag_number)}</span>` : ''}
    `;
    btn.addEventListener('click', () => addMember(f.id));
    list.appendChild(btn);
  });
}

async function addMember(familyId) {
  const { error } = await supabase.from('carline_tags').insert({
    carpool_id: editingId,
    family_id:  familyId,
  });
  if (error) { dbError(error, 'Failed to add family to pickup tag'); return; }
  document.getElementById('ecpAddFamilyPicker').hidden = true;
  await refreshMemberList();
}

/* ── Add-student picker ── */

// Searched rather than preloaded like families: a school can have thousands of
// students, and the family list is already cached for the inherit dropdown.
function toggleAddStudentPicker() {
  const picker = document.getElementById('ecpAddStudentPicker');
  picker.hidden = !picker.hidden;
  if (!picker.hidden) {
    document.getElementById('ecpStudentSearch').value = '';
    document.getElementById('ecpStudentOptions').innerHTML =
      '<div class="muted" style="font-size:13px;padding:6px 8px;">Type at least 2 letters of a name.</div>';
    document.getElementById('ecpStudentSearch').focus();
  }
}

async function renderStudentOptions(term) {
  const list = document.getElementById('ecpStudentOptions');
  const trimmed = term.trim();

  if (trimmed.length < 2) {
    list.innerHTML = '<div class="muted" style="font-size:13px;padding:6px 8px;">Type at least 2 letters of a name.</div>';
    return;
  }

  const { data, error } = await supabase
    .from('students')
    .select('id, first_name, last_name, grade_level, families ( family_name, carline_tag_number )')
    .eq('school_id', currentProfile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${trimmed}%,last_name.ilike.%${trimmed}%`)
    .order('last_name')
    .limit(10);

  if (error) {
    list.innerHTML = `<div class="muted" style="font-size:13px;padding:6px 8px;">Search failed: ${esc(error.message)}</div>`;
    return;
  }

  const available = (data || []).filter(s => !editingStudentMembers.includes(s.id));

  list.innerHTML = '';
  if (!available.length) {
    list.innerHTML = '<div class="muted" style="font-size:13px;padding:6px 8px;">No matching students (or already added).</div>';
    return;
  }

  available.forEach(s => {
    const fam = s.families;
    const meta = [
      s.grade_level ? gradeLabel(s.grade_level) : '',
      fam?.carline_tag_number ? `family #${fam.carline_tag_number}` : 'no family',
    ].filter(Boolean).join(' · ');

    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'carpool-family-option';
    btn.innerHTML = `
      <span>${esc(s.first_name)} ${esc(s.last_name)}</span>
      <span class="muted" style="font-size:11px;">${esc(meta)}</span>
    `;
    btn.addEventListener('click', () => addStudentMember(s.id));
    list.appendChild(btn);
  });
}

async function addStudentMember(studentId) {
  const { error } = await supabase.from('carpool_students').insert({
    carpool_id: editingId,
    student_id: studentId,
  });
  if (error) { dbError(error, 'Failed to add student to pickup tag'); return; }
  document.getElementById('ecpAddStudentPicker').hidden = true;
  await refreshMemberList();
}

/* ── Save / Delete ── */

async function saveEditCarpool() {
  if (!editingId) return;
  const tag   = document.getElementById('ecpTag').value.trim();
  const label = document.getElementById('ecpLabel').value.trim();
  if (!tag) { alert('Tag number is required.'); return; }

  const saveBtn = document.getElementById('ecpSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  // Only check when the number actually moves. A tag left as-is must stay
  // editable even if it predates this rule and already collides — otherwise
  // legacy collisions become unfixable, since renaming is how you resolve them.
  const conflict = tag === String(editingTagNumber ?? '')
    ? null
    : await findTagConflict(currentProfile.school_id, tag, { ignoreCarpoolId: editingId });
  if (conflict) {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Changes';
    showToast(`${conflict.message} Pick a different number.`, 'error', 8000);
    return;
  }

  const { error } = await supabase.from('carpools').update({
    tag_number: tag,
    label:      label || null,
    active:     document.getElementById('ecpActive').checked,
  }).eq('id', editingId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { dbError(error, 'Failed to save pickup tag'); return; }
  window.closeDrawer?.('editCarpoolDrawer');
  carpoolsDir.load();
}

function confirmDelete() {
  if (!editingId) return;
  const tag   = document.getElementById('ecpTag').value;
  const label = document.getElementById('ecpLabel').value;
  document.getElementById('deleteCarpoolMsg').textContent =
    `Are you sure you want to delete "${label || `Pickup tag #${tag}`}"? All family and student assignments will also be removed. This cannot be undone.`;
  document.getElementById('deleteCarpoolModal').hidden = false;
}

async function executeDelete() {
  if (!editingId) return;
  const { error } = await supabase.from('carpools').delete().eq('id', editingId);
  document.getElementById('deleteCarpoolModal').hidden = true;
  if (error) { dbError(error, 'Failed to delete carpool'); return; }
  window.closeDrawer?.('editCarpoolDrawer');
  editingId = null;
  carpoolsDir.load();
}

/* ===============================
   CREATE
================================ */

async function createCarpool() {
  const tag   = document.getElementById('carpoolTag')?.value.trim();
  const label = document.getElementById('carpoolLabel')?.value.trim();
  if (!tag) { alert('Pickup tag number is required.'); return; }

  const conflict = await findTagConflict(currentProfile.school_id, tag);
  if (conflict) {
    showToast(`${conflict.message} Pick a different number.`, 'error', 8000);
    return;
  }

  const { error } = await supabase.from('carpools').insert({
    school_id:  currentProfile.school_id,
    tag_number: tag,
    label:      label || null,
    active:     true,
  });

  if (error) { dbError(error, 'Failed to create pickup tag'); return; }

  document.getElementById('carpoolTag').value   = '';
  document.getElementById('carpoolLabel').value = '';

  window.closeDrawer?.('carpoolDrawer');
  carpoolsDir.load();
}

/* ===============================
   WIRE EVENTS
================================ */

function wireCarpoolEvents() {
  document.getElementById('addCarpool')?.addEventListener('click', createCarpool);

  const searchInput = document.getElementById('carpoolSearch');
  const sortSelect  = document.getElementById('carpoolSort');

  if (searchInput) {
    searchInput.addEventListener('input', debounce(e =>
      carpoolsDir.setSearch(e.target.value.trim()), 300));
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [col, dir] = e.target.value.split('.');
      carpoolsDir.setSort(col, dir === 'asc');
    });
  }

  // Edit drawer
  document.getElementById('ecpSaveBtn')?.addEventListener('click',      saveEditCarpool);
  document.getElementById('ecpCancelBtn')?.addEventListener('click',    () => window.closeDrawer?.('editCarpoolDrawer'));
  document.getElementById('ecpCloseBtn')?.addEventListener('click',     () => window.closeDrawer?.('editCarpoolDrawer'));
  document.getElementById('ecpDeleteBtn')?.addEventListener('click',    confirmDelete);
  document.getElementById('ecpAddFamilyBtn')?.addEventListener('click',  toggleAddFamilyPicker);
  document.getElementById('ecpAddStudentBtn')?.addEventListener('click', toggleAddStudentPicker);

  document.getElementById('ecpFamilySearch')?.addEventListener('input', e => {
    renderFamilyOptions(e.target.value);
  });

  document.getElementById('ecpStudentSearch')?.addEventListener('input', debounce(e => {
    renderStudentOptions(e.target.value);
  }, 300));

  // Delete modal
  document.getElementById('deleteCarpoolCancel')?.addEventListener('click',  () => { document.getElementById('deleteCarpoolModal').hidden = true; });
  document.getElementById('deleteCarpoolConfirm')?.addEventListener('click', executeDelete);
}

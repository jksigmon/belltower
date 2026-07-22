
import { supabase } from './admin.supabase.js';
import { createDirectory } from './admin.directory.js';
import { esc, getAvatarColor, debounce, loadSchoolConfig, dbError, showToast, GRADE_ORDER } from './admin.shared.js';

let currentProfile;
let schoolConfig = null;
let initialized = false;
let familiesDirectory;
let editingFamilyId = null;

/* ===============================
   ENTRY POINT
================================ */

export async function initFamiliesSection(profile) {
  currentProfile = profile;
  if (!schoolConfig) schoolConfig = await loadSchoolConfig(profile.school_id);

  const hasCarline = schoolConfig?.modules?.carline !== false;

  if (!familiesDirectory) {
    familiesDirectory = createDirectory({
      table: 'families',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        carline_tag_number,
        family_name,
        active,
        students ( first_name, last_name, grade_level, active )
      `,

      searchFields: hasCarline ? ['carline_tag_number', 'family_name'] : ['family_name'],

      defaultSort: hasCarline
        ? { column: 'carline_tag_sort', ascending: true }   // numeric: 23 < 233
        : { column: 'family_name', ascending: true },

      tbodySelector: '#familiesTable tbody',
      paginationContainer: '#familiesPagination',
      renderRow: renderFamilyRow,
      exportRow: exportFamilyRow
    });
  }

  if (!initialized) {
    wireFamilyEvents();
    initialized = true;
    familiesDirectory.load();
  }
}

/* ===============================
   EXPORT ROW
================================ */

// "Mia Perez (3), Leo Perez (K)" — active students, sorted by grade then name.
function formatFamilyStudents(students) {
  if (!Array.isArray(students) || !students.length) return '';
  const gradeRank = g => {
    const i = GRADE_ORDER.indexOf(g);
    return i === -1 ? 999 : i;   // unknown/blank grades sort last
  };
  return students
    .filter(s => s.active !== false)
    .sort((a, b) => {
      const diff = gradeRank(a.grade_level) - gradeRank(b.grade_level);
      if (diff !== 0) return diff;
      return `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`);
    })
    .map(s => {
      const name = `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim();
      return s.grade_level ? `${name} (${s.grade_level})` : name;
    })
    .join(', ');
}

function exportFamilyRow(f) {
  return {
    'Carline Tag/Family Number': f.carline_tag_number ?? '',
    'Family Name':               f.family_name ?? '',
    'Active':                    f.active ? 'TRUE' : 'FALSE',
    'Students':                  formatFamilyStudents(f.students),
  };
}

/* ===============================
   RENDER ROW
================================ */

function renderFamilyRow(f) {
  const initial = (f.family_name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(f.family_name ?? '');
  const inactive = f.active ? '' : '<span class="staff-inactive-badge">Inactive</span>';

  const tagBadge = f.carline_tag_number
    ? `<span class="carline-tag-badge">#${esc(f.carline_tag_number)}</span>`
    : '';

  const tr = document.createElement('tr');
  tr.className = 'dir-row-link';
  tr.innerHTML = `
    <td>
      <div class="staff-name-cell">
        <div class="staff-avatar" style="background:${color}">${initial}</div>
        <div class="staff-name-group">
          <span class="staff-fullname">${esc(f.family_name ?? '(Unnamed)')}</span>
          ${inactive}
        </div>
        ${tagBadge}
      </div>
    </td>
    <td class="staff-cell-chevron">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
    </td>
  `;

  tr.addEventListener('click', () => openEditFamilyDrawer(f));
  return tr;
}

/* ===============================
   EDIT DRAWER
================================ */

function openEditFamilyDrawer(f) {
  editingFamilyId = f.id;

  const initial = (f.family_name ?? '?')[0].toUpperCase();
  const color   = getAvatarColor(f.family_name ?? '');

  const avatar = document.getElementById('efAvatar');
  avatar.textContent      = initial;
  avatar.style.background = color;

  document.getElementById('efTitle').textContent    = f.family_name ?? '(Unnamed)';
  document.getElementById('efSubtitle').textContent = f.carline_tag_number ? `Tag #${f.carline_tag_number}` : '';

  document.getElementById('efTag').value    = f.carline_tag_number ?? '';
  document.getElementById('efName').value   = f.family_name ?? '';
  document.getElementById('efActive').checked = !!f.active;

  const saveBtn = document.getElementById('efSaveBtn');
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  // Reset lists to loading state before opening
  document.getElementById('efStudentsList').innerHTML  = '<span class="muted" style="font-size:13px;">Loading…</span>';
  document.getElementById('efGuardiansList').innerHTML = '<span class="muted" style="font-size:13px;">Loading…</span>';
  const searchEl = document.getElementById('efStudentSearch');
  const resultsEl = document.getElementById('efStudentResults');
  if (searchEl) searchEl.value = '';
  if (resultsEl) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }

  window.openDrawer?.('editFamilyDrawer');
  loadFamilyRelated(f.id);
}

async function loadFamilyRelated(familyId) {
  const [studentsRes, guardiansRes] = await Promise.all([
    // Intentionally NOT filtered on active — withdrawn students keep family_id
    // set, and staff need to see them here to notice a tag is still "occupied"
    // before reassigning it (see Release Tag action below).
    supabase
      .from('students')
      .select('id, first_name, last_name, grade_level, active')
      .eq('family_id', familyId)
      .order('last_name'),
    supabase
      .from('guardians')
      .select('id, first_name, last_name, phone, is_primary_contact')
      .eq('family_id', familyId)
      .eq('active', true)
      .order('last_name'),
  ]);

  const studentsList  = document.getElementById('efStudentsList');
  const guardiansList = document.getElementById('efGuardiansList');

  if (studentsRes.error || !studentsRes.data?.length) {
    studentsList.innerHTML = '<span class="muted" style="font-size:13px;">No students linked.</span>';
  } else {
    studentsList.innerHTML = studentsRes.data.map(s => `
      <div class="family-related-chip">
        <span class="family-chip-name">${esc(s.last_name)}, ${esc(s.first_name)}</span>
        ${s.grade_level ? `<span class="family-chip-meta">${esc(s.grade_level)}</span>` : ''}
        ${s.active === false ? '<span class="staff-inactive-badge">Withdrawn</span>' : ''}
      </div>
    `).join('');
  }

  if (guardiansRes.error || !guardiansRes.data?.length) {
    guardiansList.innerHTML = '<span class="muted" style="font-size:13px;">No active guardians.</span>';
  } else {
    guardiansList.innerHTML = guardiansRes.data.map(g => `
      <div class="family-related-chip">
        <span class="family-chip-name">
          ${g.is_primary_contact ? '<span class="family-primary-star" title="Primary contact">★</span>' : ''}
          ${esc(g.last_name)}, ${esc(g.first_name)}
        </span>
        ${g.phone ? `<span class="family-chip-meta">${esc(g.phone)}</span>` : ''}
      </div>
    `).join('');
  }
}

async function saveEditFamily() {
  if (!editingFamilyId) return;

  const tag  = document.getElementById('efTag').value.trim();
  const name = document.getElementById('efName').value.trim();
  const hasCarline = schoolConfig?.modules?.carline !== false;
  if (hasCarline && !tag) { alert('Carline tag number is required.'); return; }

  const updated = {
    carline_tag_number: tag,
    family_name:        name || null,
    active:             document.getElementById('efActive').checked,
  };

  const saveBtn = document.getElementById('efSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  const { error } = await supabase.from('families').update(updated).eq('id', editingFamilyId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { dbError(error, 'Failed to save family'); return; }
  window.closeDrawer?.('editFamilyDrawer');
  familiesDirectory.load();
}

/* ===============================
   RELEASE TAG & REASSIGN
================================ */

function confirmReleaseFamily() {
  if (!editingFamilyId) return;
  const tag  = document.getElementById('efTag').value.trim();
  const name = document.getElementById('efName').value.trim() || '(Unnamed)';
  document.getElementById('releaseFamilyMsg').textContent =
    `This unlinks every student currently on tag #${tag} (${name}), including inactive and withdrawn students. ` +
    `Afterward you can rename this family and link the new one to the same tag. Guardians are not affected: a ` +
    `guardian record must always belong to a family, so deactivate or reassign them separately if needed. This cannot be undone from here.`;
  document.getElementById('releaseFamilyModal').hidden = false;
}

async function executeReleaseFamily() {
  if (!editingFamilyId) return;

  const btn = document.getElementById('releaseFamilyConfirm');
  btn.disabled = true;
  btn.textContent = 'Unlinking…';

  const { error } = await supabase
    .from('students')
    .update({ family_id: null })
    .eq('family_id', editingFamilyId);

  btn.disabled = false;
  btn.textContent = 'Unlink Everyone';
  document.getElementById('releaseFamilyModal').hidden = true;

  if (error) { dbError(error, 'Failed to release tag'); return; }

  showToast('Tag released. Rename this family and link the new students below.', 'success');
  loadFamilyRelated(editingFamilyId);
  familiesDirectory.load();
}

/* ===============================
   LINK STUDENT (SEARCH)
================================ */

async function searchStudentsForFamily(term) {
  if (!term || term.length < 2) return [];
  const { data, error } = await supabase
    .from('students')
    .select('id, first_name, last_name, grade_level, active, family_id, families(carline_tag_number, family_name)')
    .eq('school_id', currentProfile.school_id)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`)
    .limit(8);

  if (error) { console.error('Student search failed', error); return []; }
  return (data || []).filter(s => s.family_id !== editingFamilyId);
}

function renderStudentSearchResults(matches) {
  const resultsEl = document.getElementById('efStudentResults');
  if (!resultsEl) return;

  if (!matches.length) {
    resultsEl.innerHTML = `<div class="ft-typeahead-empty">No students found.</div>`;
    resultsEl.style.display = 'block';
    return;
  }

  resultsEl.innerHTML = matches.map(s => {
    const name = `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim();
    const meta = [];
    if (s.grade_level) meta.push(esc(s.grade_level));
    if (s.active === false) meta.push('withdrawn');
    if (s.family_id && s.families) {
      meta.push(`currently #${esc(s.families.carline_tag_number)} ${esc(s.families.family_name ?? '')}`.trim());
    }
    return `<div class="ft-typeahead-item" data-id="${esc(s.id)}"><strong>${esc(name)}</strong>${meta.length ? `<span>${meta.join(' · ')}</span>` : ''}</div>`;
  }).join('');

  resultsEl.querySelectorAll('.ft-typeahead-item').forEach(item => {
    item.addEventListener('mousedown', () => linkStudentToFamily(item.dataset.id));
  });
  resultsEl.style.display = 'block';
}

async function onEfStudentSearchInput(e) {
  const term = e.target.value.trim();
  const resultsEl = document.getElementById('efStudentResults');
  if (!term) { if (resultsEl) resultsEl.style.display = 'none'; return; }
  renderStudentSearchResults(await searchStudentsForFamily(term));
}

async function linkStudentToFamily(studentId) {
  if (!editingFamilyId) return;
  const { error } = await supabase.from('students').update({ family_id: editingFamilyId }).eq('id', studentId);
  if (error) { dbError(error, 'Failed to link student'); return; }

  const searchEl = document.getElementById('efStudentSearch');
  const resultsEl = document.getElementById('efStudentResults');
  if (searchEl) searchEl.value = '';
  if (resultsEl) { resultsEl.innerHTML = ''; resultsEl.style.display = 'none'; }

  showToast('Student linked.', 'success');
  loadFamilyRelated(editingFamilyId);
  familiesDirectory.load();
}

function confirmDeleteFamily() {
  if (!editingFamilyId) return;
  const name = document.getElementById('efName').value || '(Unnamed)';
  document.getElementById('deleteFamilyMsg').textContent =
    `Are you sure you want to delete ${name}? This cannot be undone.`;
  document.getElementById('deleteFamilyModal').hidden = false;
}

async function executeDeleteFamily() {
  if (!editingFamilyId) return;
  const { error } = await supabase.from('families').delete().eq('id', editingFamilyId);
  document.getElementById('deleteFamilyModal').hidden = true;
  if (error) { dbError(error, 'Failed to delete family'); return; }
  window.closeDrawer?.('editFamilyDrawer');
  editingFamilyId = null;
  familiesDirectory.load();
}

/* ===============================
   CREATE
================================ */

async function createFamily() {
  const tag  = document.getElementById('familyTag')?.value.trim();
  const name = document.getElementById('familyName')?.value.trim();

  const hasCarline = schoolConfig?.modules?.carline !== false;
  if (hasCarline && !tag) { alert('Carline tag number is required.'); return; }

  const { error } = await supabase.from('families').insert({
    school_id:          currentProfile.school_id,
    carline_tag_number: tag,
    family_name:        name || null,
    active:             true
  });

  if (error) { dbError(error, 'Failed to add family'); return; }

  document.getElementById('familyTag').value  = '';
  document.getElementById('familyName').value = '';

  window.closeDrawer?.('familyDrawer');
  familiesDirectory.load();
}

/* ===============================
   EVENTS
================================ */

function wireFamilyEvents() {
  document.getElementById('addFamily')?.addEventListener('click', createFamily);

  const searchInput = document.getElementById('familySearch');
  const sortSelect  = document.getElementById('familySort');

  if (searchInput) {
    searchInput.addEventListener('input', debounce(e =>
      familiesDirectory.setSearch(e.target.value.trim()), 300));
  }
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      const [column, dir] = e.target.value.split('.');
      familiesDirectory.setSort(column, dir === 'asc');
    });
  }

  document.getElementById('exportFamiliesCurrent')?.addEventListener('click', () => familiesDirectory.exportFiltered());
  document.getElementById('exportFamiliesAll')?.addEventListener('click',     () => familiesDirectory.exportAll());

  // Edit drawer
  document.getElementById('efSaveBtn')?.addEventListener('click',   saveEditFamily);
  document.getElementById('efCancelBtn')?.addEventListener('click', () => window.closeDrawer?.('editFamilyDrawer'));
  document.getElementById('efCloseBtn')?.addEventListener('click',  () => window.closeDrawer?.('editFamilyDrawer'));
  document.getElementById('efDeleteBtn')?.addEventListener('click', confirmDeleteFamily);

  // Delete modal
  document.getElementById('deleteFamilyCancel')?.addEventListener('click',  () => { document.getElementById('deleteFamilyModal').hidden = true; });
  document.getElementById('deleteFamilyConfirm')?.addEventListener('click', executeDeleteFamily);

  // Release tag & reassign
  document.getElementById('efReleaseBtn')?.addEventListener('click', confirmReleaseFamily);
  document.getElementById('releaseFamilyCancel')?.addEventListener('click',  () => { document.getElementById('releaseFamilyModal').hidden = true; });
  document.getElementById('releaseFamilyConfirm')?.addEventListener('click', executeReleaseFamily);

  // Link student search
  document.getElementById('efStudentSearch')?.addEventListener('input', debounce(onEfStudentSearchInput, 250));
  document.getElementById('efStudentSearch')?.addEventListener('blur', () => {
    setTimeout(() => { const r = document.getElementById('efStudentResults'); if (r) r.style.display = 'none'; }, 150);
  });
}

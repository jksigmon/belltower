
import { supabase } from './admin.supabase.js?v=2';
import { createDirectory } from './admin.directory.js?v=2';
import { esc, getAvatarColor, debounce, loadSchoolConfig, dbError, showToast, GRADE_ORDER, invalidateFamilyCache, findTagConflict } from './admin.shared.js?v=3';
import { openAvailableTagsModal } from './admin.tag-availability.js?v=1';

let currentProfile;
let schoolConfig = null;
let initialized = false;
let familiesDirectory;
let editingFamilyId = null;
let editingFamilyTag = null; // tag as loaded, so an unchanged tag skips the conflict check

/* ===============================
   SPECIAL-PERMISSION FLAGS
================================ */

// Single source of truth for the family special-permission flags. Everything
// flag-shaped reads from here: the directory's Flags column badges, the edit
// drawer's checkboxes, the export columns, and the Flags filter dropdown.
// Adding a flag later is a migration for the boolean column plus one entry
// here — no other file changes, and the new flag is filterable immediately.
//
// `noteColumn` is optional and gives a flag a free-text detail field, which
// is also folded into the directory search so a specific one-off case can be
// found by typing its note text.
export const FAMILY_FLAGS = [
  { column: 'skip_car_line', label: 'Skip Car Line', inputId: 'efSkipCarLine', badgeClass: 'fam-flag-carline' },
  { column: 'ec_needs',      label: 'EC Needs',      inputId: 'efEcNeeds',     badgeClass: 'fam-flag-ec' },
  {
    column: 'other_flag', label: 'Other', inputId: 'efOther', badgeClass: 'fam-flag-other',
    noteColumn: 'other_flag_note', noteInputId: 'efOtherNote',
  },
];

const FLAG_NOTE_COLUMNS = FAMILY_FLAGS.map(f => f.noteColumn).filter(Boolean);

// Aggregate dropdown options that aren't a single column. Prefixed so they
// can never collide with a real column name added to the registry later.
const FLAG_FILTER_ANY  = '__any';
const FLAG_FILTER_NONE = '__none';

// '' = no flag filter. Otherwise one of the two aggregates above, or a
// column name from FAMILY_FLAGS.
let flagFilter = '';

function canManageFamilies() {
  return currentProfile.is_superadmin || currentProfile.role === 'admin' || currentProfile.can_manage_families === true;
}

// IDs of families with no active students (including families with no
// students at all) — powers the "Releasable only" filter. Computed as a set
// difference (all family ids minus ids with an active student) rather than
// sent to Postgres as a "not in (...)" exclusion: most families DO have an
// active student, so that list is large and turned into a huge query-string
// that made the request hang. The releasable set is normally the minority,
// so filtering with a plain "in (...)" on it is both correct and fast.
// Refetched whenever the filter is toggled on or the directory reloads while
// the filter is active, since staff actions (withdrawing/linking a student)
// change membership.
let releasableFilterOn = false;
let releasableFamilyIds = [];

const RELEASABLE_BATCH_SIZE = 1000;

// PostgREST caps unranged selects at 1000 rows, so both queries below must
// page through with .range() — otherwise schools with >1000 families or
// >1000 active students silently lose rows off the end, and families whose
// active student fell past the cap get misclassified as releasable.
async function fetchAllIds(builder) {
  const ids = [];
  let from = 0;
  while (true) {
    const { data, error } = await builder().range(from, from + RELEASABLE_BATCH_SIZE - 1);
    if (error) return { error };
    ids.push(...data);
    if (data.length < RELEASABLE_BATCH_SIZE) break;
    from += RELEASABLE_BATCH_SIZE;
  }
  return { data: ids };
}

async function fetchReleasableFamilyIds() {
  const [familiesRes, activeStudentsRes] = await Promise.all([
    fetchAllIds(() => supabase.from('families').select('id').eq('school_id', currentProfile.school_id)),
    fetchAllIds(() => supabase.from('students').select('family_id')
      .eq('school_id', currentProfile.school_id)
      .eq('active', true)
      .not('family_id', 'is', null))
  ]);

  if (familiesRes.error || activeStudentsRes.error) {
    console.error('Failed to load releasable family ids', familiesRes.error || activeStudentsRes.error);
    releasableFamilyIds = [];
    return;
  }

  const activeIds = new Set((activeStudentsRes.data || []).map(r => r.family_id));
  releasableFamilyIds = (familiesRes.data || []).map(f => f.id).filter(id => !activeIds.has(id));
}

// Restricts the directory to a single flag, to families carrying at least
// one flag, or to families carrying none. The "any" case uses .or() while
// the directory may separately .or() the search term — PostgREST ANDs
// repeated or= params, so the two compose correctly (same pattern as the
// compliance directory's credential filter).
function applyFlagFilter(query) {
  if (!flagFilter) return query;

  if (flagFilter === FLAG_FILTER_ANY) {
    return query.or(FAMILY_FLAGS.map(f => `${f.column}.is.true`).join(','));
  }
  if (flagFilter === FLAG_FILTER_NONE) {
    FAMILY_FLAGS.forEach(f => { query = query.eq(f.column, false); });
    return query;
  }

  // Match against the registry rather than trusting the select value, so
  // only known columns ever reach the query.
  const flag = FAMILY_FLAGS.find(f => f.column === flagFilter);
  return flag ? query.eq(flag.column, true) : query;
}

function populateFlagFilterOptions() {
  const sel = document.getElementById('familyFlagFilter');
  if (!sel || sel.dataset.populated) return;

  sel.innerHTML = [
    '<option value="">All flags</option>',
    `<option value="${FLAG_FILTER_ANY}">Any special permission</option>`,
    `<option value="${FLAG_FILTER_NONE}">No special permissions</option>`,
    ...FAMILY_FLAGS.map(f => `<option value="${esc(f.column)}">${esc(f.label)}</option>`),
  ].join('');
  sel.dataset.populated = '1';
}

// The drawer's Special Permissions checkboxes are built from the registry
// too, so a new flag doesn't need a matching block hand-added to admin.html.
function renderFlagInputs() {
  const wrap = document.getElementById('efFlagsList');
  if (!wrap || wrap.dataset.rendered) return;

  wrap.innerHTML = FAMILY_FLAGS.map(f => `
    <label class="staff-active-label">
      <input type="checkbox" id="${esc(f.inputId)}" />
      <span>${esc(f.label)}</span>
    </label>
    ${f.noteColumn ? `<input id="${esc(f.noteInputId)}" class="form-input" placeholder="${esc(f.notePlaceholder ?? `Details for "${f.label}" (optional)`)}" style="margin-top:6px;" />` : ''}
  `).join('');
  wrap.dataset.rendered = '1';
}

// Central reload used everywhere the directory refreshes, so the releasable
// filter's underlying id set stays in sync with the latest student edits.
async function reloadFamilies() {
  if (releasableFilterOn) await fetchReleasableFamilyIds();
  familiesDirectory.load();
}

/* ===============================
   ENTRY POINT
================================ */

export async function initFamiliesSection(profile) {
  currentProfile = profile;
  if (!schoolConfig) schoolConfig = await loadSchoolConfig(profile.school_id);

  const hasCarline = schoolConfig?.modules?.carline !== false;

  const addBtn = document.getElementById('addFamilyBtn');
  if (addBtn) addBtn.style.display = canManageFamilies() ? '' : 'none';

  populateFlagFilterOptions();
  renderFlagInputs();

  if (!familiesDirectory) {
    familiesDirectory = createDirectory({
      table: 'families',
      schoolId: () => currentProfile.school_id,

      select: `
        id,
        carline_tag_number,
        family_name,
        active,
        ${FAMILY_FLAGS.flatMap(f => [f.column, f.noteColumn]).filter(Boolean).join(',\n        ')},
        students ( first_name, last_name, grade_level, active ),
        guardians ( active )
      `,

      // Flag notes are searchable so a one-off case recorded under a
      // free-text flag ("wheelchair van", "court order") is findable by
      // typing it, not just by filtering down to the flag itself.
      searchFields: [
        ...(hasCarline ? ['carline_tag_number', 'family_name'] : ['family_name']),
        ...FLAG_NOTE_COLUMNS,
      ],

      // Neither filter here is a plain column comparison — "Releasable only"
      // restricts to the precomputed id set above, and the flag filter has
      // aggregate ("any"/"none") modes. Both are handled here rather than via
      // the generic `filters` config, which only supports single-arg
      // comparisons.
      augmentQuery(query, _search, { all } = {}) {
        // "Export all" means every family, so neither filter applies there.
        if (all) return { query };

        if (releasableFilterOn) {
          // Empty set legitimately means "no releasable families" — filter
          // on an id that can't exist rather than skipping the filter
          // (skipping would show the unfiltered list instead of zero rows).
          query = query.in('id', releasableFamilyIds.length ? releasableFamilyIds : ['00000000-0000-0000-0000-000000000000']);
        }
        query = applyFlagFilter(query);
        return { query };
      },

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
  } else {
    // Revisiting the tab: the releasable snapshot can be stale if a
    // student's active status or family link changed elsewhere (e.g. the
    // Students tab) since it was last computed, since nothing outside this
    // module invalidates it. Re-verify against current data on every visit.
    reloadFamilies();
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
  const row = {
    'Carline Tag/Family Number': f.carline_tag_number ?? '',
    'Family Name':               f.family_name ?? '',
    'Active':                    f.active ? 'TRUE' : 'FALSE',
  };

  FAMILY_FLAGS.forEach(flag => {
    row[flag.label] = f[flag.column] ? 'TRUE' : 'FALSE';
    if (flag.noteColumn) row[`${flag.label} Note`] = f[flag.noteColumn] ?? '';
  });

  row['Students'] = formatFamilyStudents(f.students);
  return row;
}

/* ===============================
   RENDER ROW
================================ */

// A family with no linked students or guardians is usually a sign of an
// incomplete/orphaned record (created but never populated, or everyone on
// it withdrew and no one relinked) — flagged distinctly rather than shown
// as a silent "0", so it's visible without opening the row. Rendered as
// their own table columns (not packed inline after the name) so the
// badges line up in a straight column down the page instead of drifting
// left/right with each row's name length.
function studentCountBadge(f) {
  const total = (f.students ?? []).length;
  const activeStudents = (f.students ?? []).filter(s => s.active !== false).length;
  if (activeStudents === 0) {
    return total === 0
      ? '<span class="fam-risk-badge">No students linked</span>'
      : `<span class="fam-risk-badge">0 active (${total} withdrawn)</span>`;
  }
  return `<span class="fam-count-badge">${activeStudents} student${activeStudents === 1 ? '' : 's'}</span>`;
}

function guardianCountBadge(f) {
  const activeGuardians = (f.guardians ?? []).filter(g => g.active !== false).length;
  return activeGuardians === 0
    ? '<span class="fam-risk-badge">No guardians linked</span>'
    : `<span class="fam-count-badge">${activeGuardians} guardian${activeGuardians === 1 ? '' : 's'}</span>`;
}

function specialFlagsBadges(f) {
  return FAMILY_FLAGS
    .filter(flag => f[flag.column])
    .map(flag => {
      // A flag registered without its own badge class falls back to the
      // neutral grey "other" styling rather than rendering unstyled.
      const cls  = flag.badgeClass || 'fam-flag-other';
      const note = flag.noteColumn ? f[flag.noteColumn] : null;
      return `<span class="fam-flag-badge ${cls}"${note ? ` title="${esc(note)}"` : ''}>${esc(flag.label)}</span>`;
    })
    .join('');
}

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
      </div>
    </td>
    <td>${tagBadge}</td>
    <td><div class="fam-flags-cell">${specialFlagsBadges(f)}</div></td>
    <td>${studentCountBadge(f)}</td>
    <td>${guardianCountBadge(f)}</td>
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
  editingFamilyId  = f.id;
  editingFamilyTag = f.carline_tag_number ?? '';

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

  FAMILY_FLAGS.forEach(flag => {
    const cb = document.getElementById(flag.inputId);
    if (cb) cb.checked = !!f[flag.column];
    if (flag.noteColumn) {
      const note = document.getElementById(flag.noteInputId);
      if (note) note.value = f[flag.noteColumn] ?? '';
    }
  });

  const canManage = canManageFamilies();
  const flagInputIds = FAMILY_FLAGS.flatMap(flag => [flag.inputId, flag.noteInputId]).filter(Boolean);
  ['efTag', 'efName', 'efActive', ...flagInputIds, 'efStudentSearch']
    .forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !canManage; });

  const saveBtn = document.getElementById('efSaveBtn');
  saveBtn.style.display = canManage ? '' : 'none';
  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  const deleteBtn = document.getElementById('efDeleteBtn');
  if (deleteBtn) deleteBtn.style.display = canManage ? '' : 'none';
  const releaseSection = document.getElementById('efReleaseSection');
  if (releaseSection) releaseSection.style.display = canManage ? '' : 'none';
  const studentSearchWrap = document.getElementById('efStudentSearchWrap');
  if (studentSearchWrap) studentSearchWrap.style.display = canManage ? '' : 'none';

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

  FAMILY_FLAGS.forEach(flag => {
    updated[flag.column] = document.getElementById(flag.inputId)?.checked === true;
    if (flag.noteColumn) {
      updated[flag.noteColumn] = document.getElementById(flag.noteInputId)?.value.trim() || null;
    }
  });

  const saveBtn = document.getElementById('efSaveBtn');
  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';

  // Only check when the number actually moves — see the matching note in
  // admin.carpools.js. Leaves pre-existing collisions editable so they can be fixed.
  const conflict = tag === String(editingFamilyTag ?? '')
    ? null
    : await findTagConflict(currentProfile.school_id, tag, { ignoreFamilyId: editingFamilyId });
  if (conflict) {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Changes';
    showToast(`${conflict.message} Pick a different number.`, 'error', 8000);
    return;
  }

  const { error } = await supabase.from('families').update(updated).eq('id', editingFamilyId);

  saveBtn.disabled    = false;
  saveBtn.textContent = 'Save Changes';

  if (error) { dbError(error, 'Failed to save family'); return; }
  invalidateFamilyCache(currentProfile.school_id);
  window.closeDrawer?.('editFamilyDrawer');
  reloadFamilies();
}

/* ===============================
   RELEASE TAG & REASSIGN
================================ */

function confirmReleaseFamily() {
  if (!editingFamilyId) return;
  const tag  = document.getElementById('efTag').value.trim();
  const name = document.getElementById('efName').value.trim() || '(Unnamed)';
  document.getElementById('releaseFamilyMsg').textContent =
    `This unlinks every student currently on tag #${tag} (${name}), including inactive and withdrawn students, ` +
    `and permanently removes every guardian on this family (a guardian record must always belong to a family, so ` +
    `it can't just be unlinked like a student). Afterward you can rename this family and link the new students and ` +
    `guardians to the same tag. This cannot be undone from here.\n\n` +
    `Note: #${tag} stays claimed as a family number — releasing empties the family but does not free the number. ` +
    `If you want to use #${tag} for a pickup tag instead, delete this family rather than releasing it.`;
  document.getElementById('releaseFamilyModal').hidden = false;
}

async function executeReleaseFamily() {
  if (!editingFamilyId) return;

  const btn = document.getElementById('releaseFamilyConfirm');
  btn.disabled = true;
  btn.textContent = 'Unlinking…';

  const [studentsRes, guardiansRes] = await Promise.all([
    supabase.from('students').update({ family_id: null }).eq('family_id', editingFamilyId),
    // Guardians can't be unlinked like students (family_id is NOT NULL), and
    // nothing else references guardians.id, so a full delete is the correct
    // equivalent of "release" here rather than a soft deactivate — a
    // deactivated guardian would otherwise sit invisibly on the reused tag
    // under the new family's name.
    supabase.from('guardians').delete().eq('family_id', editingFamilyId),
  ]);

  btn.disabled = false;
  btn.textContent = 'Unlink Everyone';
  document.getElementById('releaseFamilyModal').hidden = true;

  const error = studentsRes.error || guardiansRes.error;
  if (error) { dbError(error, 'Failed to release tag'); return; }

  showToast('Tag released. Rename this family and link the new students and guardians below.', 'success');
  loadFamilyRelated(editingFamilyId);
  reloadFamilies();
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
  reloadFamilies();
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
  invalidateFamilyCache(currentProfile.school_id);
  window.closeDrawer?.('editFamilyDrawer');
  editingFamilyId = null;
  reloadFamilies();
}

/* ===============================
   CREATE
================================ */

async function createFamily() {
  const tag  = document.getElementById('familyTag')?.value.trim();
  const name = document.getElementById('familyName')?.value.trim();

  const hasCarline = schoolConfig?.modules?.carline !== false;
  if (hasCarline && !tag) { alert('Carline tag number is required.'); return; }

  const conflict = await findTagConflict(currentProfile.school_id, tag);
  if (conflict) {
    showToast(`${conflict.message} Pick a different number.`, 'error', 8000);
    return;
  }

  const { data, error } = await supabase.from('families').insert({
    school_id:          currentProfile.school_id,
    carline_tag_number: tag,
    family_name:        name || null,
    active:             true
  }).select().single();

  if (error) { dbError(error, 'Failed to add family'); return; }
  invalidateFamilyCache(currentProfile.school_id);

  document.getElementById('familyTag').value  = '';
  document.getElementById('familyName').value = '';

  window.closeDrawer?.('familyDrawer');
  familiesDirectory.load();

  // Hand off straight into the edit drawer so the admin can search and link
  // students to this family immediately, without a second trip back in.
  openEditFamilyDrawer(data);
}

/* ===============================
   EVENTS
================================ */

function wireFamilyEvents() {
  document.getElementById('addFamily')?.addEventListener('click', createFamily);
  document.getElementById('familyAvailableTags')?.addEventListener('click', () => openAvailableTagsModal(currentProfile));

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

  const flagSelect = document.getElementById('familyFlagFilter');
  if (flagSelect) {
    flagSelect.addEventListener('change', e => {
      flagFilter = e.target.value;
      familiesDirectory.resetPage();
      familiesDirectory.load();
    });
  }

  const releasableCheckbox = document.getElementById('familyReleasableOnly');
  if (releasableCheckbox) {
    releasableCheckbox.addEventListener('change', async e => {
      releasableFilterOn = e.target.checked;
      familiesDirectory.resetPage();
      await reloadFamilies();
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

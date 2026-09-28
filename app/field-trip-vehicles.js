import { supabase } from './admin.supabase.js?v=2';
import { initPage } from './admin.auth.js?v=2';
import { esc } from './admin.shared.js?v=4';

const GRADE_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444',
  '#8b5cf6','#06b6d4','#f97316','#ec4899',
  '#14b8a6','#a855f7',
];

const GROUP_VIEW_KEY = 'vehGroupByLabel';
const NO_HOMEROOM_KEY = '__none__';

const SAVE_ICONS = {
  saving: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  saved:  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  error:  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg>',
};

let profile      = null;
let tripId       = null;
let trip         = null;
let drivers      = [];   // field_trip_chaperones rows (is_driver=true) with guardian
let students     = [];   // attending students
let assignments  = new Map(); // student_id → chaperone_id | null
let assignmentIds = new Map(); // student_id → assignment row id
let capacities   = new Map(); // chaperone_id → vehicle_capacity int
let groupLabels  = new Map(); // chaperone_id → car_group_label string
let groupByLabel = localStorage.getItem(GROUP_VIEW_KEY) === '1'; // view preference (grouped vs. flat grid)
let gradeColors  = new Map(); // grade_level → color hex
let dirty        = new Set();
let saveTimer    = null;
let selected     = new Set();  // student ids selected for click-to-move
let undoStack    = [];         // array of [{ studentId, fromChaperoneId }, ...] groups
let searchTerm   = '';         // toolbar search — applies board-wide
let unassignedSearchTerm = ''; // sidebar-local search — Unassigned list only
let unassignedHomeroomFilter = ''; // '' = all, NO_HOMEROOM_KEY, or a homeroom_teacher_id

// ── Init ──────────────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  tripId = params.get('trip');
  if (!tripId) {
    document.getElementById('vehBoard').innerHTML =
      '<div style="padding:60px;color:#dc2626;font-size:14px;">No trip specified.</div>';
    return;
  }

  profile = await initPage();
  if (!profile) return;

  // Load trip first so grade_levels are available for the student query
  const { data: tripData, error: tripErr } = await supabase
    .from('field_trips').select('*').eq('id', tripId).eq('school_id', profile.school_id).single();

  if (tripErr || !tripData) {
    document.getElementById('vehBoard').innerHTML =
      '<div style="padding:60px;color:#dc2626;font-size:14px;">Trip not found or access denied.</div>';
    return;
  }

  trip = tripData;
  document.getElementById('vehTripName').textContent = trip.name;
  document.title = `Vehicles – ${trip.name}`;

  const dateEl = document.getElementById('vehTripDate');
  if (dateEl && trip.start_date) {
    dateEl.textContent = new Date(trip.start_date + 'T12:00:00').toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
    dateEl.hidden = false;
  }

  if (!(trip.grade_levels ?? []).length) {
    document.getElementById('vehBoard').innerHTML =
      '<div style="padding:60px 40px;color:#b45309;font-size:14px;max-width:480px;margin:0 auto;text-align:center;">No grade levels set on this trip — edit the trip to specify grades before planning vehicles.</div>';
    return;
  }

  const [driversRes, studList, assignRes] = await Promise.all([
    supabase.from('field_trip_chaperones')
      .select('id, vehicle_capacity, car_group_label, guardian:guardians(first_name, last_name), employee:employees(first_name, last_name), volunteer:compliance_volunteers(first_name, last_name)')
      .eq('field_trip_id', tripId)
      .eq('is_driver', true)
      .is('removed_at', null)
      .order('id'),
    loadAttendingStudents(),
    supabase.from('field_trip_vehicle_assignments')
      .select('id, student_id, chaperone_id')
      .eq('field_trip_id', tripId),
  ]);

  drivers  = driversRes.data ?? [];
  students = studList;

  drivers.forEach(d => {
    if (d.vehicle_capacity != null) capacities.set(d.id, d.vehicle_capacity);
    if (d.car_group_label) groupLabels.set(d.id, d.car_group_label);
  });

  (assignRes.data ?? []).forEach(r => {
    assignments.set(r.student_id, r.chaperone_id);
    assignmentIds.set(r.student_id, r.id);
  });

  gradeColors = buildGradeColorMap(students);

  buildBoard();
  wireActions();

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      document.getElementById('vehSearch')?.focus();
      return;
    }
    if (e.key === 'Escape' && selected.size) clearSelection();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoLastMove();
    }
  });
  document.addEventListener('click', e => {
    if (selected.size && !e.target.closest('#vehBoard')) clearSelection();
  });
}

// ── Data helpers ──────────────────────────────────────────────────────────

async function loadAttendingStudents() {
  const grades = trip.grade_levels ?? [];
  let q = supabase.from('students')
    .select('id, first_name, last_name, grade_level, homeroom_teacher_id, employees!left(first_name, last_name)')
    .eq('school_id', profile.school_id)
    .eq('active', true)
    .order('last_name');
  if (grades.length) q = q.in('grade_level', grades);

  const [{ data: allS }, { data: excl }] = await Promise.all([
    q,
    supabase.from('field_trip_students')
      .select('student_id')
      .eq('field_trip_id', tripId)
      .eq('attending', false),
  ]);

  const exclSet = new Set((excl ?? []).map(r => r.student_id));
  return (allS ?? []).filter(s => !exclSet.has(s.id));
}

function buildGradeColorMap(studs) {
  const grades = [...new Set(studs.map(s => s.grade_level).filter(Boolean))].sort();
  const map = new Map();
  grades.forEach((g, i) => map.set(g, GRADE_COLORS[i % GRADE_COLORS.length]));
  return map;
}

function getInitials(first, last) {
  return (`${(first || '').charAt(0)}${(last || '').charAt(0)}`.toUpperCase()) || '?';
}

// ── Board ─────────────────────────────────────────────────────────────────

function buildBoard() {
  const board = document.getElementById('vehBoard');
  board.innerHTML = '';

  if (!drivers.length) {
    board.innerHTML = `
      <div style="padding:60px 40px;color:#9ca3af;font-size:14px;text-align:center;width:100%;max-width:480px;margin:0 auto;">
        <div style="font-size:32px;margin-bottom:12px;">🚗</div>
        No drivers found for this trip. Mark a chaperone as a driver on the Field Trips page, then return here.
      </div>`;
    return;
  }

  // Unassigned pool — pinned sidebar, can run long
  board.appendChild(buildUnassignedPanel());

  // Vehicle grid — each vehicle only holds a handful of students, so wrapping
  // into a grid uses screen space far better than one tall column per driver
  const section = document.createElement('div');
  section.className = 'veh-vehicle-section';
  section.innerHTML = `
    <div class="veh-vehicle-section-header">
      <div class="veh-vehicle-section-title">Chaperones</div>
      <div class="veh-vehicle-section-stats" id="vehStats"></div>
    </div>
    <div class="veh-vehicle-grid" id="vehVehicleGrid"></div>
  `;
  board.appendChild(section);
  const grid = section.querySelector('#vehVehicleGrid');

  const appendDriverColumn = driver => {
    const name     = driverName(driver);
    const assigned = students.filter(s => assignments.get(s.id) === driver.id);
    grid.appendChild(buildColumn(driver, name, assigned));
  };

  if (groupByLabel) {
    groupDrivers(drivers).forEach(({ label, drivers: bucketDrivers }) => {
      const header = document.createElement('div');
      header.className = 'veh-group-section-header';
      header.textContent = label ?? 'Ungrouped';
      grid.appendChild(header);
      bucketDrivers.forEach(appendDriverColumn);
    });
  } else {
    drivers.forEach(appendDriverColumn);
  }

  updateGroupToggleVisibility();
  applySearchFilter();
  updateSelectionUI();
  setSaveStatus('saved');
}

function driverName(driver) {
  const person = driver.guardian ?? driver.employee ?? driver.volunteer;
  return `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim() || 'Driver';
}

// ── Unassigned sidebar ───────────────────────────────────────────────────

function buildUnassignedPanel() {
  const wrap = document.createElement('div');
  wrap.className = 'veh-unassigned-wrap';
  wrap.dataset.chaperoneId = 'unassigned';
  wrap.innerHTML = `
    <div class="veh-unassigned-header">
      <div class="veh-unassigned-title">Unassigned Students</div>
      <div class="veh-unassigned-count" id="vehUnassignedCount"></div>
    </div>
    <div class="veh-unassigned-search-wrap">
      <input type="search" id="vehUnassignedSearch" class="veh-search" placeholder="Search students…">
    </div>
    ${homeroomFilterHtml()}
    <div class="veh-unassigned-list" id="veh-cards-unassigned"></div>
    <div class="veh-unassigned-footer" id="vehUnassignedFooter"></div>
  `;

  renderUnassignedList();

  const searchInput = wrap.querySelector('#vehUnassignedSearch');
  searchInput.value = unassignedSearchTerm;
  searchInput.addEventListener('input', e => {
    unassignedSearchTerm = e.target.value.trim().toLowerCase();
    applySearchFilter();
  });

  const homeroomSelect = wrap.querySelector('#vehUnassignedHomeroomFilter');
  if (homeroomSelect) {
    homeroomSelect.value = unassignedHomeroomFilter;
    homeroomSelect.addEventListener('change', e => {
      unassignedHomeroomFilter = e.target.value;
      renderUnassignedList();
      applySearchFilter();
    });
  }

  const list = wrap.querySelector('#veh-cards-unassigned');
  list.addEventListener('dragover', e => {
    e.preventDefault();
    list.classList.add('drag-over');
  });
  list.addEventListener('dragleave', () => list.classList.remove('drag-over'));
  list.addEventListener('drop', e => {
    e.preventDefault();
    list.classList.remove('drag-over');
    const ids = e.dataTransfer.getData('text/plain').split(',').filter(Boolean);
    moveStudents(ids, null);
  });

  wrap.addEventListener('click', e => {
    if (e.target.closest('#vehUnassignedSearch') || e.target.closest('#vehUnassignedHomeroomFilter')) return;
    if (!selected.size) return;
    moveStudents([...selected], null);
  });

  return wrap;
}

// Options built from every attending student on the trip (not just the
// currently-unassigned ones) so the dropdown stays stable as students get
// assigned, instead of options disappearing mid-session.
function homeroomFilterHtml() {
  const { homerooms, hasNoHomeroom } = getUnassignedHomeroomOptions();
  if (!homerooms.length) return ''; // trip/school doesn't track homerooms -- omit the control entirely
  let opts = '<option value="">All homerooms</option>' +
    homerooms.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join('');
  if (hasNoHomeroom) opts += `<option value="${NO_HOMEROOM_KEY}">No homeroom</option>`;
  return `<div class="veh-unassigned-filter-wrap">
    <select id="vehUnassignedHomeroomFilter" class="veh-search">${opts}</select>
  </div>`;
}

function getUnassignedHomeroomOptions() {
  const map = new Map();
  let hasNoHomeroom = false;
  students.forEach(s => {
    if (s.homeroom_teacher_id && s.employees) {
      map.set(s.homeroom_teacher_id, `${s.employees.first_name} ${s.employees.last_name}`);
    } else {
      hasNoHomeroom = true;
    }
  });
  const homerooms = [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  return { homerooms, hasNoHomeroom };
}

// Rebuilds just the card list inside the Unassigned panel from current
// assignments/filter state. Called on init, whenever the homeroom filter
// changes, and whenever a move/undo changes Unassigned membership -- cheap
// enough for a class-sized roster and avoids fragile DOM-patching once
// cards need to land under the right homeroom group.
function renderUnassignedList() {
  const list = document.getElementById('veh-cards-unassigned');
  if (!list) return;
  list.innerHTML = '';

  const unassigned = students.filter(s => !assignments.get(s.id));

  let visible = unassigned;
  if (unassignedHomeroomFilter === NO_HOMEROOM_KEY) {
    visible = unassigned.filter(s => !s.homeroom_teacher_id);
  } else if (unassignedHomeroomFilter) {
    visible = unassigned.filter(s => s.homeroom_teacher_id === unassignedHomeroomFilter);
  }

  // A specific homeroom is already selected -- one group, no headers needed.
  if (unassignedHomeroomFilter) {
    visible.forEach(s => list.appendChild(buildCard(s)));
    return;
  }

  const buckets = new Map(); // homeroom_teacher_id → { label, students }
  const noHomeroom = [];
  visible.forEach(s => {
    if (!s.homeroom_teacher_id || !s.employees) { noHomeroom.push(s); return; }
    if (!buckets.has(s.homeroom_teacher_id)) {
      buckets.set(s.homeroom_teacher_id, { label: `${s.employees.first_name} ${s.employees.last_name}`, students: [] });
    }
    buckets.get(s.homeroom_teacher_id).students.push(s);
  });

  const groups = [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (noHomeroom.length) groups.push({ label: null, students: noHomeroom });

  // Nothing meaningful to group by (no homeroom data, or everyone shares
  // one) -- render flat, identical to a trip with no homeroom tracking.
  if (groups.length <= 1) {
    visible.forEach(s => list.appendChild(buildCard(s)));
    return;
  }

  groups.forEach(({ label, students: studs }) => {
    const groupWrap = document.createElement('div');
    groupWrap.className = 'veh-unassigned-group';
    const header = document.createElement('div');
    header.className = 'veh-unassigned-group-header';
    header.textContent = `${label ?? 'No homeroom'} (${studs.length})`;
    groupWrap.appendChild(header);
    studs.forEach(s => groupWrap.appendChild(buildCard(s)));
    list.appendChild(groupWrap);
  });
}

// ── Vehicle columns ──────────────────────────────────────────────────────

function buildColumn(driver, name, studs) {
  const chaperoneId = driver.id;
  const col = document.createElement('div');
  col.className = 'veh-col';
  col.dataset.chaperoneId = chaperoneId;

  const cap   = capacities.get(driver.id) ?? null;
  const count = studs.length;
  const label = groupLabels.get(driver.id) ?? null;

  col.innerHTML = `
    <div class="veh-col-header">
      <div class="veh-col-title">${esc(name)}</div>
      <div class="veh-col-meta">
        <span id="veh-count-${esc(chaperoneId)}">${countLabel(count, count)}</span>
        ${groupPillHtml(chaperoneId, label)}
        ${capPillHtml(chaperoneId, count, cap)}
      </div>
    </div>
    ${progressBarHtml(chaperoneId, count, cap)}
    <div class="veh-col-body" id="veh-body-${esc(chaperoneId)}">
      <div class="veh-cards" id="veh-cards-${esc(chaperoneId)}"></div>
      <div class="veh-empty-state" id="veh-empty-${esc(chaperoneId)}" title="Select student(s) in Unassigned, then click here to add them">
        <span class="veh-empty-icon">+</span>
        <span class="veh-empty-title">Add students</span>
        <span class="veh-empty-hint">Drag students here<br>or use auto-assign</span>
      </div>
      <div class="veh-add-link" id="veh-addlink-${esc(chaperoneId)}" title="Select student(s) in Unassigned, then click here to add them">+ Add students</div>
    </div>
  `;

  const body    = col.querySelector('.veh-col-body');
  const cardsEl = col.querySelector('.veh-cards');
  studs.forEach(s => cardsEl.appendChild(buildCard(s)));

  body.addEventListener('dragover', e => {
    e.preventDefault();
    body.classList.add('drag-over');
  });
  body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
  body.addEventListener('drop', e => {
    e.preventDefault();
    body.classList.remove('drag-over');
    const ids = e.dataTransfer.getData('text/plain').split(',').filter(Boolean);
    moveStudents(ids, driver.id);
  });

  col.addEventListener('click', () => {
    if (!selected.size) return;
    moveStudents([...selected], driver.id);
  });

  col.querySelector('.veh-cap-badge')?.addEventListener('click', e => {
    e.stopPropagation();
    editCapacity(driver.id, name);
  });

  col.querySelector('.veh-group-badge')?.addEventListener('click', e => {
    e.stopPropagation();
    editGroupLabel(driver.id, name);
  });

  return col;
}

function buildCard(student) {
  const card = document.createElement('div');
  card.className   = 'veh-card' + (selected.has(student.id) ? ' selected' : '');
  card.draggable   = true;
  card.dataset.sid = student.id;
  const avatarColor = gradeColors.get(student.grade_level) ?? '#94a3b8';
  card.innerHTML = `
    <span class="veh-avatar" style="background:${avatarColor}">${esc(getInitials(student.first_name, student.last_name))}</span>
    <span class="veh-card-name">${esc(student.last_name)}, ${esc(student.first_name)}</span>
    ${student.grade_level ? `<span class="veh-card-grade">${esc(student.grade_level)}</span>` : ''}
  `;
  card.addEventListener('dragstart', e => {
    const ids = selected.has(student.id) && selected.size > 1 ? [...selected] : [student.id];
    e.dataTransfer.setData('text/plain', ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
    clearSelection();
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', e => {
    e.stopPropagation();
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!multi && selected.has(student.id) && selected.size === 1) {
      clearSelection();
    } else {
      selectCard(student.id, multi);
    }
  });
  return card;
}

// ── Selection ─────────────────────────────────────────────────────────────

function selectCard(studentId, addToSelection = false) {
  if (addToSelection) {
    if (selected.has(studentId)) selected.delete(studentId);
    else selected.add(studentId);
  } else {
    selected.clear();
    selected.add(studentId);
  }
  updateSelectionUI();
}

function clearSelection() {
  selected.clear();
  updateSelectionUI();
}

function updateSelectionUI() {
  document.querySelectorAll('.veh-card').forEach(card => {
    card.classList.toggle('selected', selected.has(card.dataset.sid));
  });
  document.querySelectorAll('.veh-col, .veh-unassigned-wrap').forEach(el => {
    el.classList.toggle('click-target', selected.size > 0);
  });
  const badge = document.getElementById('vehSelectionBadge');
  if (badge) {
    badge.hidden = selected.size === 0;
    badge.textContent = `${selected.size} selected — click a vehicle to move`;
  }
}

// ── Capacity pill / progress bar ────────────────────────────────────────

function capPillHtml(chaperoneId, count, cap) {
  if (cap == null) {
    return `<span class="veh-cap-badge" id="veh-cap-${esc(chaperoneId)}" title="Click to set vehicle capacity">Set capacity</span>`;
  }
  const remain = cap - count;
  const cls  = remain < 0 ? ' over-cap' : remain === 0 ? ' at-cap' : '';
  const text = remain < 0 ? 'Over capacity' : remain === 0 ? 'Full' : `${remain} seat${remain !== 1 ? 's' : ''} left`;
  return `<span class="veh-cap-badge${cls}" id="veh-cap-${esc(chaperoneId)}" title="Click to edit capacity">${text}</span>`;
}

function updateCapBadge(chaperoneId, count) {
  const badge = document.getElementById(`veh-cap-${chaperoneId}`);
  if (!badge) return;
  const cap = capacities.get(chaperoneId) ?? null;
  if (cap == null) {
    badge.className = 'veh-cap-badge';
    badge.textContent = 'Set capacity';
    badge.title = 'Click to set vehicle capacity';
    return;
  }
  const remain = cap - count;
  badge.className = 'veh-cap-badge' + (remain < 0 ? ' over-cap' : remain === 0 ? ' at-cap' : '');
  badge.textContent = remain < 0 ? 'Over capacity' : remain === 0 ? 'Full' : `${remain} seat${remain !== 1 ? 's' : ''} left`;
  badge.title = 'Click to edit capacity';
}

// ── Class/group pill ─────────────────────────────────────────────────────
// Purely organizational -- never read by moveStudents/autoAssign/drag-drop,
// so a car's label can't restrict which students end up in it.

function groupPillHtml(chaperoneId, label) {
  if (!label) {
    return `<span class="veh-group-badge" id="veh-group-${esc(chaperoneId)}" title="Click to label this car by class or group">+ Class/group</span>`;
  }
  return `<span class="veh-group-badge set" id="veh-group-${esc(chaperoneId)}" title="Click to edit">${esc(label)}</span>`;
}

function updateGroupBadge(chaperoneId) {
  const badge = document.getElementById(`veh-group-${chaperoneId}`);
  if (!badge) return;
  const label = groupLabels.get(chaperoneId) ?? null;
  if (!label) {
    badge.className = 'veh-group-badge';
    badge.textContent = '+ Class/group';
    badge.title = 'Click to label this car by class or group';
    return;
  }
  badge.className = 'veh-group-badge set';
  badge.textContent = label;
  badge.title = 'Click to edit';
}

async function editGroupLabel(chaperoneId, name) {
  const current = groupLabels.get(chaperoneId) ?? '';
  const input   = prompt(`Class/group label for ${name} (optional, e.g. a class name, "AM Group", "Bus 3"):`, current);
  if (input === null) return; // cancelled

  const val = input.trim().slice(0, 60);
  if (val) groupLabels.set(chaperoneId, val);
  else groupLabels.delete(chaperoneId);

  await supabase.from('field_trip_chaperones').update({ car_group_label: val || null }).eq('id', chaperoneId);

  if (groupByLabel) {
    buildBoard();
  } else {
    updateGroupBadge(chaperoneId);
    updateGroupToggleVisibility();
  }
}

// Case/whitespace-insensitive bucketing, alphabetical by label, with a
// trailing null-label ("Ungrouped") bucket for cars with no label set.
// Shared by buildBoard() and preparePrintRoster() so screen and print
// never diverge.
function groupDrivers(list) {
  const buckets = new Map(); // normalized key → { label, drivers }
  const ungrouped = [];

  list.forEach(driver => {
    const label = groupLabels.get(driver.id);
    if (!label) { ungrouped.push(driver); return; }
    const key = label.trim().toLowerCase();
    if (!buckets.has(key)) buckets.set(key, { label: label.trim(), drivers: [] });
    buckets.get(key).drivers.push(driver);
  });

  const sorted = [...buckets.values()].sort((a, b) => a.label.localeCompare(b.label));
  if (ungrouped.length) sorted.push({ label: null, drivers: ungrouped });
  return sorted;
}

function anyGroupLabelSet() {
  return drivers.some(d => groupLabels.get(d.id));
}

function updateGroupToggleVisibility() {
  const btn = document.getElementById('vehGroupToggleBtn');
  if (!btn) return;
  const hasLabels = anyGroupLabelSet();
  btn.hidden = !hasLabels;
  if (!hasLabels && groupByLabel) {
    groupByLabel = false;
    localStorage.setItem(GROUP_VIEW_KEY, '0');
  }
  btn.classList.toggle('active', groupByLabel);
  btn.setAttribute('aria-pressed', String(groupByLabel));
  btn.title = groupByLabel ? 'Showing cars grouped by class/label. Click to show the flat grid.' : 'Click to group cars by their class/label';
}

function progressBarHtml(chaperoneId, count, cap) {
  const pct   = cap ? Math.min(100, Math.round((count / cap) * 100)) : 0;
  const color = cap == null ? '#e2e8f0' : count > cap ? '#ef4444' : count === cap ? '#f59e0b' : '#2563eb';
  return `<div class="veh-progress"><div class="veh-progress-fill" id="veh-bar-${esc(chaperoneId)}" style="width:${pct}%;background:${color};"></div></div>`;
}

function updateProgressBar(chaperoneId, count) {
  const fill = document.getElementById(`veh-bar-${chaperoneId}`);
  if (!fill) return;
  const cap = capacities.get(chaperoneId) ?? null;
  const pct = cap ? Math.min(100, Math.round((count / cap) * 100)) : 0;
  fill.style.width = pct + '%';
  fill.style.background = cap == null ? '#e2e8f0' : count > cap ? '#ef4444' : count === cap ? '#f59e0b' : '#2563eb';
}

function refreshColumnFooter(chaperoneId, count) {
  const emptyEl = document.getElementById(`veh-empty-${chaperoneId}`);
  const linkEl  = document.getElementById(`veh-addlink-${chaperoneId}`);
  if (!emptyEl || !linkEl) return;
  const cap  = capacities.get(chaperoneId) ?? null;
  const full = cap != null && count >= cap;
  emptyEl.style.display = count === 0 ? '' : 'none';
  linkEl.style.display  = (count > 0 && !full) ? '' : 'none';
}

function countLabel(visible, total) {
  if (visible === total) return `${total} student${total !== 1 ? 's' : ''}`;
  return `${visible}/${total} students`;
}

function updateColumnCounts() {
  document.querySelectorAll('.veh-col').forEach(col => {
    const chaperoneId = col.dataset.chaperoneId;
    const cardsEl = document.getElementById(`veh-cards-${chaperoneId}`);
    if (!cardsEl) return;
    const cards   = [...cardsEl.querySelectorAll('.veh-card')];
    const total   = cards.length;
    const visible = cards.filter(c => c.style.display !== 'none').length;
    const countEl = document.getElementById(`veh-count-${chaperoneId}`);
    if (countEl) countEl.textContent = countLabel(visible, total);
    updateCapBadge(chaperoneId, total);
    updateProgressBar(chaperoneId, total);
    refreshColumnFooter(chaperoneId, total);
  });
  updateUnassignedMeta();
  updateAggregateStats();
}

function updateUnassignedMeta() {
  const list = document.getElementById('veh-cards-unassigned');
  if (!list) return;
  const cards   = [...list.querySelectorAll('.veh-card')];
  const total   = cards.length;
  const visible = cards.filter(c => c.style.display !== 'none').length;
  const countEl = document.getElementById('vehUnassignedCount');
  if (countEl) countEl.textContent = countLabel(total, total);
  const footerEl = document.getElementById('vehUnassignedFooter');
  if (footerEl) {
    footerEl.textContent = visible === total
      ? `Showing ${total} student${total !== 1 ? 's' : ''}`
      : `Showing ${visible} of ${total} students`;
  }
}

function updateAggregateStats() {
  const el = document.getElementById('vehStats');
  if (!el) return;
  let totalCap = 0, hasCap = false, totalAssigned = 0;
  drivers.forEach(d => {
    const cap = capacities.get(d.id);
    if (cap != null) { totalCap += cap; hasCap = true; }
    totalAssigned += students.filter(s => assignments.get(s.id) === d.id).length;
  });
  const seatsPart = hasCap
    ? `${totalAssigned} of ${totalCap} seats filled${totalCap > 0 ? ` (${Math.round((totalAssigned / totalCap) * 100)}%)` : ''}`
    : `${totalAssigned} student${totalAssigned !== 1 ? 's' : ''} assigned`;
  el.textContent = `${drivers.length} chaperone${drivers.length !== 1 ? 's' : ''} • ${seatsPart}`;
}

// ── Search ────────────────────────────────────────────────────────────────

function applySearchFilter() {
  document.querySelectorAll('.veh-card').forEach(card => {
    const student = students.find(s => s.id === card.dataset.sid);
    const full = `${student?.first_name ?? ''} ${student?.last_name ?? ''}`.toLowerCase();
    const inUnassigned = card.closest('#veh-cards-unassigned') != null;
    const matchesGlobal = !searchTerm || full.includes(searchTerm);
    const matchesLocal  = !inUnassigned || !unassignedSearchTerm || full.includes(unassignedSearchTerm);
    card.style.display = (matchesGlobal && matchesLocal) ? '' : 'none';
  });
  // Homeroom group headers in Unassigned should disappear along with every
  // card in that group once search filters them all out.
  document.querySelectorAll('.veh-unassigned-group').forEach(group => {
    const anyVisible = [...group.querySelectorAll('.veh-card')].some(c => c.style.display !== 'none');
    group.style.display = anyVisible ? '' : 'none';
  });
  updateColumnCounts();
}

async function editCapacity(chaperoneId, name) {
  const current = capacities.get(chaperoneId);
  const input   = prompt(`Vehicle capacity for ${name}:`, current != null ? String(current) : '');
  if (input === null) return; // cancelled

  if (input.trim() === '') {
    capacities.delete(chaperoneId);
    await supabase.from('field_trip_chaperones').update({ vehicle_capacity: null }).eq('id', chaperoneId);
  } else {
    const val = parseInt(input, 10);
    if (isNaN(val) || val < 1) { alert('Please enter a whole number greater than 0.'); return; }
    capacities.set(chaperoneId, val);
    await supabase.from('field_trip_chaperones').update({ vehicle_capacity: val }).eq('id', chaperoneId);
  }
  updateColumnCounts();
}

// ── Drag / click / move ──────────────────────────────────────────────────

function cardsContainerId(chaperoneId) {
  return chaperoneId ? `veh-cards-${chaperoneId}` : 'veh-cards-unassigned';
}

function moveStudents(studentIds, targetChaperoneId) {
  const ids = (Array.isArray(studentIds) ? studentIds : [studentIds]).filter(Boolean);
  const group = ids
    .map(id => ({ studentId: id, fromChaperoneId: assignments.get(id) ?? null }))
    .filter(g => g.fromChaperoneId !== targetChaperoneId);

  clearSelection();
  if (!group.length) return;

  undoStack.push(group);
  if (undoStack.length > 30) undoStack.shift();

  group.forEach(({ studentId }) => {
    assignments.set(studentId, targetChaperoneId);
    dirty.add(studentId);
    const card = document.querySelector(`[data-sid="${studentId}"]`);
    if (card) document.getElementById(cardsContainerId(targetChaperoneId))?.appendChild(card);
  });

  // Unassigned is (optionally) grouped by homeroom, so anything moving in or
  // out of it needs a rebuild rather than a plain append -- otherwise a
  // newly-unassigned card lands outside any group wrapper.
  if (targetChaperoneId === null || group.some(g => g.fromChaperoneId === null)) {
    renderUnassignedList();
  }

  applySearchFilter();
  updateColumnCounts();
  scheduleSave();
  updateUndoBtn();
}

function undoLastMove() {
  const group = undoStack.pop();
  if (!group) return;

  let touchedUnassigned = false;
  group.forEach(({ studentId, fromChaperoneId }) => {
    if (assignments.get(studentId) === null || fromChaperoneId === null) touchedUnassigned = true;
    assignments.set(studentId, fromChaperoneId);
    dirty.add(studentId);
    const card = document.querySelector(`[data-sid="${studentId}"]`);
    if (card) document.getElementById(cardsContainerId(fromChaperoneId))?.appendChild(card);
  });

  if (touchedUnassigned) renderUnassignedList();

  clearSelection();
  applySearchFilter();
  updateColumnCounts();
  scheduleSave();
  updateUndoBtn();
}

function updateUndoBtn() {
  const btn = document.getElementById('vehUndoBtn');
  if (btn) btn.disabled = undoStack.length === 0;
}

// ── Save ──────────────────────────────────────────────────────────────────

function scheduleSave() {
  setSaveStatus('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveAssignments, 900);
}

async function saveAssignments() {
  if (!dirty.size) { setSaveStatus('saved'); return; }

  const toUpsert = [];
  const toDelete = [];

  dirty.forEach(studentId => {
    const chaperoneId = assignments.get(studentId) ?? null;
    if (chaperoneId) {
      toUpsert.push({
        school_id:    profile.school_id,
        field_trip_id: tripId,
        student_id:   studentId,
        chaperone_id: chaperoneId,
        assigned_by:  profile.id,
      });
    } else {
      toDelete.push(studentId);
    }
  });

  const ops = [];
  if (toUpsert.length) {
    ops.push(
      supabase.from('field_trip_vehicle_assignments')
        .upsert(toUpsert, { onConflict: 'field_trip_id,student_id' })
    );
  }
  if (toDelete.length) {
    ops.push(
      supabase.from('field_trip_vehicle_assignments')
        .delete()
        .eq('field_trip_id', tripId)
        .in('student_id', toDelete)
    );
  }

  const results = await Promise.all(ops);
  if (results.some(r => r.error)) {
    setSaveStatus('error');
  } else {
    dirty.clear();
    setSaveStatus('saved');
  }
}

function setSaveStatus(status) {
  const el = document.getElementById('vehSaveStatus');
  if (!el) return;
  el.className = `veh-save-status ${status}`;
  const text = status === 'saving' ? 'Saving…'
    : status === 'saved'  ? 'All changes saved'
    : 'Save failed — try again';
  el.innerHTML = `${SAVE_ICONS[status] ?? ''}<span>${text}</span>`;
}

// ── Clear all assignments ─────────────────────────────────────────────────

function clearAssignments() {
  const assigned = students.filter(s => assignments.get(s.id));
  if (!assigned.length) { alert('No students are currently assigned.'); return; }
  if (!confirm(`Move all ${assigned.length} assigned student${assigned.length !== 1 ? 's' : ''} back to Unassigned?`)) return;

  assigned.forEach(s => {
    assignments.set(s.id, null);
    dirty.add(s.id);
  });

  undoStack = [];
  updateUndoBtn();
  buildBoard();
  scheduleSave();
}

// ── Auto-assign ───────────────────────────────────────────────────────────

function autoAssign() {
  if (!drivers.length) return;

  const unassigned = students.filter(s => !assignments.get(s.id));
  if (!unassigned.length) { alert('All students are already assigned.'); return; }

  // Sort by grade then last name so siblings of the same grade are grouped
  unassigned.sort((a, b) => {
    const gCmp = (a.grade_level ?? '').localeCompare(b.grade_level ?? '');
    if (gCmp !== 0) return gCmp;
    return (a.last_name ?? '').localeCompare(b.last_name ?? '');
  });

  unassigned.forEach(student => {
    // Pick the driver with the most remaining capacity (or fewest students if no caps set)
    const target = drivers.reduce((best, d) => {
      const count  = [...assignments.values()].filter(v => v === d.id).length;
      const cap    = capacities.get(d.id) ?? Infinity;
      const remain = cap - count;
      if (remain <= 0) return best;
      if (!best) return d;
      const bestCount  = [...assignments.values()].filter(v => v === best.id).length;
      const bestCap    = capacities.get(best.id) ?? Infinity;
      const bestRemain = bestCap - bestCount;
      return remain > bestRemain ? d : best;
    }, null) ?? drivers[0];

    assignments.set(student.id, target.id);
    dirty.add(student.id);
  });

  undoStack = [];
  updateUndoBtn();
  buildBoard();
  scheduleSave();
}

// ── Print roster ──────────────────────────────────────────────────────────

function preparePrintRoster() {
  const wrap = document.getElementById('printRoster');
  if (!wrap) return;

  const startDate = trip.start_date
    ? new Date(trip.start_date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    : '';

  const driverBoxHtml = driver => {
    const name  = driverName(driver);
    const cap   = capacities.get(driver.id);
    const label = groupLabels.get(driver.id);
    const studs = students
      .filter(s => assignments.get(s.id) === driver.id)
      .sort((a, b) => (a.last_name ?? '').localeCompare(b.last_name ?? ''));

    let box = `<div class="print-vehicle-box">
      <div class="print-vehicle-name">${esc(name)}</div>
      ${label ? `<div class="print-vehicle-group">${esc(label)}</div>` : ''}
      <div class="print-vehicle-cap">${cap ? `${studs.length} of ${cap} seats` : `${studs.length} student${studs.length !== 1 ? 's' : ''}`}</div>`;

    if (studs.length) {
      studs.forEach(s => {
        box += `<div class="print-vehicle-student">${esc(s.last_name)}, ${esc(s.first_name)}${s.grade_level ? ` <span style="color:#9ca3af;font-size:11px;">(${esc(s.grade_level)})</span>` : ''}</div>`;
      });
    } else {
      box += `<div style="font-size:12px;color:#9ca3af;font-style:italic;">No students assigned</div>`;
    }
    return box + `</div>`;
  };

  let html = `
    <h1>${esc(trip.name)}</h1>
    <div class="print-meta">${startDate}${trip.destination ? ' &mdash; ' + esc(trip.destination) : ''}</div>
    <div class="print-vehicles">`;

  if (groupByLabel) {
    groupDrivers(drivers).forEach(({ label, drivers: bucketDrivers }) => {
      html += `<div class="print-group-header">${esc(label ?? 'Ungrouped')}</div>`;
      bucketDrivers.forEach(driver => { html += driverBoxHtml(driver); });
    });
  } else {
    drivers.forEach(driver => { html += driverBoxHtml(driver); });
  }

  html += `</div>`;

  const unassigned = students
    .filter(s => !assignments.get(s.id))
    .sort((a, b) => (a.last_name ?? '').localeCompare(b.last_name ?? ''));

  if (unassigned.length) {
    html += `<div class="print-unassigned">
      <div class="print-unassigned-title">Unassigned (${unassigned.length})</div>`;
    unassigned.forEach(s => {
      html += `<div class="print-vehicle-student">${esc(s.last_name)}, ${esc(s.first_name)}${s.grade_level ? ` (${esc(s.grade_level)})` : ''}</div>`;
    });
    html += `</div>`;
  }

  wrap.innerHTML = html;
}

// ── Wire toolbar ──────────────────────────────────────────────────────────

function wireActions() {
  document.getElementById('vehAutoAssignBtn')?.addEventListener('click', autoAssign);
  document.getElementById('vehClearBtn')?.addEventListener('click', clearAssignments);
  document.getElementById('vehPrintBtn')?.addEventListener('click', () => {
    preparePrintRoster();
    window.print();
  });
  document.getElementById('vehUndoBtn')?.addEventListener('click', undoLastMove);
  document.getElementById('vehSelectionBadge')?.addEventListener('click', clearSelection);
  document.getElementById('vehGroupToggleBtn')?.addEventListener('click', () => {
    groupByLabel = !groupByLabel;
    localStorage.setItem(GROUP_VIEW_KEY, groupByLabel ? '1' : '0');
    buildBoard();
  });
  document.getElementById('vehSearch')?.addEventListener('input', e => {
    searchTerm = e.target.value.trim().toLowerCase();
    applySearchFilter();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
init();

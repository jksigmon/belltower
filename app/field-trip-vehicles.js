import { supabase } from './admin.supabase.js?v=2';
import { initPage } from './admin.auth.js?v=2';
import { esc } from './admin.shared.js?v=3';

const GRADE_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444',
  '#8b5cf6','#06b6d4','#f97316','#ec4899',
  '#14b8a6','#a855f7',
];

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
let gradeColors  = new Map(); // grade_level → color hex
let dirty        = new Set();
let saveTimer    = null;
let selected     = new Set();  // student ids selected for click-to-move
let undoStack    = [];         // array of [{ studentId, fromChaperoneId }, ...] groups
let searchTerm   = '';         // toolbar search — applies board-wide
let unassignedSearchTerm = ''; // sidebar-local search — Unassigned list only

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
      .select('id, vehicle_capacity, guardian:guardians(first_name, last_name), employee:employees(first_name, last_name), volunteer:compliance_volunteers(first_name, last_name)')
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
    .select('id, first_name, last_name, grade_level')
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
  const unassigned = students.filter(s => !assignments.get(s.id));
  board.appendChild(buildUnassignedPanel(unassigned));

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

  drivers.forEach(driver => {
    const name    = driverName(driver);
    const assigned = students.filter(s => assignments.get(s.id) === driver.id);
    grid.appendChild(buildColumn(driver, name, assigned));
  });

  applySearchFilter();
  updateSelectionUI();
  setSaveStatus('saved');
}

function driverName(driver) {
  const person = driver.guardian ?? driver.employee ?? driver.volunteer;
  return `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim() || 'Driver';
}

// ── Unassigned sidebar ───────────────────────────────────────────────────

function buildUnassignedPanel(studs) {
  const wrap = document.createElement('div');
  wrap.className = 'veh-unassigned-wrap';
  wrap.dataset.chaperoneId = 'unassigned';
  wrap.innerHTML = `
    <div class="veh-unassigned-header">
      <div class="veh-unassigned-title">Unassigned Students</div>
      <div class="veh-unassigned-count" id="vehUnassignedCount">${countLabel(studs.length, studs.length)}</div>
    </div>
    <div class="veh-unassigned-search-wrap">
      <input type="search" id="vehUnassignedSearch" class="veh-search" placeholder="Search students…">
    </div>
    <div class="veh-unassigned-list" id="veh-cards-unassigned"></div>
    <div class="veh-unassigned-footer" id="vehUnassignedFooter"></div>
  `;

  const list = wrap.querySelector('#veh-cards-unassigned');
  studs.forEach(s => list.appendChild(buildCard(s)));

  const searchInput = wrap.querySelector('#vehUnassignedSearch');
  searchInput.value = unassignedSearchTerm;
  searchInput.addEventListener('input', e => {
    unassignedSearchTerm = e.target.value.trim().toLowerCase();
    applySearchFilter();
  });

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
    if (e.target.closest('#vehUnassignedSearch')) return;
    if (!selected.size) return;
    moveStudents([...selected], null);
  });

  return wrap;
}

// ── Vehicle columns ──────────────────────────────────────────────────────

function buildColumn(driver, name, studs) {
  const chaperoneId = driver.id;
  const col = document.createElement('div');
  col.className = 'veh-col';
  col.dataset.chaperoneId = chaperoneId;

  const cap   = capacities.get(driver.id) ?? null;
  const count = studs.length;

  col.innerHTML = `
    <div class="veh-col-header">
      <div class="veh-col-title">${esc(name)}</div>
      <div class="veh-col-meta">
        <span id="veh-count-${esc(chaperoneId)}">${countLabel(count, count)}</span>
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

  applySearchFilter();
  updateColumnCounts();
  scheduleSave();
  updateUndoBtn();
}

function undoLastMove() {
  const group = undoStack.pop();
  if (!group) return;

  group.forEach(({ studentId, fromChaperoneId }) => {
    assignments.set(studentId, fromChaperoneId);
    dirty.add(studentId);
    const card = document.querySelector(`[data-sid="${studentId}"]`);
    if (card) document.getElementById(cardsContainerId(fromChaperoneId))?.appendChild(card);
  });

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

  let html = `
    <h1>${esc(trip.name)}</h1>
    <div class="print-meta">${startDate}${trip.destination ? ' &mdash; ' + esc(trip.destination) : ''}</div>
    <div class="print-vehicles">`;

  drivers.forEach(driver => {
    const name  = driverName(driver);
    const cap   = capacities.get(driver.id);
    const studs = students
      .filter(s => assignments.get(s.id) === driver.id)
      .sort((a, b) => (a.last_name ?? '').localeCompare(b.last_name ?? ''));

    html += `<div class="print-vehicle-box">
      <div class="print-vehicle-name">${esc(name)}</div>
      <div class="print-vehicle-cap">${cap ? `${studs.length} of ${cap} seats` : `${studs.length} student${studs.length !== 1 ? 's' : ''}`}</div>`;

    if (studs.length) {
      studs.forEach(s => {
        html += `<div class="print-vehicle-student">${esc(s.last_name)}, ${esc(s.first_name)}${s.grade_level ? ` <span style="color:#9ca3af;font-size:11px;">(${esc(s.grade_level)})</span>` : ''}</div>`;
      });
    } else {
      html += `<div style="font-size:12px;color:#9ca3af;font-style:italic;">No students assigned</div>`;
    }
    html += `</div>`;
  });

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
  document.getElementById('vehSearch')?.addEventListener('input', e => {
    searchTerm = e.target.value.trim().toLowerCase();
    applySearchFilter();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
init();

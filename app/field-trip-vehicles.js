import { supabase } from './admin.supabase.js';
import { initPage } from './admin.auth.js';
import { esc } from './admin.shared.js';

const GRADE_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#ef4444',
  '#8b5cf6','#06b6d4','#f97316','#ec4899',
  '#14b8a6','#a855f7',
];

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
    .from('field_trips').select('*').eq('id', tripId).single();

  if (tripErr || !tripData) {
    document.getElementById('vehBoard').innerHTML =
      '<div style="padding:60px;color:#dc2626;font-size:14px;">Trip not found or access denied.</div>';
    return;
  }

  trip = tripData;
  document.getElementById('vehTripName').textContent = trip.name;
  document.title = `Vehicles – ${trip.name}`;

  const [driversRes, studList, assignRes] = await Promise.all([
    supabase.from('field_trip_chaperones')
      .select('id, vehicle_capacity, guardian:guardians(first_name, last_name)')
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

  // Unassigned column
  const unassigned = students.filter(s => !assignments.get(s.id));
  board.appendChild(buildColumn(null, 'Unassigned', unassigned));

  // One column per driver
  drivers.forEach(driver => {
    const name    = driverName(driver);
    const assigned = students.filter(s => assignments.get(s.id) === driver.id);
    board.appendChild(buildColumn(driver, name, assigned));
  });
}

function driverName(driver) {
  return `${driver.guardian?.first_name ?? ''} ${driver.guardian?.last_name ?? ''}`.trim() || 'Driver';
}

function buildColumn(driver, name, studs) {
  const chaperoneId = driver?.id ?? 'unassigned';
  const col = document.createElement('div');
  col.className = 'veh-col' + (driver == null ? ' veh-col-unassigned' : '');
  col.dataset.chaperoneId = chaperoneId;

  const cap   = driver ? (capacities.get(driver.id) ?? null) : null;
  const count = studs.length;

  col.innerHTML = `
    <div class="veh-col-header">
      <div class="veh-col-title">${esc(name)}</div>
      <div class="veh-col-meta">
        <span id="veh-count-${esc(chaperoneId)}">${countLabel(count)}</span>
        ${driver ? capBadgeHtml(driver.id, count, cap) : ''}
      </div>
    </div>
    <div class="veh-col-body" id="veh-body-${esc(chaperoneId)}"></div>
  `;

  const body = col.querySelector('.veh-col-body');
  studs.forEach(s => body.appendChild(buildCard(s)));

  body.addEventListener('dragover', e => {
    e.preventDefault();
    body.classList.add('drag-over');
  });
  body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
  body.addEventListener('drop', e => {
    e.preventDefault();
    body.classList.remove('drag-over');
    const studentId   = e.dataTransfer.getData('text/plain');
    const targetChapId = driver?.id ?? null;
    moveStudent(studentId, targetChapId);
  });

  if (driver) {
    col.querySelector('.veh-cap-badge')?.addEventListener('click', () => editCapacity(driver.id, name));
  }

  return col;
}

function buildCard(student) {
  const card = document.createElement('div');
  card.className   = 'veh-card';
  card.draggable   = true;
  card.dataset.sid = student.id;
  card.style.borderLeftColor = gradeColors.get(student.grade_level) ?? '#94a3b8';
  card.innerHTML = `
    <div class="veh-card-name">${esc(student.last_name)}, ${esc(student.first_name)}</div>
    ${student.grade_level ? `<div class="veh-card-grade">${esc(student.grade_level)}</div>` : ''}
  `;
  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', student.id);
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

// ── Capacity badge ────────────────────────────────────────────────────────

function capBadgeHtml(chaperoneId, count, cap) {
  const cls  = cap == null ? '' : count > cap ? ' over-cap' : count === cap ? ' at-cap' : '';
  const text = cap == null ? 'Set capacity' : `${count}/${cap}`;
  const tip  = cap == null ? 'Click to set vehicle capacity' : 'Click to edit capacity';
  return `<span class="veh-cap-badge${cls}" id="veh-cap-${esc(chaperoneId)}" title="${tip}">${text}</span>`;
}

function updateCapBadge(chaperoneId) {
  const badge = document.getElementById(`veh-cap-${chaperoneId}`);
  if (!badge) return;
  const body  = document.getElementById(`veh-body-${chaperoneId}`);
  const count = body ? body.querySelectorAll('.veh-card').length : 0;
  const cap   = capacities.get(chaperoneId) ?? null;
  badge.className = 'veh-cap-badge' + (cap == null ? '' : count > cap ? ' over-cap' : count === cap ? ' at-cap' : '');
  badge.textContent = cap == null ? 'Set capacity' : `${count}/${cap}`;
  badge.title = cap == null ? 'Click to set vehicle capacity' : 'Click to edit capacity';
}

function countLabel(n) {
  return `${n} student${n !== 1 ? 's' : ''}`;
}

function updateColumnCounts() {
  document.querySelectorAll('.veh-col').forEach(col => {
    const chaperoneId = col.dataset.chaperoneId;
    const body  = document.getElementById(`veh-body-${chaperoneId}`);
    if (!body) return;
    const count = body.querySelectorAll('.veh-card').length;
    const countEl = document.getElementById(`veh-count-${chaperoneId}`);
    if (countEl) countEl.textContent = countLabel(count);
    if (chaperoneId !== 'unassigned') updateCapBadge(chaperoneId);
  });
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

// ── Drag / move ───────────────────────────────────────────────────────────

function moveStudent(studentId, targetChaperoneId) {
  if (!studentId) return;
  const prevChaperoneId = assignments.get(studentId) ?? null;
  if (prevChaperoneId === targetChaperoneId) return;

  assignments.set(studentId, targetChaperoneId);
  dirty.add(studentId);

  const card = document.querySelector(`[data-sid="${studentId}"]`);
  if (card) {
    const targetBodyId = targetChaperoneId ? `veh-body-${targetChaperoneId}` : 'veh-body-unassigned';
    document.getElementById(targetBodyId)?.appendChild(card);
  }

  updateColumnCounts();
  scheduleSave();
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
  el.textContent = status === 'saving' ? 'Saving…'
    : status === 'saved'  ? 'All changes saved'
    : 'Save failed — try again';
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
}

// ── Boot ──────────────────────────────────────────────────────────────────
init();

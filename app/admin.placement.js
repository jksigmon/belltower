import { supabase } from './admin.supabase.js';
import { esc, GRADE_ORDER, nextGrade, gradeLabel, loadSchoolConfig } from './admin.shared.js';

/* ── State ── */
let _profile = null;
let _currentSessionId = null;
let _session = null;
let _teachers = [];
let _students = [];
let _assignments = {};    // studentId → teacherId | null
let _studentFlags = {};   // studentId → Set<flagId>
let _flags = [];
let _initialized = false;
let _savedAssignments = {};  // mirrors what's persisted in DB
let _saveTimer = null;
let _selectedStudentIds = new Set();
let _flagPopoverStudentId = null;
let _formEmployees = [];  // all employees for create form
let _schoolConfig = null;
let _boardSearchTerm = '';
let _targetClassSize = null;
let _undoStack = [];          // array of move groups [{studentId, fromTeacherId}]
let _homeroomTeacherNames = {}; // employeeId → last name for comparison display
let _draggingColumnTeacherId = null;
let _showArchivedSessions = false;

/* ── Entry point ── */
export async function initPlacementSection(profile) {
  _profile = profile;

  if (!profile.is_superadmin && !profile.can_manage_placement) {
    document.getElementById('placementSessionListView').innerHTML =
      '<p class="muted" style="padding:1rem;">You do not have permission to manage class placement.</p>';
    return;
  }

  _schoolConfig = await loadSchoolConfig(_profile.school_id);

  if (!_initialized) {
    _initialized = true;
    wireGlobalEvents();
  }
  await showSessionList();
}

/* ── View switching ── */
function showView(id) {
  ['placementSessionListView', 'placementCreateFormView', 'placementBoardView'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.hidden = v !== id;
  });
}

/* ── Wire global events ── */
function wireGlobalEvents() {
  document.getElementById('newPlacementSessionBtn')
    ?.addEventListener('click', showCreateForm);
  document.getElementById('cancelCreatePlacementBtn')
    ?.addEventListener('click', () => showSessionList());
  document.getElementById('cancelCreatePlacementBtn2')
    ?.addEventListener('click', () => showSessionList());
  document.getElementById('submitCreatePlacementBtn')
    ?.addEventListener('click', submitCreateForm);
  document.getElementById('backToSessionListBtn')
    ?.addEventListener('click', () => { exitFullscreen(); showSessionList(); });
  document.getElementById('commitPlacementBtn')
    ?.addEventListener('click', confirmCommit);
  document.getElementById('undoCommitPlacementBtn')
    ?.addEventListener('click', confirmUndoCommit);
  document.getElementById('placementHistoryBtn')
    ?.addEventListener('click', openAuditLog);
  document.getElementById('closeAuditLogBtn')
    ?.addEventListener('click', closeAuditLog);
  document.getElementById('showArchivedSessionsToggle')
    ?.addEventListener('change', e => { _showArchivedSessions = e.target.checked; renderSessionList(); });
  document.getElementById('manageFlagsBtn')
    ?.addEventListener('click', openFlagEditor);
  document.getElementById('closeFlagEditorBtn')
    ?.addEventListener('click', closeFlagEditor);
  document.getElementById('addFlagBtn')
    ?.addEventListener('click', addFlag);
  document.getElementById('newFlagColorDot')
    ?.addEventListener('click', e => { e.stopPropagation(); toggleColorPicker('newFlagColorPickerEl', _newFlagColor, c => { _newFlagColor = c; document.getElementById('newFlagColorDot').style.background = c; }); });
  document.getElementById('autoPlacementBtn')
    ?.addEventListener('click', autoPlaceStudents);
  document.getElementById('exportPlacementBtn')
    ?.addEventListener('click', exportPlacement);
  document.getElementById('undoPlacementMoveBtn')
    ?.addEventListener('click', undoLastMove);
  document.getElementById('togglePlacementDensity')
    ?.addEventListener('click', toggleCompact);
  document.getElementById('togglePlacementFullscreen')
    ?.addEventListener('click', toggleFullscreen);
  document.getElementById('placementBoardSearch')
    ?.addEventListener('input', e => {
      _boardSearchTerm = e.target.value.trim().toLowerCase();
      renderBoard();
    });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') exitFullscreen();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      if (document.getElementById('placementBoardView')?.hidden === false) {
        e.preventDefault();
        undoLastMove();
      }
    }
  });
}

/* ── Session list ── */
async function showSessionList() {
  showView('placementSessionListView');
  await renderSessionList();
}

async function renderSessionList() {
  const container = document.getElementById('placementSessionList');
  if (!container) return;
  container.innerHTML = '<p class="muted" style="font-size:13px;padding:12px 0;">Loading…</p>';

  let query = supabase
    .from('placement_sessions')
    .select('id, label, academic_year, incoming_grade, target_grade, status, created_at, committed_at, target_class_size, archived_at')
    .eq('school_id', _profile.school_id)
    .order('created_at', { ascending: false });
  if (!_showArchivedSessions) query = query.is('archived_at', null);
  const { data, error } = await query;

  if (error) {
    container.innerHTML = '<p class="muted" style="font-size:13px;">Failed to load sessions.</p>';
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = `
      <div class="placement-empty">
        <p style="font-weight:600;margin:0 0 4px;">No placement sessions yet.</p>
        <p class="muted" style="font-size:13px;margin:0;">Create a session to start placing students for the upcoming year.</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  data.forEach(s => {
    const row = document.createElement('div');
    row.className = 'placement-session-row';
    const committed = s.status === 'committed';
    const archived  = !!s.archived_at;
    if (archived) row.style.opacity = '0.6';
    row.innerHTML = `
      <div class="placement-session-info">
        <div class="placement-session-label">${esc(s.label)}${archived ? ' <span class="badge badge-neutral" style="font-size:10px;vertical-align:middle;">Archived</span>' : ''}</div>
        <div class="muted" style="font-size:12px;margin-top:2px;">
          ${esc(s.academic_year.replace('-', '–'))} &middot; ${gradeLabel(s.incoming_grade)} &rarr; ${gradeLabel(s.target_grade)}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
        <span class="placement-status-badge ${committed ? 'badge-committed' : 'badge-draft'}">${committed ? 'Committed' : 'Draft'}</span>
        <span class="muted" style="font-size:12px;">
          ${committed && s.committed_at
            ? 'Committed ' + new Date(s.committed_at).toLocaleDateString()
            : 'Created ' + new Date(s.created_at).toLocaleDateString()}
        </span>
        <button class="btn btn-sm btn-outline clone-session-btn" data-idx="${data.indexOf(s)}" title="Clone to a new year">
          <i data-lucide="copy" style="width:14px;height:14px;"></i>
        </button>
        <button class="btn btn-sm btn-outline archive-session-btn" data-id="${s.id}" data-archived="${archived}" title="${archived ? 'Unarchive' : 'Archive'} session">
          <i data-lucide="${archived ? 'archive-restore' : 'archive'}" style="width:14px;height:14px;"></i>
        </button>
        ${!committed && !archived ? `<button class="btn btn-sm btn-outline delete-session-btn" data-id="${s.id}" data-label="${esc(s.label)}" style="color:#dc2626;border-color:#fca5a5;" title="Delete draft">
          <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
        </button>` : ''}
        ${!archived ? `<button class="btn btn-sm btn-outline open-session-btn" data-id="${s.id}">
          ${committed ? 'View' : 'Open Board'} <i data-lucide="arrow-right" style="width:14px;height:14px;"></i>
        </button>` : ''}
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.open-session-btn').forEach(btn => {
    btn.addEventListener('click', () => showBoard(btn.dataset.id));
  });

  container.querySelectorAll('.clone-session-btn').forEach(btn => {
    btn.addEventListener('click', () => cloneSession(data[parseInt(btn.dataset.idx, 10)]));
  });

  container.querySelectorAll('.archive-session-btn').forEach(btn => {
    btn.addEventListener('click', () => archiveSession(btn.dataset.id, btn.dataset.archived !== 'true'));
  });

  container.querySelectorAll('.delete-session-btn').forEach(btn => {
    btn.addEventListener('click', () => confirmDeleteSession(btn.dataset.id, btn.dataset.label));
  });

  if (window.lucide) lucide.createIcons({ nodes: Array.from(container.querySelectorAll('[data-lucide]')) });
}

/* ── Delete session ── */
async function confirmDeleteSession(sessionId, label) {
  const confirmed = confirm(
    `Delete draft session "${label}"?\n\nThis will permanently remove the session and all its assignments. This cannot be undone.`
  );
  if (!confirmed) return;

  const { error } = await supabase
    .from('placement_sessions')
    .delete()
    .eq('id', sessionId);

  if (error) {
    console.error('Delete session error:', error);
    alert('Failed to delete session. Check the console for details.');
    return;
  }

  await renderSessionList();
}

/* ── Archive session ── */
async function archiveSession(id, archive) {
  const { error } = await supabase
    .from('placement_sessions')
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { console.error('Archive session error:', error); return; }
  await renderSessionList();
}

/* ── Clone session ── */
async function cloneSession(original) {
  const suggested = nextAcademicYear(original.academic_year);
  const newYear = prompt(
    `Clone "${original.label}" into a new draft session.\n\nNew academic year:`,
    suggested
  );
  if (!newYear?.trim()) return;

  const { data: origTeachers, error: tErr } = await supabase
    .from('placement_session_teachers')
    .select('teacher_id, sort_order')
    .eq('session_id', original.id)
    .order('sort_order');
  if (tErr) { alert('Failed to load session teachers.'); return; }

  const { data: newSession, error: sErr } = await supabase
    .from('placement_sessions')
    .insert({
      school_id:        _profile.school_id,
      academic_year:    newYear.trim(),
      incoming_grade:   original.incoming_grade,
      target_grade:     original.target_grade,
      label:            original.label,
      status:           'draft',
      target_class_size: original.target_class_size ?? null,
    })
    .select('id')
    .single();
  if (sErr || !newSession) { alert('Failed to create cloned session.'); return; }

  if (origTeachers?.length) {
    await supabase.from('placement_session_teachers').insert(
      origTeachers.map(t => ({ session_id: newSession.id, teacher_id: t.teacher_id, sort_order: t.sort_order }))
    );
  }

  const { data: gradeStudents } = await supabase
    .from('students')
    .select('id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .eq('grade_level', original.incoming_grade);

  if (gradeStudents?.length) {
    await supabase.from('placement_assignments').insert(
      gradeStudents.map((s, i) => ({ session_id: newSession.id, student_id: s.id, teacher_id: null, sort_order: i }))
    );
  }

  await showBoard(newSession.id);
}

function nextAcademicYear(year) {
  const parts = year.split('-');
  if (parts.length === 2) {
    const start = parseInt(parts[0], 10);
    if (!isNaN(start)) return `${start + 1}-${start + 2}`;
  }
  return year;
}

/* ── Create form ── */
async function showCreateForm() {
  showView('placementCreateFormView');
  populateCreateFormYears();
  populateIncomingGradeSelect();
  await loadEmployeesForForm();
}

function populateIncomingGradeSelect() {
  const sel = document.getElementById('placementIncomingGrade');
  if (!sel) return;
  const grades = _schoolConfig?.grade_levels ?? GRADE_ORDER;
  sel.innerHTML = '<option value="">— Select grade —</option>';
  grades.forEach(g => {
    // Exclude the terminal grade — students there graduate rather than advance
    if (nextGrade(g, _schoolConfig) === null) return;
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = gradeLabel(g);
    sel.appendChild(opt);
  });
}

function populateCreateFormYears() {
  const sel = document.getElementById('placementYear');
  if (!sel) return;
  const cur = new Date().getFullYear();
  sel.innerHTML = '';
  for (let y = cur; y <= cur + 1; y++) {
    const opt = document.createElement('option');
    opt.value = `${y}-${y + 1}`;
    opt.textContent = `${y}–${y + 1}`;
    sel.appendChild(opt);
  }
}

async function loadEmployeesForForm() {
  const container = document.getElementById('placementTeacherCheckboxes');
  if (!container) return;
  container.innerHTML = '<p class="muted" style="font-size:13px;">Loading…</p>';

  // Load campuses for filter
  const { data: camps } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', _profile.school_id)
    .order('name');

  const campuses = camps || [];
  const campusFilterWrap = document.getElementById('placementCampusFilterWrap');
  const campusFilter = document.getElementById('placementCampusFilter');

  if (campusFilter && campuses.length > 1) {
    campusFilter.innerHTML = '<option value="">All Campuses</option>';
    campuses.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      campusFilter.appendChild(opt);
    });
    if (campusFilterWrap) campusFilterWrap.hidden = false;

    campusFilter.addEventListener('change', () => {
      renderEmployeeCheckboxes(campusFilter.value);
    });
  }

  const sortSelect = document.getElementById('placementStaffSort');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      const campusId = document.getElementById('placementCampusFilter')?.value ?? '';
      renderEmployeeCheckboxes(campusId);
    });
  }

  // Load employees
  const { data, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name, position, campus_id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .order('last_name');

  if (error) {
    console.error('Load employees error:', error);
    container.innerHTML = '<p class="muted" style="font-size:13px;">Failed to load employees.</p>';
    return;
  }

  _formEmployees = data || [];
  renderEmployeeCheckboxes('');
}

function renderEmployeeCheckboxes(campusId) {
  const container = document.getElementById('placementTeacherCheckboxes');
  if (!container) return;

  const sortBy = document.getElementById('placementStaffSort')?.value ?? 'last_name';

  const filtered = (campusId
    ? _formEmployees.filter(e => e.campus_id === campusId)
    : [..._formEmployees]
  ).sort((a, b) => {
    if (sortBy === 'first_name') return a.first_name.localeCompare(b.first_name);
    if (sortBy === 'position')   return (a.position ?? '').localeCompare(b.position ?? '');
    return a.last_name.localeCompare(b.last_name);
  });

  if (filtered.length === 0) {
    container.innerHTML = '<p class="muted" style="font-size:13px;">No employees found.</p>';
    return;
  }

  // Preserve checked state across re-renders
  const checked = new Set(
    Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value)
  );

  container.innerHTML = '';
  filtered.forEach(emp => {
    const label = document.createElement('label');
    label.className = 'placement-teacher-check';
    label.innerHTML = `
      <input type="checkbox" value="${emp.id}" data-name="${esc(emp.first_name + ' ' + emp.last_name)}"${checked.has(emp.id) ? ' checked' : ''}>
      <div class="placement-teacher-check-info">
        <span class="placement-teacher-check-name">${esc(emp.last_name)}, ${esc(emp.first_name)}</span>
        ${emp.position ? `<span class="placement-teacher-check-type">${esc(emp.position)}</span>` : ''}
      </div>
    `;
    container.appendChild(label);
  });
}

async function submitCreateForm() {
  const year = document.getElementById('placementYear')?.value;
  const incoming = document.getElementById('placementIncomingGrade')?.value;
  const labelInput = document.getElementById('placementLabel')?.value.trim();

  if (!year || !incoming) {
    alert('Please select a year and incoming grade.');
    return;
  }

  const target = nextGrade(incoming, _schoolConfig);
  const label = labelInput || `${gradeLabel(incoming)} → ${target ? gradeLabel(target) : 'Graduate'}`;

  const checked = Array.from(
    document.querySelectorAll('#placementTeacherCheckboxes input[type="checkbox"]:checked')
  ).map((cb, i) => ({ id: cb.value, name: cb.dataset.name, sort_order: i }));

  if (checked.length === 0) {
    alert('Please select at least one teacher for the board.');
    return;
  }

  const btn = document.getElementById('submitCreatePlacementBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const targetSizeRaw = document.getElementById('placementTargetSize')?.value;
  const targetClassSize = targetSizeRaw ? parseInt(targetSizeRaw, 10) || null : null;

  const { data: session, error: sessionErr } = await supabase
    .from('placement_sessions')
    .insert({
      school_id: _profile.school_id,
      academic_year: year,
      incoming_grade: incoming,
      target_grade: target,
      label,
      status: 'draft',
      target_class_size: targetClassSize,
    })
    .select('id')
    .single();

  if (sessionErr || !session) {
    console.error('Create session error:', sessionErr);
    alert('Failed to create session.');
    btn.disabled = false;
    btn.textContent = 'Create Session';
    return;
  }

  const { error: teachersErr } = await supabase.from('placement_session_teachers').insert(
    checked.map(t => ({ session_id: session.id, teacher_id: t.id, sort_order: t.sort_order }))
  );
  if (teachersErr) {
    console.error('Failed to attach teachers to session:', teachersErr);
    alert('Session created but teachers could not be attached. Please try again.');
    btn.disabled = false;
    btn.textContent = 'Create Session';
    return;
  }

  // Pre-populate assignments with all active students in the incoming grade (all unplaced)
  const { data: gradeStudents } = await supabase
    .from('students')
    .select('id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .eq('grade_level', incoming);

  if (gradeStudents && gradeStudents.length > 0) {
    const { error: assignErr } = await supabase.from('placement_assignments').insert(
      gradeStudents.map((s, i) => ({
        session_id: session.id,
        student_id: s.id,
        teacher_id: null,
        sort_order: i,
      }))
    );
    if (assignErr) console.error('Failed to pre-populate student assignments:', assignErr);
  }

  btn.disabled = false;
  btn.textContent = 'Create Session';
  document.getElementById('placementLabel').value = '';
  document.getElementById('placementIncomingGrade').value = '';
  const tsEl = document.getElementById('placementTargetSize');
  if (tsEl) tsEl.value = '';

  await showBoard(session.id);
}

/* ── Board ── */
async function showBoard(sessionId) {
  _currentSessionId = sessionId;
  _selectedStudentIds.clear();
  _undoStack = [];
  _boardSearchTerm = '';
  const searchEl = document.getElementById('placementBoardSearch');
  if (searchEl) searchEl.value = '';
  showView('placementBoardView');
  await loadBoardData(sessionId);
  renderBoard();
  updateSaveStatus('');
  updateUndoBtn();
}

async function loadBoardData(sessionId) {
  // Batch 1: all queries that only need sessionId or school_id
  const [
    { data: session },
    { data: sessionTeachers },
    { data: assignments },
    { data: flags }
  ] = await Promise.all([
    supabase.from('placement_sessions')
      .select('id, label, academic_year, incoming_grade, target_grade, status, target_class_size')
      .eq('id', sessionId)
      .eq('school_id', _profile.school_id)
      .single(),
    supabase.from('placement_session_teachers')
      .select('teacher_id, sort_order')
      .eq('session_id', sessionId).order('sort_order'),
    supabase.from('placement_assignments')
      .select('student_id, teacher_id, sort_order')
      .eq('session_id', sessionId).order('sort_order'),
    supabase.from('placement_flags')
      .select('id, label, color, sort_order')
      .eq('school_id', _profile.school_id).order('sort_order'),
  ]);

  _session = session;
  _flags   = flags || [];
  _targetClassSize = session?.target_class_size ?? null;

  const titleEl = document.getElementById('placementBoardTitle');
  const metaEl  = document.getElementById('placementBoardMeta');
  const commitBtn = document.getElementById('commitPlacementBtn');
  if (titleEl && session) titleEl.textContent = session.label;
  if (metaEl && session) {
    metaEl.textContent = `${session.academic_year.replace('-', '–')} · ${gradeLabel(session.incoming_grade)} → ${gradeLabel(session.target_grade)}`;
  }
  const isCommitted = session?.status === 'committed';
  if (commitBtn) {
    commitBtn.disabled = isCommitted;
    commitBtn.textContent = isCommitted ? 'Committed ✓' : 'Commit Placement';
  }
  const undoBtn = document.getElementById('undoCommitPlacementBtn');
  if (undoBtn) undoBtn.hidden = !isCommitted;
  const autoBtn = document.getElementById('autoPlacementBtn');
  if (autoBtn) autoBtn.disabled = isCommitted;

  // Derive IDs from batch 1 results
  const teacherIds = (sessionTeachers || []).map(r => r.teacher_id);
  _assignments = {};
  const studentIds = [];
  (assignments || []).forEach(a => {
    _assignments[a.student_id] = a.teacher_id ?? null;
    studentIds.push(a.student_id);
  });
  _savedAssignments = { ..._assignments };

  // Batch 2: queries that depend on batch 1 IDs (all run in parallel)
  const [empResult, stuResult, sFlagsResult] = await Promise.all([
    teacherIds.length
      ? supabase.from('employees').select('id, first_name, last_name').in('id', teacherIds)
      : Promise.resolve({ data: [] }),
    studentIds.length
      ? supabase.from('students').select('id, first_name, last_name, student_number, homeroom_teacher_id').in('id', studentIds)
      : Promise.resolve({ data: [] }),
    studentIds.length
      ? supabase.from('student_placement_flags').select('student_id, flag_id').in('student_id', studentIds)
      : Promise.resolve({ data: [] }),
  ]);

  if (teacherIds.length) {
    const empMap = Object.fromEntries((empResult.data || []).map(e => [e.id, e]));
    _teachers = (sessionTeachers || []).map(r => empMap[r.teacher_id]).filter(Boolean);
  } else {
    _teachers = [];
  }

  _students = stuResult.data || [];
  _students.sort((a, b) => a.last_name.localeCompare(b.last_name));

  _studentFlags = {};
  _students.forEach(s => { _studentFlags[s.id] = new Set(); });
  (sFlagsResult.data || []).forEach(sf => {
    if (_studentFlags[sf.student_id]) _studentFlags[sf.student_id].add(sf.flag_id);
  });

  // Batch 3: load names for homeroom teachers not already on this board
  _homeroomTeacherNames = {};
  _teachers.forEach(t => { _homeroomTeacherNames[t.id] = t.last_name; });
  const boardTeacherIds = new Set(_teachers.map(t => t.id));
  const extraHomeroomIds = [...new Set(
    _students.map(s => s.homeroom_teacher_id).filter(id => id && !boardTeacherIds.has(id))
  )];
  if (extraHomeroomIds.length) {
    const { data: extras } = await supabase
      .from('employees').select('id, last_name').in('id', extraHomeroomIds);
    (extras || []).forEach(e => { _homeroomTeacherNames[e.id] = e.last_name; });
  }
}

/* ── Render board ── */
function renderBoard() {
  const board = document.getElementById('placementBoard');
  if (!board) return;
  board.innerHTML = '';

  board.appendChild(buildColumn(null, 'Unplaced'));
  _teachers.forEach(t => board.appendChild(buildColumn(t.id, `${t.first_name} ${t.last_name}`)));
  if (window.lucide) lucide.createIcons({ nodes: [board] });
}

function buildColumn(teacherId, name) {
  const isUnplaced = teacherId === null;
  const allColStudents = _students.filter(s =>
    isUnplaced ? (_assignments[s.id] == null) : (_assignments[s.id] === teacherId)
  );

  // Search filter
  const term = _boardSearchTerm;
  const visibleStudents = term
    ? allColStudents.filter(s =>
        s.first_name.toLowerCase().includes(term) ||
        s.last_name.toLowerCase().includes(term) ||
        (s.student_number && String(s.student_number).toLowerCase().includes(term))
      )
    : allColStudents;

  const totalCount = allColStudents.length;
  const countDisplay = term ? `${visibleStudents.length}/${totalCount}` : totalCount;

  // Capacity indicator for teacher columns
  let capacityBarHtml = '';
  let countClass = '';
  if (!isUnplaced && _targetClassSize) {
    const pct = Math.min(100, Math.round((totalCount / _targetClassSize) * 100));
    const over  = totalCount > _targetClassSize * 1.15;
    const under = totalCount < _targetClassSize * 0.85 && totalCount > 0;
    const color = over ? '#ef4444' : under ? '#f59e0b' : '#22c55e';
    countClass = over ? 'capacity-over' : under ? 'capacity-under' : 'capacity-ok';
    capacityBarHtml = `<div class="placement-capacity-bar"><div style="width:${pct}%;background:${color};height:100%;border-radius:2px;transition:width .2s;"></div></div>`;
  }

  const col = document.createElement('div');
  col.className = 'placement-col';

  const dragHandle = !isUnplaced
    ? `<span class="col-drag-handle" title="Drag to reorder"><i data-lucide="grip-vertical" style="width:12px;height:12px;opacity:0.4;"></i></span>`
    : '';

  col.innerHTML = `
    <div class="placement-col-header ${isUnplaced ? 'col-unplaced' : 'col-teacher'}">
      ${dragHandle}
      <span class="placement-col-name">${esc(name)}</span>
      <span class="placement-col-count ${countClass}">${countDisplay}</span>
    </div>
    ${capacityBarHtml}
    <div class="placement-col-body" data-teacher-id="${teacherId ?? ''}"></div>
  `;

  // ── Column drag-to-reorder (teacher columns only) ──
  if (!isUnplaced) {
    const header = col.querySelector('.placement-col-header');
    header.draggable = true;
    header.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/x-placement-col', String(teacherId));
      e.dataTransfer.effectAllowed = 'move';
      _draggingColumnTeacherId = teacherId;
      col.classList.add('col-dragging');
    });
    header.addEventListener('dragend', () => {
      _draggingColumnTeacherId = null;
      col.classList.remove('col-dragging');
      document.querySelectorAll('.col-drop-target').forEach(el => el.classList.remove('col-drop-target'));
    });
    col.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes('text/x-placement-col')) return;
      if (_draggingColumnTeacherId === teacherId) return;
      e.preventDefault();
      col.classList.add('col-drop-target');
    });
    col.addEventListener('dragleave', e => {
      if (!col.contains(e.relatedTarget)) col.classList.remove('col-drop-target');
    });
    col.addEventListener('drop', e => {
      const draggedId = e.dataTransfer.getData('text/x-placement-col');
      if (!draggedId || draggedId === String(teacherId)) return;
      e.preventDefault();
      e.stopPropagation();
      col.classList.remove('col-drop-target');
      reorderColumn(draggedId, teacherId);
    });
  }

  const body = col.querySelector('.placement-col-body');

  body.addEventListener('dragover', e => {
    if (e.dataTransfer.types.includes('text/x-placement-col')) return; // column drag — ignore
    e.preventDefault();
    body.classList.add('drag-over');
  });
  body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
  body.addEventListener('drop', e => {
    if (e.dataTransfer.types.includes('text/x-placement-col')) return;
    e.preventDefault();
    body.classList.remove('drag-over');
    const raw = e.dataTransfer.getData('text/plain');
    if (raw) moveStudents(raw.split(','), teacherId);
  });
  body.addEventListener('click', e => {
    if (_selectedStudentIds.size && !e.target.closest('.placement-card')) {
      moveStudents([..._selectedStudentIds], teacherId);
    }
  });

  visibleStudents.forEach(s => body.appendChild(buildCard(s)));

  if (window.lucide) lucide.createIcons({ nodes: [col] });
  return col;
}

function buildCard(student) {
  const isSelected = _selectedStudentIds.has(student.id);
  const card = document.createElement('div');
  card.className = 'placement-card' + (isSelected ? ' selected' : '');
  card.dataset.studentId = student.id;
  card.draggable = true;

  const homeroomName = student.homeroom_teacher_id
    ? (_homeroomTeacherNames[student.homeroom_teacher_id] ?? null)
    : null;

  card.innerHTML = `
    <div class="placement-card-name">${esc(student.last_name)}, ${esc(student.first_name)}</div>
    ${homeroomName ? `<div class="placement-card-homeroom">${esc(homeroomName)}</div>` : ''}
    <div class="placement-card-footer">
      <div class="placement-flag-dots" data-dots-for="${student.id}"></div>
      <button class="placement-flag-btn" data-flag-for="${student.id}" title="Edit flags" tabindex="-1">
        <i data-lucide="tag" style="width:12px;height:12px;"></i>
      </button>
    </div>
  `;

  refreshFlagDots(card, student.id);

  card.addEventListener('dragstart', e => {
    // Drag this card + any others selected
    const ids = _selectedStudentIds.has(student.id) && _selectedStudentIds.size > 1
      ? [..._selectedStudentIds]
      : [student.id];
    e.dataTransfer.setData('text/plain', ids.join(','));
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
    clearSelection();
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  card.addEventListener('click', e => {
    if (e.target.closest('.placement-flag-btn')) return;
    e.stopPropagation();
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;
    if (!multi && _selectedStudentIds.has(student.id) && _selectedStudentIds.size === 1) {
      clearSelection();
    } else {
      selectCard(student.id, multi);
    }
  });

  card.querySelector('.placement-flag-btn').addEventListener('click', e => {
    e.stopPropagation();
    openFlagPopover(student.id, card);
  });

  return card;
}

function refreshFlagDots(cardEl, studentId) {
  const dotsEl = cardEl.querySelector(`[data-dots-for="${studentId}"]`);
  if (!dotsEl) return;
  dotsEl.innerHTML = '';
  const active = _studentFlags[studentId] || new Set();
  _flags.forEach(f => {
    if (!active.has(f.id)) return;
    const dot = document.createElement('span');
    dot.className = 'placement-flag-dot';
    dot.style.background = f.color;
    dot.title = f.label;
    dotsEl.appendChild(dot);
  });
}

/* ── Selection (click-to-move, multi-select) ── */
function selectCard(studentId, addToSelection = false) {
  if (addToSelection) {
    if (_selectedStudentIds.has(studentId)) _selectedStudentIds.delete(studentId);
    else _selectedStudentIds.add(studentId);
  } else {
    _selectedStudentIds.clear();
    _selectedStudentIds.add(studentId);
  }
  updateSelectionDisplay();
}

function clearSelection() {
  _selectedStudentIds.clear();
  updateSelectionDisplay();
}

function updateSelectionDisplay() {
  const n = _selectedStudentIds.size;
  document.querySelectorAll('.placement-card').forEach(card => {
    card.classList.toggle('selected', _selectedStudentIds.has(card.dataset.studentId));
  });
  document.querySelectorAll('.placement-col-body').forEach(b => {
    b.classList.toggle('click-target', n > 0);
  });
  const badge = document.getElementById('placementSelectionBadge');
  if (badge) {
    badge.textContent = n > 1 ? `${n} selected` : '';
    badge.hidden = n <= 1;
  }
}

/* ── Move students ── */
function moveStudents(studentIds, teacherId) {
  const ids = Array.isArray(studentIds) ? studentIds : [studentIds];
  const group = ids.map(id => ({ studentId: id, fromTeacherId: _assignments[id] ?? null }));
  _undoStack.push(group);
  if (_undoStack.length > 30) _undoStack.shift();
  ids.forEach(id => { _assignments[id] = teacherId; });
  logMoves(group, teacherId);
  clearSelection();
  renderBoard();
  scheduleSave();
  updateUndoBtn();
}

function logMoves(group, toTeacherId) {
  if (!_currentSessionId || !_profile) return;
  const changedByName = [_profile.first_name, _profile.last_name].filter(Boolean).join(' ') || (_profile.email ?? '');
  const teacherName = id => id ? (_teachers.find(t => t.id === id)?.last_name ?? null) : null;
  const studentName = id => { const s = _students.find(st => st.id === id); return s ? `${s.last_name}, ${s.first_name}` : id; };
  const records = group
    .filter(m => m.fromTeacherId !== toTeacherId) // skip no-ops
    .map(m => ({
      session_id:        _currentSessionId,
      school_id:         _profile.school_id,
      student_id:        m.studentId,
      student_name:      studentName(m.studentId),
      from_teacher_id:   m.fromTeacherId,
      from_teacher_name: teacherName(m.fromTeacherId),
      to_teacher_id:     toTeacherId,
      to_teacher_name:   teacherName(toTeacherId),
      changed_by_id:     _profile.id,
      changed_by_name:   changedByName,
    }));
  if (records.length) {
    supabase.from('placement_audit_log').insert(records).then(({ error }) => {
      if (error) console.warn('Audit log insert failed:', error);
    });
  }
}

function moveStudent(studentId, teacherId) {
  moveStudents([studentId], teacherId);
}

/* ── Undo move ── */
function undoLastMove() {
  if (_undoStack.length === 0) return;
  const group = _undoStack.pop();
  group.forEach(({ studentId, fromTeacherId }) => { _assignments[studentId] = fromTeacherId; });
  clearSelection();
  renderBoard();
  scheduleSave();
  updateUndoBtn();
}

function updateUndoBtn() {
  const btn = document.getElementById('undoPlacementMoveBtn');
  if (btn) btn.disabled = _undoStack.length === 0;
}

/* ── Column reorder ── */
function reorderColumn(draggedTeacherId, targetTeacherId) {
  const fromIdx = _teachers.findIndex(t => t.id === draggedTeacherId);
  const toIdx   = _teachers.findIndex(t => t.id === targetTeacherId);
  if (fromIdx === -1 || toIdx === -1) return;
  const reordered = [..._teachers];
  const [moved] = reordered.splice(fromIdx, 1);
  reordered.splice(toIdx, 0, moved);
  _teachers = reordered;
  renderBoard();
  persistColumnOrder();
}

async function persistColumnOrder() {
  if (!_currentSessionId) return;
  await supabase.from('placement_session_teachers').upsert(
    _teachers.map((t, i) => ({ session_id: _currentSessionId, teacher_id: t.id, sort_order: i })),
    { onConflict: 'session_id,teacher_id' }
  );
}

/* ── Audit log ── */
async function openAuditLog() {
  const panel = document.getElementById('placementAuditPanel');
  const body  = document.getElementById('placementAuditBody');
  if (!panel || !body) return;
  panel.hidden = false;
  body.innerHTML = '<p class="muted" style="font-size:13px;padding:16px 0;">Loading…</p>';

  const { data, error } = await supabase
    .from('placement_audit_log')
    .select('student_name, from_teacher_name, to_teacher_name, changed_by_name, changed_at')
    .eq('session_id', _currentSessionId)
    .order('changed_at', { ascending: false })
    .limit(200);

  if (error || !data?.length) {
    body.innerHTML = `<div class="placement-audit-empty">${error ? 'Failed to load history.' : 'No moves recorded yet.'}</div>`;
    return;
  }

  body.innerHTML = `
    <table class="placement-audit-table">
      <thead><tr>
        <th>When</th><th>Student</th><th>Move</th><th>By</th>
      </tr></thead>
      <tbody>
        ${data.map(r => `
          <tr>
            <td style="white-space:nowrap;">${new Date(r.changed_at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</td>
            <td>${esc(r.student_name)}</td>
            <td>${esc(r.from_teacher_name ?? 'Unplaced')} → ${esc(r.to_teacher_name ?? 'Unplaced')}</td>
            <td>${esc(r.changed_by_name ?? '')}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function closeAuditLog() {
  const panel = document.getElementById('placementAuditPanel');
  if (panel) panel.hidden = true;
}

/* ── Flag popover ── */
function openFlagPopover(studentId, card) {
  const existing = document.getElementById('placementFlagPopover');
  if (existing) {
    existing.remove();
    if (_flagPopoverStudentId === studentId) {
      _flagPopoverStudentId = null;
      return;
    }
  }

  _flagPopoverStudentId = studentId;

  const flagBtn = card.querySelector('.placement-flag-btn');
  const btnRect = flagBtn.getBoundingClientRect();

  const pop = document.createElement('div');
  pop.id = 'placementFlagPopover';
  pop.className = 'placement-flag-popover';

  const activeFlags = _flags.filter(f => !f.archived_at);
  if (activeFlags.length === 0) {
    pop.innerHTML = '<span class="muted" style="font-size:12px;padding:2px 0;">No flags configured.</span>';
  } else {
    const active = _studentFlags[studentId] || new Set();
    activeFlags.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'placement-flag-toggle' + (active.has(f.id) ? ' active' : '');
      btn.innerHTML = `<span class="placement-flag-dot" style="background:${f.color};width:10px;height:10px;display:inline-block;border-radius:50%;flex-shrink:0;"></span>${esc(f.label)}`;
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await toggleFlag(studentId, f.id);
        refreshFlagDots(card, studentId);
        btn.classList.toggle('active', (_studentFlags[studentId] || new Set()).has(f.id));
      });
      pop.appendChild(btn);
    });
  }

  // Attach to body so it escapes all overflow clipping
  document.body.appendChild(pop);

  // Estimate height then decide whether to open above or below
  const estimatedHeight = activeFlags.length * 34 + 16;
  const spaceBelow = window.innerHeight - btnRect.bottom;
  const openAbove = spaceBelow < estimatedHeight + 8 && btnRect.top > estimatedHeight + 8;

  // Align right edge of popover to right edge of button, clamped to viewport
  const rightEdge = btnRect.right;
  const popWidth = 160;
  const left = Math.max(8, Math.min(rightEdge - popWidth, window.innerWidth - popWidth - 8));

  pop.style.position = 'fixed';
  pop.style.zIndex = '9999';
  pop.style.left = left + 'px';

  if (openAbove) {
    pop.style.bottom = (window.innerHeight - btnRect.top + 4) + 'px';
    pop.style.top = 'auto';
  } else {
    pop.style.top = (btnRect.bottom + 4) + 'px';
    pop.style.bottom = 'auto';
  }

  setTimeout(() => {
    const close = e => {
      if (!pop.contains(e.target) && !flagBtn.contains(e.target)) {
        pop.remove();
        _flagPopoverStudentId = null;
        document.removeEventListener('click', close, true);
      }
    };
    document.addEventListener('click', close, true);
  }, 0);
}

async function toggleFlag(studentId, flagId) {
  const flags = _studentFlags[studentId] ?? new Set();
  if (flags.has(flagId)) {
    flags.delete(flagId);
    await supabase.from('student_placement_flags')
      .delete()
      .eq('student_id', studentId)
      .eq('flag_id', flagId);
  } else {
    flags.add(flagId);
    await supabase.from('student_placement_flags')
      .upsert({ student_id: studentId, flag_id: flagId });
  }
  _studentFlags[studentId] = flags;
}

/* ── Auto-save ── */
function scheduleSave() {
  updateSaveStatus('Saving…');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveAssignments, 900);
}

async function saveAssignments() {
  if (!_currentSessionId || !_students.length) return;

  const changed = _students.filter(s => _assignments[s.id] !== _savedAssignments[s.id]);
  if (!changed.length) { updateSaveStatus(''); return; }

  const rows = changed.map(s => ({
    session_id: _currentSessionId,
    student_id: s.id,
    teacher_id: _assignments[s.id] ?? null,
    sort_order:  _students.indexOf(s),
  }));

  const { error } = await supabase
    .from('placement_assignments')
    .upsert(rows, { onConflict: 'session_id,student_id' });

  if (error) {
    console.error('Placement auto-save error:', error);
    updateSaveStatus('⚠ Save failed — changes may be lost');
    // Leave the error visible until the next successful save or page reload
  } else {
    changed.forEach(s => { _savedAssignments[s.id] = _assignments[s.id]; });
    updateSaveStatus('Saved ✓');
    setTimeout(() => updateSaveStatus(''), 2500);
  }
}

function updateSaveStatus(msg) {
  const el = document.getElementById('placementSaveStatus');
  if (el) el.textContent = msg;
}

/* ── Export ── */
function exportPlacement() {
  if (!_session) return;
  const rows = [['Last Name', 'First Name', 'Student Number', 'Incoming Grade', 'Assigned Teacher']];
  _students
    .slice()
    .sort((a, b) => {
      const ta = _assignments[a.id] ? (_teachers.find(t => t.id === _assignments[a.id])?.last_name ?? '') : '￿';
      const tb = _assignments[b.id] ? (_teachers.find(t => t.id === _assignments[b.id])?.last_name ?? '') : '￿';
      return ta !== tb ? ta.localeCompare(tb) : a.last_name.localeCompare(b.last_name);
    })
    .forEach(s => {
      const teacher = _assignments[s.id] ? _teachers.find(t => t.id === _assignments[s.id]) : null;
      rows.push([
        s.last_name,
        s.first_name,
        s.student_number ?? '',
        _session.incoming_grade,
        teacher ? `${teacher.last_name}, ${teacher.first_name}` : '(Unplaced)',
      ]);
    });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(_session.label ?? 'placement').replace(/[^\w\s-]/g, '').trim()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── Undo Commit ── */
async function confirmUndoCommit() {
  if (!_session || _session.status !== 'committed') return;

  const placed = Object.values(_assignments).filter(v => v != null).length;
  const confirmed = confirm(
    `Undo commit for "${_session.label}"?\n\n` +
    `This will restore the previous homeroom teacher for ${placed} student${placed !== 1 ? 's' : ''} and revert the session to Draft.\n\n` +
    `Students who had no homeroom teacher before this commit will be set back to none.`
  );
  if (!confirmed) return;
  await runUndoCommit();
}

async function runUndoCommit() {
  const undoBtn   = document.getElementById('undoCommitPlacementBtn');
  const commitBtn = document.getElementById('commitPlacementBtn');
  if (undoBtn) { undoBtn.disabled = true; undoBtn.textContent = 'Reverting…'; }

  // Load the saved prev_homeroom_teacher_id values
  const placedStudentIds = Object.entries(_assignments)
    .filter(([, tid]) => tid != null)
    .map(([sid]) => sid);

  const { data: prevData, error: loadErr } = await supabase
    .from('placement_assignments')
    .select('student_id, prev_homeroom_teacher_id')
    .eq('session_id', _currentSessionId)
    .in('student_id', placedStudentIds);

  if (loadErr) {
    alert('Failed to load previous homeroom data. Cannot undo.');
    if (undoBtn) { undoBtn.disabled = false; undoBtn.textContent = 'Undo Commit'; }
    return;
  }

  // Group by prev teacher (null = clear homeroom)
  const byPrev = {};
  const nullStudents = [];
  const prevMap = Object.fromEntries((prevData || []).map(r => [r.student_id, r.prev_homeroom_teacher_id]));

  placedStudentIds.forEach(sid => {
    const prev = prevMap[sid] ?? null;
    if (prev) {
      if (!byPrev[prev]) byPrev[prev] = [];
      byPrev[prev].push(sid);
    } else {
      nullStudents.push(sid);
    }
  });

  const errors = [];
  for (const [tid, sids] of Object.entries(byPrev)) {
    const { error } = await supabase.from('students')
      .update({ homeroom_teacher_id: tid })
      .eq('school_id', _profile.school_id)
      .in('id', sids);
    if (error) errors.push(error);
  }
  if (nullStudents.length) {
    const { error } = await supabase.from('students')
      .update({ homeroom_teacher_id: null })
      .eq('school_id', _profile.school_id)
      .in('id', nullStudents);
    if (error) errors.push(error);
  }

  if (errors.length) {
    console.error('Undo commit errors:', errors);
    alert('Some reversions failed. Check the console for details.');
    if (undoBtn) { undoBtn.disabled = false; undoBtn.textContent = 'Undo Commit'; }
    return;
  }

  await supabase
    .from('placement_sessions')
    .update({ status: 'draft', committed_at: null })
    .eq('id', _currentSessionId);

  _session.status = 'draft';
  if (undoBtn)   { undoBtn.hidden = true; undoBtn.disabled = false; undoBtn.textContent = 'Undo Commit'; }
  if (commitBtn) { commitBtn.disabled = false; commitBtn.textContent = 'Commit Placement'; }
  const autoBtn = document.getElementById('autoPlacementBtn');
  if (autoBtn) autoBtn.disabled = false;

  alert('Commit reverted. Session is back in Draft.');
}

/* ── Auto-place ── */
function autoPlaceStudents() {
  if (_session?.status === 'committed') return;
  if (_teachers.length === 0) {
    alert('No teachers on this board to place students into.');
    return;
  }

  const unplaced = _students.filter(s => _assignments[s.id] == null);
  let studentsToPlace;

  if (unplaced.length === 0) {
    const per = Math.ceil(_students.length / _teachers.length);
    const ok = confirm(
      `All ${_students.length} students are already placed.\n\n` +
      `Redistribute everyone evenly across ${_teachers.length} teacher${_teachers.length !== 1 ? 's' : ''} (~${per} per teacher)?\n\n` +
      `Current placements will be cleared.`
    );
    if (!ok) return;
    _students.forEach(s => { _assignments[s.id] = null; });
    studentsToPlace = [..._students];
  } else {
    const per = Math.ceil(unplaced.length / _teachers.length);
    const ok = confirm(
      `Distribute ${unplaced.length} unplaced student${unplaced.length !== 1 ? 's' : ''} evenly across ${_teachers.length} teacher${_teachers.length !== 1 ? 's' : ''} (~${per} per teacher)?`
    );
    if (!ok) return;
    studentsToPlace = unplaced;
  }

  // Round-robin across teachers, preserving alphabetical sort within each column
  studentsToPlace.forEach((s, i) => {
    _assignments[s.id] = _teachers[i % _teachers.length].id;
  });

  renderBoard();
  scheduleSave();
}

/* ── Fullscreen ── */
function toggleFullscreen() {
  const view = document.getElementById('placementBoardView');
  if (!view) return;

  if (view.classList.contains('placement-fullscreen')) {
    exitFullscreen();
  } else {
    // Reparent to body to escape ancestor transform containing blocks
    view._fsParent = view.parentElement;
    view._fsAnchor = view.nextSibling;
    document.body.appendChild(view);
    view.classList.add('placement-fullscreen');
    document.body.classList.add('placement-fs');
    setFullscreenIcon(true);
  }
}

function exitFullscreen() {
  const view = document.getElementById('placementBoardView');
  if (!view?.classList.contains('placement-fullscreen')) return;

  view.classList.remove('placement-fullscreen');
  document.body.classList.remove('placement-fs');

  // Restore to original position in DOM
  if (view._fsParent) {
    view._fsParent.insertBefore(view, view._fsAnchor ?? null);
    delete view._fsParent;
    delete view._fsAnchor;
  }

  setFullscreenIcon(false);
}

function toggleCompact() {
  const board = document.getElementById('placementBoard');
  const btn   = document.getElementById('togglePlacementDensity');
  if (!board || !btn) return;
  const compact = board.classList.toggle('placement-board--compact');
  btn.style.color = compact ? 'var(--primary)' : '';
  btn.style.borderColor = compact ? 'var(--primary)' : '';
}

function setFullscreenIcon(isFs) {
  const btn = document.getElementById('togglePlacementFullscreen');
  if (!btn) return;
  btn.title = isFs ? 'Exit fullscreen' : 'Expand board';
  btn.innerHTML = isFs
    ? '<i data-lucide="shrink" style="width:15px;height:15px;"></i>'
    : '<i data-lucide="expand" style="width:15px;height:15px;"></i>';
  if (window.lucide) lucide.createIcons({ nodes: Array.from(btn.querySelectorAll('[data-lucide]')) });
}

/* ── Commit ── */
async function confirmCommit() {
  if (!_session || _session.status === 'committed') return;

  const placed   = Object.values(_assignments).filter(v => v != null).length;
  const unplaced = _students.length - placed;
  const warnings = validatePlacement();

  const warningText = warnings.length
    ? `\n⚠ Warnings:\n${warnings.map(w => `  • ${w}`).join('\n')}\n`
    : '';

  const confirmed = confirm(
    `Commit class placement for "${_session.label}"?\n\n` +
    `  • ${placed} student${placed !== 1 ? 's' : ''} will have homeroom teacher updated\n` +
    (unplaced > 0 ? `  • ${unplaced} student${unplaced !== 1 ? 's' : ''} left unplaced (no change)\n` : '') +
    warningText +
    `\nThis updates homeroom_teacher_id for all placed students.`
  );
  if (!confirmed) return;

  await runCommit();
}

function validatePlacement() {
  const warnings = [];

  // Unplaced students
  const unplacedCount = _students.filter(s => _assignments[s.id] == null).length;
  if (unplacedCount > 0) warnings.push(`${unplacedCount} student${unplacedCount !== 1 ? 's' : ''} unplaced`);

  // Class size vs target
  if (_targetClassSize) {
    _teachers.forEach(t => {
      const count = _students.filter(s => _assignments[s.id] === t.id).length;
      if (count > Math.ceil(_targetClassSize * 1.2))
        warnings.push(`${t.last_name}'s class: ${count} students (target ${_targetClassSize})`);
      else if (count > 0 && count < Math.floor(_targetClassSize * 0.8))
        warnings.push(`${t.last_name}'s class: only ${count} students (target ${_targetClassSize})`);
    });
  }

  // Flag separation: same flag applied to 2+ students in one teacher's column
  const activeFlags = _flags.filter(f => !f.archived_at);
  activeFlags.forEach(flag => {
    _teachers.forEach(t => {
      const concentrated = _students.filter(s =>
        _assignments[s.id] === t.id && _studentFlags[s.id]?.has(flag.id)
      );
      if (concentrated.length >= 2) {
        warnings.push(
          `Flag "${flag.label}": ${concentrated.length} students in ${t.last_name}'s class ` +
          `(${concentrated.map(s => s.first_name).join(', ')})`
        );
      }
    });
  });

  return warnings;
}

async function runCommit() {
  const btn     = document.getElementById('commitPlacementBtn');
  const undoBtn = document.getElementById('undoCommitPlacementBtn');
  btn.disabled = true;
  btn.textContent = 'Committing…';

  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await saveAssignments();

  const placedEntries = Object.entries(_assignments).filter(([, tid]) => tid != null);
  const placedStudentIds = placedEntries.map(([sid]) => sid);

  // Snapshot current homeroom_teacher_id so undo can restore it
  const { data: currentHomerooms } = await supabase
    .from('students')
    .select('id, homeroom_teacher_id')
    .eq('school_id', _profile.school_id)
    .in('id', placedStudentIds);

  if (currentHomerooms?.length) {
    const prevRows = currentHomerooms.map(s => ({
      session_id: _currentSessionId,
      student_id: s.id,
      prev_homeroom_teacher_id: s.homeroom_teacher_id ?? null,
    }));
    await supabase
      .from('placement_assignments')
      .upsert(prevRows, { onConflict: 'session_id,student_id' });
  }

  // Write new homeroom_teacher_id, grouped by teacher for efficiency
  const byTeacher = {};
  placedEntries.forEach(([sid, tid]) => {
    if (!byTeacher[tid]) byTeacher[tid] = [];
    byTeacher[tid].push(sid);
  });

  const errors = [];
  for (const [tid, sids] of Object.entries(byTeacher)) {
    const { error } = await supabase
      .from('students')
      .update({ homeroom_teacher_id: tid })
      .eq('school_id', _profile.school_id)
      .in('id', sids);
    if (error) errors.push(error);
  }

  if (errors.length) {
    console.error('Placement commit errors:', errors);
    alert('Some student updates failed. Check the console for details.');
    btn.disabled = false;
    btn.textContent = 'Commit Placement';
    return;
  }

  await supabase
    .from('placement_sessions')
    .update({ status: 'committed', committed_at: new Date().toISOString() })
    .eq('id', _currentSessionId);

  _session.status = 'committed';
  btn.textContent = 'Committed ✓';
  if (undoBtn) undoBtn.hidden = false;
  updateSaveStatus('');

  const placed = placedEntries.length;
  alert(`Done! ${placed} student${placed !== 1 ? 's' : ''} assigned to their homeroom teacher.`);
}

/* ── Flag editor ── */
const FLAG_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#3b82f6','#8b5cf6','#ec4899','#64748b',
  '#06b6d4','#10b981',
];
let _newFlagColor = FLAG_COLORS[4];

function openFlagEditor() {
  _newFlagColor = FLAG_COLORS[4];
  const dot = document.getElementById('newFlagColorDot');
  if (dot) dot.style.background = _newFlagColor;
  const input = document.getElementById('newFlagLabel');
  if (input) input.value = '';
  const picker = document.getElementById('newFlagColorPickerEl');
  if (picker) picker.hidden = true;
  renderFlagEditorList();
  document.getElementById('placementFlagEditorModal').hidden = false;
}

function closeFlagEditor() {
  document.getElementById('placementFlagEditorModal').hidden = true;
  renderBoard();
}

function renderFlagEditorList() {
  const list = document.getElementById('flagEditorList');
  if (!list) return;
  list.innerHTML = '';

  const activeFlags   = _flags.filter(f => !f.archived_at);
  const archivedFlags = _flags.filter(f =>  f.archived_at);

  if (activeFlags.length === 0 && archivedFlags.length === 0) {
    list.innerHTML = '<p class="muted" style="font-size:13px;padding:4px 0 8px;">No flags yet. Create one below.</p>';
    return;
  }

  const appendRow = (f, archived) => {
    const row = document.createElement('div');
    row.className = 'flag-editor-row' + (archived ? ' flag-editor-row--archived' : '');
    row.dataset.flagId = f.id;

    if (!archived) {
      const colorDot = document.createElement('button');
      colorDot.className = 'flag-editor-color-dot';
      colorDot.style.background = f.color;
      colorDot.title = 'Change color';

      const colorPicker = document.createElement('div');
      colorPicker.className = 'flag-color-picker';
      colorPicker.hidden = true;
      buildColorPicker(colorPicker, f.color, async newColor => {
        colorDot.style.background = newColor;
        colorPicker.hidden = true;
        const { error } = await supabase.from('placement_flags').update({ color: newColor }).eq('id', f.id);
        if (!error) {
          f.color = newColor;
          document.querySelectorAll(`.placement-flag-dot[title="${esc(f.label)}"]`)
            .forEach(d => { d.style.background = newColor; });
        }
      });
      colorDot.addEventListener('click', e => {
        e.stopPropagation();
        const wasHidden = colorPicker.hidden;
        document.querySelectorAll('.flag-color-picker').forEach(p => { p.hidden = true; });
        colorPicker.hidden = !wasHidden;
      });
      row.appendChild(colorDot);
      row.appendChild(colorPicker);
    } else {
      const dot = document.createElement('span');
      dot.className = 'flag-editor-color-dot flag-editor-color-dot--static';
      dot.style.background = f.color;
      row.appendChild(dot);
    }

    const labelInput = document.createElement('input');
    labelInput.className = 'form-input flag-editor-input';
    labelInput.value = f.label;
    labelInput.disabled = archived;
    if (!archived) {
      labelInput.addEventListener('keydown', e => { if (e.key === 'Enter') labelInput.blur(); });
      labelInput.addEventListener('blur', async () => {
        const newLabel = labelInput.value.trim();
        if (!newLabel || newLabel === f.label) { labelInput.value = f.label; return; }
        const { error } = await supabase.from('placement_flags').update({ label: newLabel }).eq('id', f.id);
        if (error) { alert('Failed to rename flag.'); labelInput.value = f.label; }
        else { f.label = newLabel; }
      });
    }

    const actionBtn = document.createElement('button');
    if (archived) {
      actionBtn.className = 'btn btn-sm flag-restore-btn';
      actionBtn.title = 'Restore flag';
      actionBtn.innerHTML = '<i data-lucide="rotate-ccw" style="width:13px;height:13px;"></i>';
      actionBtn.addEventListener('click', async () => {
        const { error } = await supabase.from('placement_flags').update({ archived_at: null }).eq('id', f.id);
        if (error) { alert('Failed to restore flag.'); return; }
        f.archived_at = null;
        renderFlagEditorList();
      });
    } else {
      actionBtn.className = 'btn btn-sm flag-delete-btn';
      actionBtn.title = 'Archive flag';
      actionBtn.innerHTML = '<i data-lucide="archive" style="width:13px;height:13px;"></i>';
      actionBtn.addEventListener('click', async () => {
        const usedBy = Object.values(_studentFlags).filter(s => s.has(f.id)).length;
        const msg = usedBy > 0
          ? `Archive flag "${f.label}"?\n\nIt is applied to ${usedBy} student${usedBy !== 1 ? 's' : ''} in this and all sessions. Students keep their flag data — it just won't appear in future sessions.`
          : `Archive flag "${f.label}"?\n\nIt won't appear in future sessions but historical data is preserved.`;
        if (!confirm(msg)) return;
        const now = new Date().toISOString();
        const { error } = await supabase.from('placement_flags').update({ archived_at: now }).eq('id', f.id);
        if (error) { alert('Failed to archive flag.'); return; }
        f.archived_at = now;
        renderFlagEditorList();
        renderBoard(); // remove archived flag dots from cards
      });
    }

    row.appendChild(labelInput);
    row.appendChild(actionBtn);
    list.appendChild(row);

    if (window.lucide) lucide.createIcons({ nodes: Array.from(row.querySelectorAll('[data-lucide]')) });
  };

  activeFlags.forEach(f => appendRow(f, false));

  if (archivedFlags.length > 0) {
    const divider = document.createElement('p');
    divider.className = 'muted flag-editor-archived-label';
    divider.textContent = 'Archived';
    list.appendChild(divider);
    archivedFlags.forEach(f => appendRow(f, true));
  }
}

function buildColorPicker(container, currentColor, onSelect) {
  container.innerHTML = '';
  FLAG_COLORS.forEach(c => {
    const swatch = document.createElement('button');
    swatch.className = 'flag-color-swatch' + (c === currentColor ? ' selected' : '');
    swatch.style.background = c;
    swatch.title = c;
    swatch.addEventListener('click', e => { e.stopPropagation(); onSelect(c); });
    container.appendChild(swatch);
  });
}

function toggleColorPicker(pickerId, currentColor, onSelect) {
  const picker = document.getElementById(pickerId);
  if (!picker) return;
  const wasHidden = picker.hidden;
  document.querySelectorAll('.flag-color-picker').forEach(p => { p.hidden = true; });
  if (!wasHidden) return;
  buildColorPicker(picker, currentColor, c => { onSelect(c); picker.hidden = true; buildColorPicker(picker, c, onSelect); });
  picker.hidden = false;
}

async function addFlag() {
  const label = document.getElementById('newFlagLabel')?.value.trim();
  if (!label) { document.getElementById('newFlagLabel')?.focus(); return; }

  const { data, error } = await supabase
    .from('placement_flags')
    .insert({ school_id: _profile.school_id, label, color: _newFlagColor, sort_order: _flags.length })
    .select('id, label, color, sort_order')
    .single();

  if (error) { alert('Failed to create flag.'); return; }

  _flags.push(data);
  document.getElementById('newFlagLabel').value = '';
  _newFlagColor = FLAG_COLORS[4];
  const dot = document.getElementById('newFlagColorDot');
  if (dot) dot.style.background = _newFlagColor;
  renderFlagEditorList();
}

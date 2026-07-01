import { supabase } from './admin.supabase.js';
import { esc, GRADE_ORDER, nextGrade, gradeLabel, loadSchoolConfig, showToast } from './admin.shared.js';
import {
  initSessions, showSessionList, showCreateForm, renderSessionList,
  setShowArchived, submitCreateForm,
} from './admin.placement.sessions.js';

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
let _managingColId = null;
let _placeholderColIds = new Set(); // PST row IDs that are placeholder columns
let _resolvingColId = null;         // col ID being resolved in Assign Teacher modal
let _manuallyAddedIds = new Set(); // student IDs added via "Add Student" (not auto-pulled by grade)

/* ── Entry point ── */
export async function initPlacementSection(profile) {
  _profile = profile;

  if (!profile.is_superadmin && !profile.can_manage_placement) {
    document.getElementById('placementSessionListView').innerHTML =
      '<p class="muted" style="padding:1rem;">You do not have permission to manage class placement.</p>';
    return;
  }

  _schoolConfig = await loadSchoolConfig(_profile.school_id);
  initSessions(_profile, _schoolConfig);

  if (!_initialized) {
    _initialized = true;
    wireGlobalEvents();
    document.addEventListener('placement:show-board', e => showBoard(e.detail.sessionId));
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
  document.getElementById('showArchivedSessionsToggle')
    ?.addEventListener('change', e => { setShowArchived(e.target.checked); renderSessionList(); });
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
  document.getElementById('removeFromBoardBtn')
    ?.addEventListener('click', removeSelectedFromBoard);
  document.getElementById('addStudentToBoardBtn')
    ?.addEventListener('click', openAddStudentModal);
  document.getElementById('cancelAddStudentBtn')
    ?.addEventListener('click', () => { document.getElementById('addStudentModal').hidden = true; });
  document.getElementById('addStudentSearch')
    ?.addEventListener('input', e => {
      clearTimeout(_addStudentDebounce);
      _addStudentDebounce = setTimeout(() => runAddStudentSearch(e.target.value.trim()), 250);
    });
  document.getElementById('syncPlacementStudentsBtn')
    ?.addEventListener('click', openSyncStudentsModal);
  document.getElementById('syncStudentsConfirmBtn')
    ?.addEventListener('click', executeSyncStudents);
  document.getElementById('syncStudentsCancelBtn')
    ?.addEventListener('click', () => { document.getElementById('syncStudentsModal').hidden = true; });
  document.getElementById('addPlacementColumnBtn')
    ?.addEventListener('click', openAddColumnModal);
  document.getElementById('cancelAddColumnBtn')
    ?.addEventListener('click', closeAddColumnModal);
  document.getElementById('submitAddColumnBtn')
    ?.addEventListener('click', submitAddColumn);
  document.getElementById('cancelAssignTeacherBtn')
    ?.addEventListener('click', closeAssignTeacherModal);
  document.getElementById('submitAssignTeacherBtn')
    ?.addEventListener('click', submitAssignTeacher);
  document.getElementById('manageColCancelBtn')
    ?.addEventListener('click', closeManageColumnModal);
  document.getElementById('manageColReplaceBtn')
    ?.addEventListener('click', showManageReplacePanel);
  document.getElementById('manageColBackBtn')
    ?.addEventListener('click', () => {
      document.getElementById('manageColChoicePanel').hidden = false;
      document.getElementById('manageColReplacePanel').hidden = true;
    });
  document.getElementById('manageColRemoveBtn')
    ?.addEventListener('click', confirmRemoveColumn);
  document.getElementById('manageColConfirmReplaceBtn')
    ?.addEventListener('click', confirmReplaceColumnTeacher);
  document.getElementById('addColTypeReal')
    ?.addEventListener('change', () => {
      document.getElementById('addColRealPanel').hidden = false;
      document.getElementById('addColPlaceholderPanel').hidden = true;
    });
  document.getElementById('addColTypePlaceholder')
    ?.addEventListener('change', () => {
      document.getElementById('addColRealPanel').hidden = true;
      document.getElementById('addColPlaceholderPanel').hidden = false;
    });
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
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      if (document.getElementById('placementBoardView')?.hidden === false) {
        e.preventDefault();
        undoLastMove();
      }
    }
  });

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) exitFullscreen();
  });

  // If the tab was hidden (user switched away) and another admin may have edited the same
  // session, the in-memory undo stack could reference stale teacher/student positions.
  // Clear it on visibility restore to prevent incorrect undos from corrupting placements.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && _currentSessionId && _undoStack.length > 0) {
      _undoStack = [];
      updateUndoBtn();
      updateSaveStatus('Undo history cleared after tab switch');
      setTimeout(() => updateSaveStatus(''), 3000);
    }
  });
}

/* ── Session list / create form — see admin.placement.sessions.js ── */

/* ── Board ── */
async function showBoard(sessionId) {
  _currentSessionId = sessionId;
  _selectedStudentIds.clear();
  _undoStack = [];
  _boardSearchTerm = '';
  _placeholderColIds = new Set();
  _manuallyAddedIds = new Set();
  const searchEl = document.getElementById('placementBoardSearch');
  if (searchEl) searchEl.value = '';
  showView('placementBoardView');

  // Ghost columns while data loads
  const board = document.getElementById('placementBoard');
  if (board) {
    board.innerHTML = Array.from({ length: 3 }, () => `
      <div class="placement-col" style="opacity:.4;pointer-events:none;">
        <div class="placement-col-header col-teacher">
          <span class="teacher-avatar" style="background:#dde3ec;"></span>
          <span style="display:inline-block;width:76px;height:13px;border-radius:4px;background:#dde3ec;"></span>
        </div>
        <div class="placement-col-body">
          ${Array.from({ length: 5 }, () => `
            <div class="placement-card">
              <div style="width:74%;height:13px;border-radius:3px;background:#edf0f5;margin-bottom:7px;"></div>
              <div style="width:44%;height:11px;border-radius:3px;background:#f1f4f8;"></div>
            </div>`).join('')}
        </div>
      </div>`).join('');
  }

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
      .select('id, teacher_id, placeholder_name, sort_order')
      .eq('session_id', sessionId).order('sort_order'),
    supabase.from('placement_assignments')
      .select('student_id, teacher_id, assigned_col_id, sort_order, manually_added')
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
    metaEl.textContent = `${session.academic_year.replace('-', '–')} · ${gradeLabel(session.incoming_grade)}`;
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
  const addColBtn = document.getElementById('addPlacementColumnBtn');
  if (addColBtn) addColBtn.disabled = isCommitted;

  // Derive IDs from batch 1 results
  // Separate real teachers from placeholder rows
  _placeholderColIds = new Set();
  const realTeacherRows = (sessionTeachers || []).filter(r => r.teacher_id);
  const placeholderRows = (sessionTeachers || []).filter(r => !r.teacher_id);
  placeholderRows.forEach(r => _placeholderColIds.add(r.id));

  const teacherIds = realTeacherRows.map(r => r.teacher_id);
  _assignments = {};
  _manuallyAddedIds = new Set();
  const studentIds = [];
  (assignments || []).forEach(a => {
    if (a.teacher_id) {
      _assignments[a.student_id] = a.teacher_id;
    } else if (a.assigned_col_id) {
      _assignments[a.student_id] = a.assigned_col_id;
    } else {
      _assignments[a.student_id] = null;
    }
    studentIds.push(a.student_id);
    if (a.manually_added) _manuallyAddedIds.add(a.student_id);
  });
  _savedAssignments = { ..._assignments };

  // Batch 2: queries that depend on batch 1 IDs (all run in parallel)
  const [empResult, stuResult, sFlagsResult] = await Promise.all([
    teacherIds.length
      ? supabase.from('employees').select('id, first_name, last_name').in('id', teacherIds)
      : Promise.resolve({ data: [] }),
    studentIds.length
      ? supabase.from('students').select('id, first_name, last_name, student_number, grade_level, homeroom_teacher_id, is_retained').in('id', studentIds)
      : Promise.resolve({ data: [] }),
    studentIds.length
      ? supabase.from('student_placement_flags').select('student_id, flag_id').in('student_id', studentIds)
      : Promise.resolve({ data: [] }),
  ]);

  const empMap = Object.fromEntries((empResult.data || []).map(e => [e.id, e]));
  _teachers = (sessionTeachers || []).map(row => {
    if (row.teacher_id) {
      const emp = empMap[row.teacher_id];
      if (!emp) return null;
      return { id: row.teacher_id, first_name: emp.first_name, last_name: emp.last_name, isPlaceholder: false, _rowId: row.id };
    } else {
      return { id: row.id, placeholder_name: row.placeholder_name || 'Open Position', isPlaceholder: true, _rowId: row.id };
    }
  }).filter(Boolean);

  _students = stuResult.data || [];
  _students.sort((a, b) => a.last_name.localeCompare(b.last_name));

  _studentFlags = {};
  _students.forEach(s => { _studentFlags[s.id] = new Set(); });
  (sFlagsResult.data || []).forEach(sf => {
    if (_studentFlags[sf.student_id]) _studentFlags[sf.student_id].add(sf.flag_id);
  });

  // Batch 3: load names for homeroom teachers not already on this board
  _homeroomTeacherNames = {};
  _teachers.forEach(t => {
    if (!t.isPlaceholder) _homeroomTeacherNames[t.id] = t.last_name;
  });
  const boardTeacherIds = new Set(_teachers.filter(t => !t.isPlaceholder).map(t => t.id));
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
  _teachers.forEach(t => {
    const name = t.isPlaceholder ? (t.placeholder_name || 'Open Position') : `${t.first_name} ${t.last_name}`;
    board.appendChild(buildColumn(t.id, name));
  });
  if (window.lucide) lucide.createIcons({ nodes: [board] });
}

function buildColumn(teacherId, name) {
  const isUnplaced = teacherId === null;
  const teacher = teacherId ? _teachers.find(t => t.id === teacherId) : null;
  const isPlaceholder = teacher?.isPlaceholder ?? false;

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

  // Capacity indicator for real teacher columns only
  let capacityBarHtml = '';
  let countClass = '';
  if (!isUnplaced && !isPlaceholder && _targetClassSize) {
    const pct = Math.min(100, Math.round((totalCount / _targetClassSize) * 100));
    const over  = totalCount > _targetClassSize * 1.15;
    const under = totalCount < _targetClassSize * 0.85 && totalCount > 0;
    const color = over ? '#ef4444' : under ? '#f59e0b' : '#22c55e';
    countClass = over ? 'capacity-over' : under ? 'capacity-under' : 'capacity-ok';
    capacityBarHtml = `<div class="placement-capacity-bar"><div style="width:${pct}%;background:${color};height:100%;border-radius:2px;transition:width .2s;"></div></div>`;
  }

  const col = document.createElement('div');
  col.className = 'placement-col' + (isPlaceholder ? ' placement-col--placeholder' : '');
  col.dataset.colKey = teacherId ?? '__unplaced__';
  if (isUnplaced && totalCount === 0) col.classList.add('placement-col--unplaced-empty');

  const dragHandle = !isUnplaced
    ? `<span class="col-drag-handle" title="Drag to reorder columns (cannot be undone)"><i data-lucide="grip-vertical" style="width:12px;height:12px;opacity:0.4;"></i></span>`
    : '';

  const manageBtn = !isUnplaced
    ? `<button class="placement-col-manage-btn" data-col-id="${teacherId}" title="Remove or replace teacher" style="margin-left:auto;background:none;border:none;cursor:pointer;padding:2px 4px;opacity:0.35;border-radius:4px;display:flex;align-items:center;flex-shrink:0;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.35'"><i data-lucide="more-horizontal" style="width:14px;height:14px;"></i></button>`
    : '';

  let avatarOrBadge = '';
  if (isPlaceholder) {
    avatarOrBadge = `<span class="placement-placeholder-badge"><i data-lucide="alert-triangle" style="width:9px;height:9px;"></i> Open</span>`;
  } else if (!isUnplaced) {
    avatarOrBadge = `<span class="teacher-avatar" style="background:${teacherAvatarColor(name)};">${getInitials(name)}</span>`;
  }

  const headerClass = isUnplaced ? 'col-unplaced' : (isPlaceholder ? 'col-placeholder' : 'col-teacher');

  const assignBar = isPlaceholder
    ? `<div class="placement-placeholder-assign-bar">
         <button class="placement-assign-teacher-btn" data-col-id="${teacherId}">
           <i data-lucide="user-check" style="width:11px;height:11px;"></i> Assign Teacher
         </button>
       </div>`
    : '';

  const flagCountsHtml = buildFlagCounts(allColStudents);

  col.innerHTML = `
    <div class="placement-col-header ${headerClass}">
      <div class="placement-col-header-row">
        ${dragHandle}
        ${avatarOrBadge}
        <span class="placement-col-name">${esc(name)}</span>
        <span class="placement-col-count ${countClass}">${countDisplay}</span>
        ${manageBtn}
      </div>
      ${flagCountsHtml}
    </div>
    ${assignBar}
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

  col.querySelector('.placement-col-manage-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    openManageColumnModal(teacherId);
  });

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

  // Wire Assign Teacher button for placeholder columns
  if (isPlaceholder) {
    col.querySelector('.placement-assign-teacher-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      openAssignTeacherModal(teacherId);
    });
  }

  if (window.lucide) lucide.createIcons({ nodes: [col] });
  return col;
}

// Compact grade label for the card badge (e.g. "5th", "K", "?").
function gradeShort(g) {
  if (!g) return '?';
  if (g === 'K' || g === 'PK') return g;
  const n = parseInt(g, 10);
  if (isNaN(n)) return g;
  const v = n % 100;
  const suffix = (v >= 11 && v <= 13) ? 'th' : (['th', 'st', 'nd', 'rd'][v % 10] || 'th');
  return `${n}${suffix}`;
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

  const isManuallyAdded = _manuallyAddedIds.has(student.id);
  const boardGrade = _session?.incoming_grade ?? null;
  const isOffGrade = boardGrade != null && student.grade_level !== boardGrade;
  card.innerHTML = `
    <div class="placement-card-name">${esc(student.last_name)}, ${esc(student.first_name)}</div>
    <span class="student-grade-badge${isOffGrade ? ' student-grade-badge--off' : ''}"${isOffGrade ? ` title="Off grade for this ${esc(gradeLabel(boardGrade))} board"` : ''}>${esc(gradeShort(student.grade_level))}</span>
    ${student.is_retained ? `<span class="student-retained-badge">Retained</span>` : ''}
    ${isManuallyAdded ? `<span class="student-manual-badge">Added</span>` : ''}
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

function refreshColumnFlagCounts(teacherId) {
  const key = teacherId ?? '__unplaced__';
  const col = document.querySelector(`.placement-col[data-col-key="${key}"]`);
  if (!col) return;
  const students = _students.filter(s => (_assignments[s.id] ?? null) === teacherId);
  const header = col.querySelector('.placement-col-header');
  if (!header) return;
  const existing = header.querySelector('.placement-col-flag-counts');
  const html = buildFlagCounts(students);
  if (existing) existing.outerHTML = html;
  else if (html) header.insertAdjacentHTML('beforeend', html);
}

function buildFlagCounts(students) {
  const counts = new Map(); // flagId → count
  students.forEach(s => {
    (_studentFlags[s.id] ?? new Set()).forEach(fid => {
      counts.set(fid, (counts.get(fid) ?? 0) + 1);
    });
  });
  if (!counts.size) return '';
  const chips = _flags
    .filter(f => counts.has(f.id))
    .map(f => `<span class="placement-col-flag-chip">
      <span class="placement-col-flag-dot" style="background:${f.color};"></span>${counts.get(f.id)}
    </span>`)
    .join('');
  return `<div class="placement-col-flag-counts">${chips}</div>`;
}

function refreshFlagDots(cardEl, studentId) {
  const dotsEl = cardEl.querySelector(`[data-dots-for="${studentId}"]`);
  if (!dotsEl) return;
  dotsEl.innerHTML = '';
  const active = _studentFlags[studentId] || new Set();
  let firstColor = null;
  _flags.forEach(f => {
    if (!active.has(f.id) || f.archived_at) return;
    if (!firstColor) firstColor = f.color;
    const dot = document.createElement('span');
    dot.className = 'placement-flag-dot';
    dot.style.background = f.color;
    dot.title = f.label;
    dotsEl.appendChild(dot);
  });
  cardEl.style.setProperty('--card-accent', firstColor ?? 'transparent');
}

function teacherAvatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${((Math.abs(h) % 360) + 360) % 360},48%,40%)`;
}

function getInitials(fullName) {
  const p = fullName.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : fullName.slice(0, 2).toUpperCase();
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
  const removeBtn = document.getElementById('removeFromBoardBtn');
  if (removeBtn) removeBtn.hidden = n === 0;
}

/* ── Surgical DOM helpers ── */
function updateColCount(teacherId) {
  const isUnplaced = teacherId == null;
  const body = document.querySelector(`[data-teacher-id="${isUnplaced ? '' : teacherId}"]`);
  if (!body) return;
  const col = body.closest('.placement-col');
  if (!col) return;
  const countEl = col.querySelector('.placement-col-count');
  if (!countEl) return;

  const count = _students.filter(s =>
    isUnplaced ? (_assignments[s.id] == null) : (_assignments[s.id] === teacherId)
  ).length;

  countEl.textContent = count;

  if (!isUnplaced && _targetClassSize) {
    const over  = count > _targetClassSize * 1.15;
    const under = count < _targetClassSize * 0.85 && count > 0;
    const pct   = Math.min(100, Math.round((count / _targetClassSize) * 100));
    const color = over ? '#ef4444' : under ? '#f59e0b' : '#22c55e';
    countEl.className = `placement-col-count ${over ? 'capacity-over' : under ? 'capacity-under' : 'capacity-ok'}`;
    const bar = col.querySelector('.placement-capacity-bar div');
    if (bar) { bar.style.width = pct + '%'; bar.style.background = color; }
  }

  if (isUnplaced) col.classList.toggle('placement-col--unplaced-empty', count === 0);
}

function tryMoveSurgical(studentIds, toTeacherId) {
  if (_boardSearchTerm) return false;
  const toBody = document.querySelector(`[data-teacher-id="${toTeacherId ?? ''}"]`);
  if (!toBody) return false;

  const cards = studentIds.map(id => document.querySelector(`.placement-card[data-student-id="${id}"]`));
  if (cards.some(c => !c)) return false;

  const affectedCols = new Set([toTeacherId ?? '']);
  const frag = document.createDocumentFragment();
  cards.forEach(card => {
    const fromBody = card.closest('.placement-col-body');
    if (fromBody) affectedCols.add(fromBody.dataset.teacherId ?? '');
    card.classList.remove('selected');
    frag.appendChild(card);
  });
  toBody.prepend(frag);

  affectedCols.forEach(tid => {
    const key = tid === '' ? null : tid;
    updateColCount(key);
    refreshColumnFlagCounts(key);
  });
  return true;
}

function tryUndoSurgical(group) {
  if (_boardSearchTerm) return false;

  for (const { studentId } of group) {
    if (!document.querySelector(`.placement-card[data-student-id="${studentId}"]`)) return false;
  }

  const affectedCols = new Set();
  for (const { studentId, fromTeacherId } of group) {
    const toBody = document.querySelector(`[data-teacher-id="${fromTeacherId ?? ''}"]`);
    if (!toBody) return false;
    const card = document.querySelector(`.placement-card[data-student-id="${studentId}"]`);
    const fromBody = card.closest('.placement-col-body');
    if (fromBody) affectedCols.add(fromBody.dataset.teacherId ?? '');
    affectedCols.add(fromTeacherId ?? '');
    card.classList.remove('selected');
    toBody.prepend(card);
  }

  affectedCols.forEach(tid => {
    const key = tid === '' ? null : tid;
    updateColCount(key);
    refreshColumnFlagCounts(key);
  });
  return true;
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
  if (!tryMoveSurgical(ids, teacherId)) renderBoard();
  scheduleSave();
  updateUndoBtn();
}

function logMoves(group, toTeacherId) {
  if (!_currentSessionId || !_profile) return;
  const changedByName = [_profile.first_name, _profile.last_name].filter(Boolean).join(' ') || (_profile.email ?? '');
  const teacherName = id => {
    if (!id) return null;
    const t = _teachers.find(t => t.id === id);
    if (!t) return null;
    return t.isPlaceholder ? (t.placeholder_name ?? 'Open Position') : t.last_name;
  };
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
  if (!tryUndoSurgical(group)) renderBoard();
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
  await supabase.from('placement_session_teachers')
    .upsert(
      _teachers.map((t, i) => ({ id: t._rowId, sort_order: i })),
      { onConflict: 'id' }
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
      const safeColor = /^#[0-9a-fA-F]{3,6}$/.test(f.color) ? f.color : '#cccccc';
      const btn = document.createElement('button');
      btn.className = 'placement-flag-toggle' + (active.has(f.id) ? ' active' : '');
      btn.innerHTML = `<span class="placement-flag-dot" style="background:${safeColor};width:10px;height:10px;display:inline-block;border-radius:50%;flex-shrink:0;"></span>${esc(f.label)}`;
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await toggleFlag(studentId, f.id);
        refreshFlagDots(card, studentId);
        btn.classList.toggle('active', (_studentFlags[studentId] || new Set()).has(f.id));
        refreshColumnFlagCounts(_assignments[studentId] ?? null);
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

  const rows = changed.map(s => {
    const colId = _assignments[s.id] ?? null;
    const isPlaceholderAssignment = colId && _placeholderColIds.has(colId);
    return {
      session_id:      _currentSessionId,
      student_id:      s.id,
      teacher_id:      isPlaceholderAssignment ? null : colId,
      assigned_col_id: isPlaceholderAssignment ? colId : null,
      sort_order:      _students.indexOf(s),
    };
  });

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
  const rows = [['Last Name', 'First Name', 'Student Number', 'Grade', 'Assigned Teacher']];
  _students
    .slice()
    .sort((a, b) => {
      const ta = _assignments[a.id] ? (_teachers.find(t => t.id === _assignments[a.id])?.last_name ?? '') : '￿';
      const tb = _assignments[b.id] ? (_teachers.find(t => t.id === _assignments[b.id])?.last_name ?? '') : '￿';
      return ta !== tb ? ta.localeCompare(tb) : a.last_name.localeCompare(b.last_name);
    })
    .forEach(s => {
      const colId = _assignments[s.id];
      const teacher = colId ? _teachers.find(t => t.id === colId) : null;
      let teacherLabel = '(Unplaced)';
      if (teacher) {
        teacherLabel = teacher.isPlaceholder
          ? `(${teacher.placeholder_name ?? 'Open Position'})`
          : `${teacher.last_name}, ${teacher.first_name}`;
      }
      rows.push([
        s.last_name,
        s.first_name,
        s.student_number ?? '',
        _session.incoming_grade,
        teacherLabel,
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
  const modal     = document.getElementById('undoCommitConfirmModal');
  const body      = document.getElementById('undoCommitConfirmBody');
  const okBtn     = document.getElementById('undoCommitConfirmOkBtn');
  const cancelBtn = document.getElementById('undoCommitConfirmCancelBtn');

  body.innerHTML =
    `<p style="margin:0 0 10px;">This will restore the previous homeroom teacher for <strong>${placed} student${placed !== 1 ? 's' : ''}</strong> and revert <strong>${esc(_session.label)}</strong> to Draft.</p>` +
    `<p style="margin:0;color:#6b7280;font-size:13px;">Students who had no homeroom teacher before this commit will be set back to none.</p>`;

  modal.hidden = false;

  const cleanup = () => { modal.hidden = true; okBtn.removeEventListener('click', onOk); cancelBtn.removeEventListener('click', onCancel); };
  const onOk = async () => { cleanup(); await runUndoCommit(); };
  const onCancel = () => cleanup();

  okBtn.addEventListener('click', onOk);
  cancelBtn.addEventListener('click', onCancel);
}

async function runUndoCommit() {
  const undoBtn   = document.getElementById('undoCommitPlacementBtn');
  const commitBtn = document.getElementById('commitPlacementBtn');
  if (undoBtn) { undoBtn.disabled = true; undoBtn.textContent = 'Reverting…'; }

  // Load the saved prev_homeroom_teacher_id values
  const placedStudentIds = Object.entries(_assignments)
    .filter(([, tid]) => tid != null && !_placeholderColIds.has(tid))
    .map(([sid]) => sid);

  const { data: prevData, error: loadErr } = await supabase
    .from('placement_assignments')
    .select('student_id, prev_homeroom_teacher_id')
    .eq('session_id', _currentSessionId)
    .in('student_id', placedStudentIds);

  if (loadErr) {
    showToast('Failed to load previous homeroom data. Cannot undo.', 'error');
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
    showToast('Some reversions failed. Check the console for details.', 'error');
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

  showToast('Commit reverted. Session is back in Draft.', 'success');
}

/* ── Auto-place ── */
function autoPlaceStudents() {
  if (_session?.status === 'committed') return;
  const allCols = _teachers; // includes real teachers and placeholder columns
  if (allCols.length === 0) {
    showToast('No columns on this board to distribute students into.', 'warn');
    return;
  }

  const unplaced = _students.filter(s => _assignments[s.id] == null);
  let studentsToPlace;

  const flagNote = '\n\n⚠ Auto-place does not account for IEP/504, ELL, behavior, or other flags. Review placements after distributing.';

  if (unplaced.length === 0) {
    const per = Math.ceil(_students.length / allCols.length);
    const ok = confirm(
      `All ${_students.length} students are already placed.\n\n` +
      `Redistribute everyone evenly across ${allCols.length} column${allCols.length !== 1 ? 's' : ''} (~${per} per column)?\n\n` +
      `Current placements will be cleared.` +
      flagNote
    );
    if (!ok) return;
    _students.forEach(s => { _assignments[s.id] = null; });
    studentsToPlace = [..._students];
  } else {
    const per = Math.ceil(unplaced.length / allCols.length);
    const ok = confirm(
      `Distribute ${unplaced.length} unplaced student${unplaced.length !== 1 ? 's' : ''} evenly across ${allCols.length} column${allCols.length !== 1 ? 's' : ''} (~${per} per column)?` +
      flagNote
    );
    if (!ok) return;
    studentsToPlace = unplaced;
  }

  // Round-robin across all columns (real teachers and placeholders)
  studentsToPlace.forEach((s, i) => {
    _assignments[s.id] = allCols[i % allCols.length].id;
  });

  renderBoard();
  scheduleSave();
}

/* ── Fullscreen ── */
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().then(() => {
      _enterPlacementFullscreen();
    }).catch(() => {
      // Browser denied — fall back to CSS-only expand
      _enterPlacementFullscreen();
    });
  } else {
    document.exitFullscreen?.();
  }
}

function _enterPlacementFullscreen() {
  const view = document.getElementById('placementBoardView');
  if (!view) return;
  view._fsParent = view.parentElement;
  view._fsAnchor = view.nextSibling;
  document.body.appendChild(view);
  view.classList.add('placement-fullscreen');
  document.body.classList.add('placement-fs');
  setFullscreenIcon(true);
}

function exitFullscreen() {
  const view = document.getElementById('placementBoardView');
  if (!view?.classList.contains('placement-fullscreen')) return;

  view.classList.remove('placement-fullscreen');
  document.body.classList.remove('placement-fs');

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

  const wasCompact = board.classList.contains('placement-board--compact');
  const wasUltra   = board.classList.contains('placement-board--ultra');
  board.classList.remove('placement-board--compact', 'placement-board--ultra');

  if (!wasCompact && !wasUltra) {
    // Normal → Compact
    board.classList.add('placement-board--compact');
    btn.style.color = 'var(--primary)';
    btn.style.borderColor = 'var(--primary)';
    btn.style.background = '';
    btn.title = 'Switch to ultra-compact view';
  } else if (wasCompact) {
    // Compact → Ultra
    board.classList.add('placement-board--ultra');
    btn.style.color = 'white';
    btn.style.borderColor = 'var(--primary)';
    btn.style.background = 'var(--primary)';
    btn.title = 'Switch to normal view';
  } else {
    // Ultra → Normal
    btn.style.color = '';
    btn.style.borderColor = '';
    btn.style.background = '';
    btn.title = 'Switch to compact view';
  }
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

  // Hard block: cannot commit while any students are in placeholder columns
  const placeholderStudentCount = _students.filter(s =>
    _assignments[s.id] && _placeholderColIds.has(_assignments[s.id])
  ).length;
  if (placeholderStudentCount > 0) {
    showToast(
      `Cannot commit: ${placeholderStudentCount} student${placeholderStudentCount !== 1 ? 's' : ''} are in Open Position columns. Assign a teacher to each before committing.`,
      'error', 7000
    );
    return;
  }

  const placed   = Object.values(_assignments).filter(v => v != null && !_placeholderColIds.has(v)).length;
  const unplaced = _students.length - placed;
  const warnings = validatePlacement();

  const modal   = document.getElementById('commitConfirmModal');
  const body    = document.getElementById('commitConfirmBody');
  const okBtn   = document.getElementById('commitConfirmOkBtn');
  const cancelBtn = document.getElementById('commitConfirmCancelBtn');

  let html = `<p style="margin:0 0 12px;">Commit homeroom assignments for <strong>${esc(_session.label)}</strong>?</p>`;
  html += `<ul style="margin:0 0 12px;padding-left:20px;">`;
  html += `<li>${placed} student${placed !== 1 ? 's' : ''} will be assigned to their new homeroom teacher</li>`;
  if (unplaced > 0) {
    html += `<li>${unplaced} student${unplaced !== 1 ? 's' : ''} left unplaced — no change will be made for them</li>`;
  }
  html += `</ul>`;

  if (warnings.length) {
    html += `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:10px 12px;margin-top:4px;">`;
    html += `<div style="font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#92400e;margin-bottom:6px;">Warnings</div>`;
    html += `<ul style="margin:0;padding-left:18px;color:#78350f;font-size:13px;">`;
    warnings.forEach(w => { html += `<li>${esc(w)}</li>`; });
    html += `</ul></div>`;
  }

  body.innerHTML = html;
  modal.hidden = false;

  const cleanup = () => { modal.hidden = true; okBtn.removeEventListener('click', onOk); cancelBtn.removeEventListener('click', onCancel); };
  const onOk = async () => { cleanup(); await runCommit(); };
  const onCancel = () => cleanup();

  okBtn.addEventListener('click', onOk);
  cancelBtn.addEventListener('click', onCancel);
}

function validatePlacement() {
  const warnings = [];

  const realTeachers   = _teachers.filter(t => !t.isPlaceholder);
  const placedStudents = _students.filter(s =>
    _assignments[s.id] != null && !_placeholderColIds.has(_assignments[s.id])
  );

  // Class size vs target
  if (_targetClassSize) {
    realTeachers.forEach(t => {
      const count = _students.filter(s => _assignments[s.id] === t.id).length;
      if (count > Math.ceil(_targetClassSize * 1.2))
        warnings.push(`${t.last_name}'s class has ${count} students (target ${_targetClassSize})`);
      else if (count > 0 && count < Math.floor(_targetClassSize * 0.8))
        warnings.push(`${t.last_name}'s class has only ${count} students (target ${_targetClassSize})`);
    });
  }

  // Flag checks — distribution flags (Boy/Girl, >35% of class) use gender-balance warning;
  // concentration flags (ELL, Behavior, EC, etc.) warn when 3+ land in one class
  const activeFlags = _flags.filter(f => !f.archived_at);
  activeFlags.forEach(flag => {
    const globalCount    = placedStudents.filter(s => _studentFlags[s.id]?.has(flag.id)).length;
    const globalRate     = placedStudents.length > 0 ? globalCount / placedStudents.length : 0;
    const isDistribution = globalRate > 0.35;

    realTeachers.forEach(t => {
      const classStudents = _students.filter(s => _assignments[s.id] === t.id);
      if (classStudents.length < 5) return;
      const withFlag = classStudents.filter(s => _studentFlags[s.id]?.has(flag.id));

      if (isDistribution) {
        const pct = withFlag.length / classStudents.length;
        if (pct > 0.65) {
          warnings.push(
            `"${flag.label}": ${Math.round(pct * 100)}% of ${t.last_name}'s class (${withFlag.length}/${classStudents.length} students)`
          );
        }
      } else if (withFlag.length >= 3) {
        warnings.push(
          `"${flag.label}": ${withFlag.length} students in ${t.last_name}'s class ` +
          `(${withFlag.map(s => s.first_name).join(', ')})`
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

  // Only commit students with real teacher assignments (not placeholder columns)
  const placedEntries = Object.entries(_assignments).filter(([, tid]) => tid != null && !_placeholderColIds.has(tid));
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
    showToast('Some student updates failed. Check the console for details.', 'error');
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
  showToast(`Done! ${placed} student${placed !== 1 ? 's' : ''} assigned to their homeroom teacher.`, 'success');
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
        if (error) { showToast('Failed to rename flag.', 'error'); labelInput.value = f.label; }
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
        if (error) { showToast('Failed to restore flag.', 'error'); return; }
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
        if (error) { showToast('Failed to archive flag.', 'error'); return; }
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

  if (error) { showToast('Failed to create flag.', 'error'); return; }

  _flags.push(data);
  document.getElementById('newFlagLabel').value = '';
  _newFlagColor = FLAG_COLORS[4];
  const dot = document.getElementById('newFlagColorDot');
  if (dot) dot.style.background = _newFlagColor;
  renderFlagEditorList();
}

/* ── Add Column ── */
async function openAddColumnModal() {
  // Reset modal state
  const realRadio = document.getElementById('addColTypeReal');
  if (realRadio) realRadio.checked = true;
  document.getElementById('addColRealPanel').hidden = false;
  document.getElementById('addColPlaceholderPanel').hidden = true;
  document.getElementById('addColPlaceholderName').value = '';

  // Populate teacher select with employees not already on the board
  const sel = document.getElementById('addColTeacherSelect');
  sel.innerHTML = '<option value="">Loading…</option>';
  sel.disabled = true;

  const available = await getAvailableEmployees();
  sel.innerHTML = '<option value="">— Select teacher —</option>';
  if (available.length === 0) {
    sel.innerHTML = '<option value="">No additional teachers available</option>';
  } else {
    available.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.last_name}, ${e.first_name}${e.position ? ` — ${e.position}` : ''}`;
      sel.appendChild(opt);
    });
  }
  sel.disabled = false;

  document.getElementById('addPlacementColumnModal').hidden = false;
}

function closeAddColumnModal() {
  document.getElementById('addPlacementColumnModal').hidden = true;
}

async function submitAddColumn() {
  const type = document.querySelector('input[name="addColType"]:checked')?.value ?? 'real';
  if (type === 'real') {
    const empId = document.getElementById('addColTeacherSelect')?.value;
    if (!empId) { showToast('Please select a teacher.', 'warn'); return; }
    await addRealTeacherColumn(empId);
  } else {
    const name = document.getElementById('addColPlaceholderName')?.value.trim();
    if (!name) { document.getElementById('addColPlaceholderName')?.focus(); return; }
    await addPlaceholderColumn(name);
  }
}

async function addRealTeacherColumn(empId) {
  const emp = _formEmployees.find(e => e.id === empId);
  if (!emp) { showToast('Employee not found.', 'error'); return; }

  const { data: row, error } = await supabase
    .from('placement_session_teachers')
    .insert({ session_id: _currentSessionId, teacher_id: empId, sort_order: _teachers.length })
    .select('id')
    .single();

  if (error || !row) {
    console.error('Add column error:', error);
    showToast('Failed to add teacher column.', 'error');
    return;
  }

  _teachers.push({ id: empId, first_name: emp.first_name, last_name: emp.last_name, isPlaceholder: false, _rowId: row.id });
  _homeroomTeacherNames[empId] = emp.last_name;
  closeAddColumnModal();
  renderBoard();
}

async function addPlaceholderColumn(name) {
  const { data: row, error } = await supabase
    .from('placement_session_teachers')
    .insert({ session_id: _currentSessionId, teacher_id: null, placeholder_name: name, sort_order: _teachers.length })
    .select('id')
    .single();

  if (error || !row) {
    console.error('Add placeholder column error:', error);
    showToast('Failed to add open position column.', 'error');
    return;
  }

  _teachers.push({ id: row.id, placeholder_name: name, isPlaceholder: true, _rowId: row.id });
  _placeholderColIds.add(row.id);
  closeAddColumnModal();
  renderBoard();
}

async function getAvailableEmployees() {
  if (!_formEmployees.length) {
    const { data } = await supabase
      .from('employees')
      .select('id, first_name, last_name, position')
      .eq('school_id', _profile.school_id)
      .eq('active', true)
      .order('last_name');
    _formEmployees = data || [];
  }
  const onBoard = new Set(_teachers.filter(t => !t.isPlaceholder).map(t => t.id));
  return _formEmployees.filter(e => !onBoard.has(e.id));
}

/* ── Assign Teacher (resolve placeholder) ── */
async function openAssignTeacherModal(colId) {
  _resolvingColId = colId;

  const sel = document.getElementById('assignTeacherSelect');
  sel.innerHTML = '<option value="">Loading…</option>';
  sel.disabled = true;

  const available = await getAvailableEmployees();
  sel.innerHTML = '<option value="">— Select teacher —</option>';
  if (available.length === 0) {
    sel.innerHTML = '<option value="">No additional teachers available</option>';
  } else {
    available.forEach(e => {
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.last_name}, ${e.first_name}${e.position ? ` — ${e.position}` : ''}`;
      sel.appendChild(opt);
    });
  }
  sel.disabled = false;

  document.getElementById('assignTeacherModal').hidden = false;
}

function closeAssignTeacherModal() {
  document.getElementById('assignTeacherModal').hidden = true;
  _resolvingColId = null;
}

/* ── Manage Column (remove or replace teacher) ── */
function openManageColumnModal(teacherId) {
  _managingColId = teacherId;
  const teacher = _teachers.find(t => t.id === teacherId);
  if (!teacher) return;

  const name = teacher.isPlaceholder
    ? (teacher.placeholder_name ?? 'Open Position')
    : `${teacher.first_name} ${teacher.last_name}`;
  const assignedCount = _students.filter(s => _assignments[s.id] === teacherId).length;

  document.getElementById('manageColTitle').textContent = name;
  document.getElementById('manageColMsg').textContent = assignedCount > 0
    ? `${assignedCount} student${assignedCount !== 1 ? 's' : ''} assigned to this column.`
    : 'No students are currently assigned to this column.';
  document.getElementById('manageColRemoveBtn').textContent = assignedCount > 0
    ? `Remove Column (${assignedCount} student${assignedCount !== 1 ? 's' : ''} become Unassigned)`
    : 'Remove Column';

  document.getElementById('manageColChoicePanel').hidden = false;
  document.getElementById('manageColReplacePanel').hidden = true;
  document.getElementById('manageColumnModal').hidden = false;
}

function closeManageColumnModal() {
  document.getElementById('manageColumnModal').hidden = true;
  _managingColId = null;
}

async function showManageReplacePanel() {
  if (!_managingColId) return;
  await getAvailableEmployees(); // ensures _formEmployees is populated
  const currentIds = new Set(_teachers.filter(t => !t.isPlaceholder).map(t => t.id));
  currentIds.delete(_managingColId); // allow re-selecting a different real teacher
  const available = _formEmployees.filter(e => !currentIds.has(e.id));

  const sel = document.getElementById('manageColTeacherSelect');
  sel.innerHTML = '<option value="">— Select replacement —</option>' +
    available.map(e => `<option value="${esc(e.id)}">${esc(e.last_name)}, ${esc(e.first_name)}</option>`).join('');

  document.getElementById('manageColChoicePanel').hidden = true;
  document.getElementById('manageColReplacePanel').hidden = false;
}

async function confirmReplaceColumnTeacher() {
  const newEmpId = document.getElementById('manageColTeacherSelect').value;
  if (!newEmpId) { showToast('Please select a replacement teacher.', 'warn'); return; }
  if (!_managingColId) return;

  const oldTeacherId = _managingColId;
  const teacher = _teachers.find(t => t.id === oldTeacherId);
  const newEmp  = _formEmployees.find(e => e.id === newEmpId);
  if (!teacher || !newEmp) return;

  const btn = document.getElementById('manageColConfirmReplaceBtn');
  btn.disabled = true; btn.textContent = 'Replacing…';

  const { error: pstErr } = await supabase
    .from('placement_session_teachers')
    .update({ teacher_id: newEmpId, placeholder_name: null })
    .eq('id', teacher._rowId);

  if (pstErr) {
    console.error('Replace teacher error:', pstErr);
    showToast('Failed to replace teacher.', 'error');
    btn.disabled = false; btn.textContent = 'Replace';
    return;
  }

  const { error: assignErr } = await supabase
    .from('placement_assignments')
    .update({ teacher_id: newEmpId })
    .eq('session_id', _currentSessionId)
    .eq('teacher_id', oldTeacherId);

  if (assignErr) {
    console.error('Replace teacher assignments error:', assignErr);
    showToast('Teacher replaced but student assignments could not be updated. Please reload.', 'error');
    btn.disabled = false; btn.textContent = 'Replace';
    return;
  }

  _students.forEach(s => {
    if (_assignments[s.id] === oldTeacherId) {
      _assignments[s.id]      = newEmpId;
      _savedAssignments[s.id] = newEmpId;
    }
  });

  const idx = _teachers.findIndex(t => t.id === oldTeacherId);
  if (idx !== -1) {
    _teachers[idx] = { ..._teachers[idx], id: newEmpId, first_name: newEmp.first_name, last_name: newEmp.last_name, isPlaceholder: false };
  }
  _placeholderColIds.delete(oldTeacherId);
  _homeroomTeacherNames[newEmpId] = newEmp.last_name;
  _undoStack = [];
  updateUndoBtn();

  btn.disabled = false; btn.textContent = 'Replace';
  closeManageColumnModal();
  renderBoard();
}

async function confirmRemoveColumn() {
  if (!_managingColId) return;
  const teacher = _teachers.find(t => t.id === _managingColId);
  if (!teacher) return;

  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }

  const affected = _students.filter(s => _assignments[s.id] === _managingColId);

  if (affected.length > 0) {
    const { error: assignErr } = await supabase
      .from('placement_assignments')
      .update({ teacher_id: null, assigned_col_id: null })
      .eq('session_id', _currentSessionId)
      .in('student_id', affected.map(s => s.id));

    if (assignErr) {
      console.error('Remove column: unassign error:', assignErr);
      showToast('Failed to unassign students. Column not removed.', 'error');
      closeManageColumnModal();
      return;
    }

    affected.forEach(s => {
      _assignments[s.id]      = null;
      _savedAssignments[s.id] = null;
    });
  }

  const { error: pstErr } = await supabase
    .from('placement_session_teachers')
    .delete()
    .eq('id', teacher._rowId);

  if (pstErr) {
    console.error('Remove column: delete PST error:', pstErr);
    showToast('Students unassigned but column could not be deleted. Please reload.', 'error');
    closeManageColumnModal();
    renderBoard();
    return;
  }

  _teachers = _teachers.filter(t => t.id !== _managingColId);
  _placeholderColIds.delete(_managingColId);
  _undoStack = [];
  updateUndoBtn();

  closeManageColumnModal();
  renderBoard();
}

async function submitAssignTeacher() {
  const empId = document.getElementById('assignTeacherSelect')?.value;
  if (!empId) { showToast('Please select a teacher.', 'warn'); return; }
  if (!_resolvingColId) return;

  const emp = _formEmployees.find(e => e.id === empId);
  if (!emp) { showToast('Employee not found.', 'error'); return; }

  const btn = document.getElementById('submitAssignTeacherBtn');
  btn.disabled = true;
  btn.textContent = 'Assigning…';

  // 1. Update the PST row: set real teacher, clear placeholder_name
  const { error: pstErr } = await supabase
    .from('placement_session_teachers')
    .update({ teacher_id: empId, placeholder_name: null })
    .eq('id', _resolvingColId);

  if (pstErr) {
    console.error('Assign teacher PST error:', pstErr);
    showToast('Failed to assign teacher.', 'error');
    btn.disabled = false;
    btn.textContent = 'Assign';
    return;
  }

  // 2. Update all placement_assignments that were in this placeholder column
  const { error: assignErr } = await supabase
    .from('placement_assignments')
    .update({ teacher_id: empId, assigned_col_id: null })
    .eq('session_id', _currentSessionId)
    .eq('assigned_col_id', _resolvingColId);

  if (assignErr) {
    console.error('Assign teacher assignments error:', assignErr);
    showToast('Teacher assigned but student records could not be updated. Please reload.', 'error');
    btn.disabled = false;
    btn.textContent = 'Assign';
    return;
  }

  // 3. Update in-memory state
  const oldColId = _resolvingColId;

  // Update _assignments for all affected students
  _students.forEach(s => {
    if (_assignments[s.id] === oldColId) {
      _assignments[s.id] = empId;
      _savedAssignments[s.id] = empId; // already persisted above
    }
  });

  // Replace placeholder entry in _teachers with real teacher entry
  const idx = _teachers.findIndex(t => t.id === oldColId);
  if (idx !== -1) {
    _teachers[idx] = { id: empId, first_name: emp.first_name, last_name: emp.last_name, isPlaceholder: false, _rowId: oldColId };
  }

  _placeholderColIds.delete(oldColId);
  _homeroomTeacherNames[empId] = emp.last_name;

  btn.disabled = false;
  btn.textContent = 'Assign';
  closeAssignTeacherModal();
  renderBoard();
}

/* ── Remove Students from Board ── */

async function removeSelectedFromBoard() {
  const ids = [..._selectedStudentIds];
  if (!ids.length) return;

  const names = ids
    .map(id => {
      const s = _students.find(s => s.id === id);
      return s ? `${s.last_name}, ${s.first_name}` : id;
    })
    .join('\n  ');

  const confirmed = confirm(
    `Remove ${ids.length} student${ids.length !== 1 ? 's' : ''} from this board?\n\n  ${names}\n\nThey can be re-added later using Sync Students. This does not affect their record in the student directory.`
  );
  if (!confirmed) return;

  const { error } = await supabase
    .from('placement_assignments')
    .delete()
    .eq('session_id', _currentSessionId)
    .in('student_id', ids);

  if (error) { showToast('Failed to remove student(s).', 'error'); return; }

  // Remove from in-memory state
  ids.forEach(id => {
    delete _assignments[id];
    delete _savedAssignments[id];
    delete _studentFlags[id];
    _manuallyAddedIds.delete(id);
  });
  _students = _students.filter(s => !ids.includes(s.id));

  clearSelection();
  renderBoard();
  showToast(`${ids.length} student${ids.length !== 1 ? 's' : ''} removed from board.`, 'success');
}

/* ── Add Individual Student to Board ── */

let _addStudentDebounce = null;

async function openAddStudentModal() {
  if (!_session) return;
  const modal     = document.getElementById('addStudentModal');
  const searchEl  = document.getElementById('addStudentSearch');
  const resultsEl = document.getElementById('addStudentResults');
  searchEl.value = '';
  resultsEl.innerHTML = '<p style="padding:12px;font-size:13px;color:#9ca3af;text-align:center;">Type a name or student # to search…</p>';
  modal.hidden = false;
  searchEl.focus();
}

async function runAddStudentSearch(term) {
  const resultsEl = document.getElementById('addStudentResults');
  if (!term) {
    resultsEl.innerHTML = '<p style="padding:12px;font-size:13px;color:#9ca3af;text-align:center;">Type a name or student # to search…</p>';
    return;
  }

  resultsEl.innerHTML = '<p style="padding:12px;font-size:13px;color:#9ca3af;text-align:center;">Searching…</p>';

  const currentIds = new Set(_students.map(s => s.id));

  const { data, error } = await supabase
    .from('students')
    .select('id, first_name, last_name, student_number, grade_level, is_retained, homeroom_teacher_id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,student_number.ilike.%${term}%`)
    .order('last_name')
    .limit(20);

  if (error) {
    resultsEl.innerHTML = '<p style="padding:12px;font-size:13px;color:#dc2626;text-align:center;">Search failed. Please try again.</p>';
    return;
  }

  const available = (data || []).filter(s => !currentIds.has(s.id));

  if (!available.length) {
    resultsEl.innerHTML = '<p style="padding:12px;font-size:13px;color:#9ca3af;text-align:center;">No students found (already on board or no match).</p>';
    return;
  }

  resultsEl.innerHTML = available.map(s => `
    <div class="add-student-result-row" data-student-id="${esc(s.id)}"
         style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;cursor:pointer;border-bottom:1px solid #f3f4f6;">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
        <span style="font-size:13px;font-weight:500;">${esc(s.last_name)}, ${esc(s.first_name)}</span>
        ${s.student_number ? `<span style="font-size:12px;color:#9ca3af;">#${esc(String(s.student_number))}</span>` : ''}
        ${s.is_retained ? `<span class="student-retained-badge">Retained</span>` : ''}
      </div>
      <span style="font-size:12px;color:#9ca3af;flex-shrink:0;margin-left:8px;">${s.grade_level ? gradeLabel(s.grade_level) : ''}</span>
    </div>
  `).join('');

  resultsEl.querySelectorAll('.add-student-result-row').forEach(row => {
    row.addEventListener('mouseover', () => { row.style.background = '#f0f7ff'; });
    row.addEventListener('mouseout',  () => { row.style.background = ''; });
    row.addEventListener('click', () => {
      const student = available.find(s => s.id === row.dataset.studentId);
      if (student) addStudentToBoard(student);
    });
  });
}

async function addStudentToBoard(student) {
  const maxSort = _students.length;
  const { error } = await supabase
    .from('placement_assignments')
    .insert({
      session_id:     _currentSessionId,
      student_id:     student.id,
      teacher_id:     null,
      sort_order:     maxSort,
      manually_added: true,
    });

  if (error) { showToast('Failed to add student to board.', 'error'); return; }

  const { data: flagData } = await supabase
    .from('student_placement_flags')
    .select('flag_id')
    .eq('student_id', student.id);

  _students.push({
    id:                  student.id,
    first_name:          student.first_name,
    last_name:           student.last_name,
    student_number:      student.student_number ?? null,
    homeroom_teacher_id: student.homeroom_teacher_id ?? null,
    is_retained:         student.is_retained ?? false,
  });
  _students.sort((a, b) => a.last_name.localeCompare(b.last_name));
  _assignments[student.id]      = null;
  _savedAssignments[student.id] = null;
  _studentFlags[student.id]     = new Set((flagData || []).map(f => f.flag_id));
  _manuallyAddedIds.add(student.id);

  document.getElementById('addStudentModal').hidden = true;
  renderBoard();
  showToast(`${student.first_name} ${student.last_name} added to board.`, 'success');
}

/* ── Sync Students ── */

let _syncNewStudents    = [];  // students in grade not yet in session
let _syncDepartedIds    = [];  // student IDs in session no longer active/in grade

async function openSyncStudentsModal() {
  if (!_session) return;

  const modal    = document.getElementById('syncStudentsModal');
  const bodyEl   = document.getElementById('syncStudentsBody');
  const newList  = document.getElementById('syncStudentsNewList');
  const newNames = document.getElementById('syncStudentsNewNames');
  const depList  = document.getElementById('syncStudentsDepartedList');
  const depNames = document.getElementById('syncStudentsDepartedNames');
  const confirmBtn = document.getElementById('syncStudentsConfirmBtn');
  const removeCb   = document.getElementById('syncRemoveDeparted');

  // Reset state
  _syncNewStudents = [];
  _syncDepartedIds = [];
  newList.hidden = true;
  depList.hidden = true;
  confirmBtn.disabled = true;
  if (removeCb) removeCb.checked = false;
  bodyEl.textContent = 'Checking roster…';
  modal.hidden = false;

  // Fetch the full active roster for this grade
  const { data: gradeRoster, error: rErr } = await supabase
    .from('students')
    .select('id, first_name, last_name, student_number')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .eq('grade_level', _session.incoming_grade);

  if (rErr) {
    bodyEl.textContent = 'Failed to load student roster.';
    return;
  }

  // Current session student IDs
  const sessionStudentIds = new Set(_students.map(s => s.id));
  const rosterIds         = new Set((gradeRoster || []).map(s => s.id));

  // New: in roster but not in session
  _syncNewStudents = (gradeRoster || []).filter(s => !sessionStudentIds.has(s.id));

  // Departed: in session but not in active roster for this grade.
  // Exclude manually-added students — they're intentionally off-grade.
  _syncDepartedIds = _students
    .filter(s => !rosterIds.has(s.id) && !_manuallyAddedIds.has(s.id))
    .map(s => s.id);

  const hasChanges = _syncNewStudents.length > 0 || _syncDepartedIds.length > 0;

  if (!hasChanges) {
    bodyEl.textContent = 'The board is already in sync — no new students and no departed students found.';
    confirmBtn.disabled = true;
    return;
  }

  bodyEl.textContent = '';

  if (_syncNewStudents.length > 0) {
    newNames.innerHTML = _syncNewStudents
      .map(s => `<div>${esc(s.last_name)}, ${esc(s.first_name)}${s.student_number ? ` <span style="color:#9ca3af;">#${esc(s.student_number)}</span>` : ''}</div>`)
      .join('');
    newList.hidden = false;
  }

  if (_syncDepartedIds.length > 0) {
    const departedStudents = _students.filter(s => _syncDepartedIds.includes(s.id));
    depNames.innerHTML = departedStudents
      .map(s => `<div>${esc(s.last_name)}, ${esc(s.first_name)}</div>`)
      .join('');
    depList.hidden = false;
  }

  confirmBtn.disabled = false;
  confirmBtn.textContent = _syncNewStudents.length > 0
    ? `Add ${_syncNewStudents.length} Student${_syncNewStudents.length !== 1 ? 's' : ''}`
    : 'Apply Changes';
}

async function executeSyncStudents() {
  const confirmBtn  = document.getElementById('syncStudentsConfirmBtn');
  const removeCb    = document.getElementById('syncRemoveDeparted');
  const shouldRemove = removeCb?.checked && _syncDepartedIds.length > 0;

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Applying…';

  // 1. Insert new students as unassigned — existing placements are NOT touched
  if (_syncNewStudents.length > 0) {
    const maxSort = _students.length;
    const inserts = _syncNewStudents.map((s, i) => ({
      session_id: _currentSessionId,
      student_id: s.id,
      teacher_id: null,
      sort_order:  maxSort + i,
    }));

    const { error: insErr } = await supabase
      .from('placement_assignments')
      .insert(inserts);

    if (insErr) {
      showToast('Failed to add new students.', 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Apply Changes';
      return;
    }
  }

  // 2. Remove departed students only if admin explicitly checked the box
  if (shouldRemove) {
    const { error: delErr } = await supabase
      .from('placement_assignments')
      .delete()
      .eq('session_id', _currentSessionId)
      .in('student_id', _syncDepartedIds);

    if (delErr) {
      showToast('New students added but failed to remove departed students.', 'error');
    }
  }

  document.getElementById('syncStudentsModal').hidden = true;

  const added   = _syncNewStudents.length;
  const removed = shouldRemove ? _syncDepartedIds.length : 0;
  const parts   = [];
  if (added)   parts.push(`${added} student${added !== 1 ? 's' : ''} added`);
  if (removed) parts.push(`${removed} removed`);
  showToast(parts.join(', ') + '.', 'success');

  // Reload the board — preserves all existing placements, just adds/removes rows
  await loadBoardData(_currentSessionId);
  renderBoard();
}

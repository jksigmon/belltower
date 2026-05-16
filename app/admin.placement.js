import { supabase } from './admin.supabase.js';

const GRADE_ORDER = ['PK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

function gradeLabel(g) {
  if (!g) return 'Unknown';
  if (g === 'PK') return 'Pre-K';
  if (g === 'K') return 'Kindergarten';
  const n = parseInt(g);
  if (!isNaN(n)) {
    const v = n % 100;
    const suffix = (v >= 11 && v <= 13) ? 'th' : (['th','st','nd','rd'][v % 10] || 'th');
    return `${n}${suffix} Grade`;
  }
  return `Grade ${g}`;
}

function nextGrade(g) {
  const idx = GRADE_ORDER.indexOf(g);
  if (idx < 0 || idx >= GRADE_ORDER.length - 1) return null;
  return GRADE_ORDER[idx + 1];
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
let _saveTimer = null;
let _selectedStudentId = null;
let _flagPopoverStudentId = null;
let _formEmployees = [];  // all employees for create form

/* ── Entry point ── */
export async function initPlacementSection(profile) {
  _profile = profile;
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
  document.getElementById('autoPlacementBtn')
    ?.addEventListener('click', autoPlaceStudents);
  document.getElementById('togglePlacementFullscreen')
    ?.addEventListener('click', toggleFullscreen);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') exitFullscreen();
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

  const { data, error } = await supabase
    .from('placement_sessions')
    .select('id, label, academic_year, incoming_grade, target_grade, status, created_at, committed_at')
    .eq('school_id', _profile.school_id)
    .order('created_at', { ascending: false });

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
    row.innerHTML = `
      <div class="placement-session-info">
        <div class="placement-session-label">${escHtml(s.label)}</div>
        <div class="muted" style="font-size:12px;margin-top:2px;">
          ${escHtml(s.academic_year.replace('-', '–'))} &middot; ${gradeLabel(s.incoming_grade)} &rarr; ${gradeLabel(s.target_grade)}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
        <span class="placement-status-badge ${committed ? 'badge-committed' : 'badge-draft'}">${committed ? 'Committed' : 'Draft'}</span>
        <span class="muted" style="font-size:12px;">
          ${committed && s.committed_at
            ? 'Committed ' + new Date(s.committed_at).toLocaleDateString()
            : 'Created ' + new Date(s.created_at).toLocaleDateString()}
        </span>
        ${!committed ? `<button class="btn btn-sm btn-outline delete-session-btn" data-id="${s.id}" data-label="${escHtml(s.label)}" style="color:#dc2626;border-color:#fca5a5;" title="Delete draft">
          <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
        </button>` : ''}
        <button class="btn btn-sm btn-outline open-session-btn" data-id="${s.id}">
          ${committed ? 'View' : 'Open Board'} <i data-lucide="arrow-right" style="width:14px;height:14px;"></i>
        </button>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.open-session-btn').forEach(btn => {
    btn.addEventListener('click', () => showBoard(btn.dataset.id));
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

/* ── Create form ── */
async function showCreateForm() {
  showView('placementCreateFormView');
  populateCreateFormYears();
  await loadEmployeesForForm();
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
      <input type="checkbox" value="${emp.id}" data-name="${escHtml(emp.first_name + ' ' + emp.last_name)}"${checked.has(emp.id) ? ' checked' : ''}>
      <div class="placement-teacher-check-info">
        <span class="placement-teacher-check-name">${escHtml(emp.last_name)}, ${escHtml(emp.first_name)}</span>
        ${emp.position ? `<span class="placement-teacher-check-type">${escHtml(emp.position)}</span>` : ''}
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

  const target = nextGrade(incoming);
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

  const { data: session, error: sessionErr } = await supabase
    .from('placement_sessions')
    .insert({
      school_id: _profile.school_id,
      academic_year: year,
      incoming_grade: incoming,
      target_grade: target,
      label,
      status: 'draft',
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

  await supabase.from('placement_session_teachers').insert(
    checked.map(t => ({ session_id: session.id, teacher_id: t.id, sort_order: t.sort_order }))
  );

  // Pre-populate assignments with all active students in the incoming grade (all unplaced)
  const { data: gradeStudents } = await supabase
    .from('students')
    .select('id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .eq('grade_level', incoming);

  if (gradeStudents && gradeStudents.length > 0) {
    await supabase.from('placement_assignments').insert(
      gradeStudents.map((s, i) => ({
        session_id: session.id,
        student_id: s.id,
        teacher_id: null,
        sort_order: i,
      }))
    );
  }

  btn.disabled = false;
  btn.textContent = 'Create Session';
  document.getElementById('placementLabel').value = '';
  document.getElementById('placementIncomingGrade').value = '';

  await showBoard(session.id);
}

/* ── Board ── */
async function showBoard(sessionId) {
  _currentSessionId = sessionId;
  _selectedStudentId = null;
  showView('placementBoardView');
  await loadBoardData(sessionId);
  renderBoard();
  updateSaveStatus('');
}

async function loadBoardData(sessionId) {
  const { data: session } = await supabase
    .from('placement_sessions')
    .select('id, label, academic_year, incoming_grade, target_grade, status')
    .eq('id', sessionId)
    .single();
  _session = session;

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
  const autoBtn = document.getElementById('autoPlacementBtn');
  if (autoBtn) autoBtn.disabled = isCommitted;

  // Teachers on this session
  const { data: sessionTeachers } = await supabase
    .from('placement_session_teachers')
    .select('teacher_id, sort_order')
    .eq('session_id', sessionId)
    .order('sort_order');

  if (sessionTeachers && sessionTeachers.length > 0) {
    const teacherIds = sessionTeachers.map(r => r.teacher_id);
    const { data: empData } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .in('id', teacherIds);

    const empMap = Object.fromEntries((empData || []).map(e => [e.id, e]));
    _teachers = sessionTeachers
      .map(r => empMap[r.teacher_id])
      .filter(Boolean);
  } else {
    _teachers = [];
  }

  // Assignments + student info
  const { data: assignments } = await supabase
    .from('placement_assignments')
    .select('student_id, teacher_id, sort_order')
    .eq('session_id', sessionId)
    .order('sort_order');

  _assignments = {};
  const studentIds = [];
  (assignments || []).forEach(a => {
    _assignments[a.student_id] = a.teacher_id ?? null;
    studentIds.push(a.student_id);
  });

  if (studentIds.length > 0) {
    const { data: stuData } = await supabase
      .from('students')
      .select('id, first_name, last_name, student_number')
      .in('id', studentIds);
    _students = stuData || [];
    // Sort by last name
    _students.sort((a, b) => a.last_name.localeCompare(b.last_name));
  } else {
    _students = [];
  }

  // Flags
  const { data: flags } = await supabase
    .from('placement_flags')
    .select('id, label, color, sort_order')
    .eq('school_id', _profile.school_id)
    .order('sort_order');
  _flags = flags || [];

  // Student flags
  _studentFlags = {};
  _students.forEach(s => { _studentFlags[s.id] = new Set(); });

  if (studentIds.length > 0) {
    const { data: sFlags } = await supabase
      .from('student_placement_flags')
      .select('student_id, flag_id')
      .in('student_id', studentIds);
    (sFlags || []).forEach(sf => {
      if (_studentFlags[sf.student_id]) _studentFlags[sf.student_id].add(sf.flag_id);
    });
  }
}

/* ── Render board ── */
function renderBoard() {
  const board = document.getElementById('placementBoard');
  if (!board) return;
  board.innerHTML = '';

  board.appendChild(buildColumn(null, 'Unplaced'));
  _teachers.forEach(t => board.appendChild(buildColumn(t.id, `${t.first_name} ${t.last_name}`)));
}

function buildColumn(teacherId, name) {
  const isUnplaced = teacherId === null;
  const colStudents = _students.filter(s =>
    isUnplaced
      ? (_assignments[s.id] == null)
      : (_assignments[s.id] === teacherId)
  );

  const col = document.createElement('div');
  col.className = 'placement-col';

  col.innerHTML = `
    <div class="placement-col-header ${isUnplaced ? 'col-unplaced' : 'col-teacher'}">
      <span class="placement-col-name">${escHtml(name)}</span>
      <span class="placement-col-count">${colStudents.length}</span>
    </div>
    <div class="placement-col-body" data-teacher-id="${teacherId ?? ''}"></div>
  `;

  const body = col.querySelector('.placement-col-body');

  body.addEventListener('dragover', e => { e.preventDefault(); body.classList.add('drag-over'); });
  body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
  body.addEventListener('drop', e => {
    e.preventDefault();
    body.classList.remove('drag-over');
    const studentId = e.dataTransfer.getData('text/plain');
    if (studentId) moveStudent(studentId, teacherId);
  });
  body.addEventListener('click', e => {
    if (_selectedStudentId && !e.target.closest('.placement-card')) {
      moveStudent(_selectedStudentId, teacherId);
    }
  });

  colStudents.forEach(s => body.appendChild(buildCard(s)));

  return col;
}

function buildCard(student) {
  const card = document.createElement('div');
  card.className = 'placement-card' + (_selectedStudentId === student.id ? ' selected' : '');
  card.dataset.studentId = student.id;
  card.draggable = true;

  card.innerHTML = `
    <div class="placement-card-name">${escHtml(student.last_name)}, ${escHtml(student.first_name)}</div>
    <div class="placement-card-footer">
      <div class="placement-flag-dots" data-dots-for="${student.id}"></div>
      <button class="placement-flag-btn" data-flag-for="${student.id}" title="Edit flags" tabindex="-1">
        <i data-lucide="tag" style="width:12px;height:12px;"></i>
      </button>
    </div>
  `;

  refreshFlagDots(card, student.id);

  card.addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/plain', student.id);
    card.classList.add('dragging');
    clearSelection();
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  card.addEventListener('click', e => {
    if (e.target.closest('.placement-flag-btn')) return;
    e.stopPropagation();
    if (_selectedStudentId === student.id) clearSelection();
    else selectCard(student.id);
  });

  card.querySelector('.placement-flag-btn').addEventListener('click', e => {
    e.stopPropagation();
    openFlagPopover(student.id, card);
  });

  if (window.lucide) lucide.createIcons({ nodes: Array.from(card.querySelectorAll('[data-lucide]')) });
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

/* ── Selection (click-to-move) ── */
function selectCard(studentId) {
  clearSelection();
  _selectedStudentId = studentId;
  document.querySelector(`.placement-card[data-student-id="${studentId}"]`)?.classList.add('selected');
  document.querySelectorAll('.placement-col-body').forEach(b => b.classList.add('click-target'));
}

function clearSelection() {
  _selectedStudentId = null;
  document.querySelectorAll('.placement-card.selected').forEach(c => c.classList.remove('selected'));
  document.querySelectorAll('.placement-col-body.click-target').forEach(b => b.classList.remove('click-target'));
}

/* ── Move student ── */
function moveStudent(studentId, teacherId) {
  _assignments[studentId] = teacherId;
  clearSelection();
  renderBoard();
  scheduleSave();
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

  if (_flags.length === 0) {
    pop.innerHTML = '<span class="muted" style="font-size:12px;padding:2px 0;">No flags configured.</span>';
  } else {
    const active = _studentFlags[studentId] || new Set();
    _flags.forEach(f => {
      const btn = document.createElement('button');
      btn.className = 'placement-flag-toggle' + (active.has(f.id) ? ' active' : '');
      btn.innerHTML = `<span class="placement-flag-dot" style="background:${f.color};width:10px;height:10px;display:inline-block;border-radius:50%;flex-shrink:0;"></span>${escHtml(f.label)}`;
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
  const estimatedHeight = _flags.length * 34 + 16;
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
      if (!pop.contains(e.target) && e.target !== flagBtn) {
        pop.remove();
        _flagPopoverStudentId = null;
        document.removeEventListener('click', close);
      }
    };
    document.addEventListener('click', close);
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

  const rows = _students.map((s, i) => ({
    session_id: _currentSessionId,
    student_id: s.id,
    teacher_id: _assignments[s.id] ?? null,
    sort_order: i,
  }));

  const { error } = await supabase
    .from('placement_assignments')
    .upsert(rows, { onConflict: 'session_id,student_id' });

  if (error) {
    console.error('Placement auto-save error:', error);
    updateSaveStatus('Save failed');
  } else {
    updateSaveStatus('Saved ✓');
    setTimeout(() => updateSaveStatus(''), 2500);
  }
}

function updateSaveStatus(msg) {
  const el = document.getElementById('placementSaveStatus');
  if (el) el.textContent = msg;
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

  const confirmed = confirm(
    `Commit class placement for "${_session.label}"?\n\n` +
    `  • ${placed} student${placed !== 1 ? 's' : ''} will have homeroom teacher updated\n` +
    (unplaced > 0 ? `  • ${unplaced} student${unplaced !== 1 ? 's' : ''} left unplaced (no change)\n\n` : '\n') +
    `This updates homeroom_teacher_id for all placed students.`
  );
  if (!confirmed) return;

  await runCommit();
}

async function runCommit() {
  const btn = document.getElementById('commitPlacementBtn');
  btn.disabled = true;
  btn.textContent = 'Committing…';

  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await saveAssignments();

  // Group placed students by teacher for batch updates
  const byTeacher = {};
  Object.entries(_assignments).forEach(([sid, tid]) => {
    if (!tid) return;
    if (!byTeacher[tid]) byTeacher[tid] = [];
    byTeacher[tid].push(sid);
  });

  const errors = [];
  for (const [tid, sids] of Object.entries(byTeacher)) {
    const { error } = await supabase
      .from('students')
      .update({ homeroom_teacher_id: tid })
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
  updateSaveStatus('');

  const placed = Object.values(_assignments).filter(v => v != null).length;
  alert(`Done! ${placed} student${placed !== 1 ? 's' : ''} assigned to their homeroom teacher.`);
}


import { supabase } from './admin.supabase.js';
import { esc, GRADE_ORDER, gradeLabel } from './admin.shared.js';

function showConfirmModal({ title, body, okLabel = 'Delete', danger = true }) {
  return new Promise(resolve => {
    const overlay  = document.getElementById('placementConfirmModal');
    const titleEl  = document.getElementById('placementConfirmTitle');
    const bodyEl   = document.getElementById('placementConfirmBody');
    const okBtn    = document.getElementById('placementConfirmOkBtn');
    const cancelBtn = document.getElementById('placementConfirmCancelBtn');

    titleEl.textContent = title;
    bodyEl.textContent  = body;
    okBtn.textContent = okLabel;
    if (danger) {
      okBtn.className = 'btn';
      okBtn.style.cssText = 'background:#dc2626;color:#fff;border-color:#dc2626;';
    } else {
      okBtn.className = 'btn btn-primary';
      okBtn.style.cssText = '';
    }
    overlay.hidden = false;

    function cleanup(result) {
      overlay.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk()     { cleanup(true);  }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

let _profile      = null;
let _schoolConfig = null;
let _showArchived = false;
let _showDeleted  = false;
let _formEmployees = [];
let _selectedTeacherIds = new Set();

function showPlacementView(id) {
  ['placementSessionListView', 'placementCreateFormView', 'placementBoardView'].forEach(v => {
    const el = document.getElementById(v);
    if (el) el.hidden = v !== id;
  });
}

function openBoard(sessionId) {
  document.dispatchEvent(new CustomEvent('placement:show-board', { detail: { sessionId } }));
}

// ═══════════════════════════════════════════════════════════════════════
// ENTRY
// ═══════════════════════════════════════════════════════════════════════

export function initSessions(profile, schoolConfig) {
  _profile      = profile;
  _schoolConfig = schoolConfig;
}

export function setShowArchived(val) {
  _showArchived = val;
}

export function setShowDeleted(val) {
  _showDeleted = val;
}

// ═══════════════════════════════════════════════════════════════════════
// SESSION LIST
// ═══════════════════════════════════════════════════════════════════════

export async function showSessionList() {
  showPlacementView('placementSessionListView');
  await renderSessionList();
}

export async function renderSessionList() {
  const container = document.getElementById('placementSessionList');
  if (!container) return;
  container.innerHTML = Array.from({ length: 2 }, () => `
    <div class="placement-session-card" style="pointer-events:none;opacity:.55;">
      <div class="placement-session-card-accent"></div>
      <div class="placement-session-card-body">
        <div class="placement-session-card-left">
          <div style="width:165px;height:16px;border-radius:4px;background:#e2e8f0;margin-bottom:10px;"></div>
          <div style="display:flex;gap:8px;align-items:center;">
            <div style="width:58px;height:20px;border-radius:10px;background:#e2e8f0;"></div>
            <div style="width:78px;height:20px;border-radius:10px;background:#e2e8f0;"></div>
            <div style="width:14px;height:12px;border-radius:2px;background:#edf0f5;"></div>
            <div style="width:78px;height:20px;border-radius:10px;background:#e2e8f0;"></div>
          </div>
        </div>
        <div class="placement-session-card-right">
          <div style="width:78px;height:22px;border-radius:12px;background:#e2e8f0;"></div>
        </div>
      </div>
    </div>`).join('');

  let query = supabase
    .from('placement_sessions')
    .select('id, label, academic_year, incoming_grade, target_grade, status, created_at, committed_at, target_class_size, archived_at, deleted_at')
    .eq('school_id', _profile.school_id)
    .order('created_at', { ascending: false });

  if (_showDeleted) {
    query = query.not('deleted_at', 'is', null);
  } else {
    query = query.is('deleted_at', null);
    if (!_showArchived) query = query.is('archived_at', null);
  }

  const { data, error } = await query;

  if (error) {
    container.innerHTML = '<p class="muted" style="font-size:13px;">Failed to load sessions.</p>';
    return;
  }

  if (!data || data.length === 0) {
    container.innerHTML = `
      <div class="placement-empty">
        ${_showDeleted
          ? '<p style="font-weight:600;margin:0 0 4px;">Trash is empty.</p><p class="muted" style="font-size:13px;margin:0;">Deleted boards appear here and can be restored.</p>'
          : '<p style="font-weight:600;margin:0 0 4px;">No placement sessions yet.</p><p class="muted" style="font-size:13px;margin:0;">Create a session to start placing students for the upcoming year.</p>'
        }
      </div>`;
    return;
  }

  container.innerHTML = '';
  data.forEach(s => {
    const row = document.createElement('div');
    const committed = s.status === 'committed';
    const archived  = !!s.archived_at;
    const deleted   = !!s.deleted_at;

    row.className = 'placement-session-card' +
      (committed ? ' placement-session-card--committed' : '') +
      (archived  ? ' placement-session-card--archived'  : '') +
      (deleted   ? ' placement-session-card--deleted'   : '');

    const dateLabel = deleted
      ? 'Deleted '    + new Date(s.deleted_at).toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' })
      : committed && s.committed_at
        ? 'Committed ' + new Date(s.committed_at).toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' })
        : 'Created '   + new Date(s.created_at).toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' });

    row.innerHTML = `
      <div class="placement-session-card-accent"></div>
      <div class="placement-session-card-body">
        <div class="placement-session-card-left">
          <div class="placement-session-label">${esc(s.label)}</div>
          <div class="placement-session-meta">
            <span class="placement-year-chip">${esc(s.academic_year.replace('-','–'))}</span>
            <span class="placement-grade-chip placement-grade-chip--to">${gradeLabel(s.incoming_grade)}</span>
            ${archived ? '<span class="placement-grade-chip" style="background:#f1f5f9;color:#64748b;">Archived</span>' : ''}
            ${deleted  ? '<span class="placement-grade-chip" style="background:#fef2f2;color:#dc2626;">Deleted</span>' : ''}
          </div>
        </div>
        <div class="placement-session-card-right">
          <div class="placement-session-card-status">
            ${deleted
              ? `<span class="placement-status-badge" style="background:#fef2f2;color:#dc2626;">Trash</span>`
              : `<span class="placement-status-badge ${committed ? 'badge-committed' : 'badge-draft'}">${committed ? 'Committed' : 'Draft'}</span>`
            }
            <span class="placement-session-date">${dateLabel}</span>
          </div>
          <div class="placement-session-card-actions">
            ${deleted ? `
              <button class="btn btn-sm btn-primary restore-session-btn" data-id="${s.id}" data-label="${esc(s.label)}" style="gap:6px;">
                <i data-lucide="rotate-ccw" style="width:13px;height:13px;"></i> Restore
              </button>
              <button class="psc-icon-btn psc-icon-btn--danger purge-session-btn" data-id="${s.id}" data-label="${esc(s.label)}" title="Delete permanently">
                <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
              </button>
            ` : `
              ${!archived ? `<button class="psc-icon-btn rename-session-btn" data-id="${s.id}" data-label="${esc(s.label)}" title="Rename board">
                <i data-lucide="pencil" style="width:14px;height:14px;"></i>
              </button>` : ''}
              <button class="psc-icon-btn clone-session-btn" data-idx="${data.indexOf(s)}" title="Clone to a new year">
                <i data-lucide="copy" style="width:14px;height:14px;"></i>
              </button>
              <button class="psc-icon-btn archive-session-btn" data-id="${s.id}" data-archived="${archived}" title="${archived ? 'Unarchive' : 'Archive'} session">
                <i data-lucide="${archived ? 'archive-restore' : 'archive'}" style="width:14px;height:14px;"></i>
              </button>
              ${!committed && !archived ? `<button class="psc-icon-btn psc-icon-btn--danger delete-session-btn" data-id="${s.id}" data-label="${esc(s.label)}" title="Move to trash">
                <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
              </button>` : ''}
              ${!archived ? `<button class="btn btn-sm ${committed ? 'btn-outline' : 'btn-primary'} open-session-btn" data-id="${s.id}" style="gap:6px;">
                ${committed ? 'View' : 'Open Board'} <i data-lucide="arrow-right" style="width:13px;height:13px;"></i>
              </button>` : ''}
            `}
          </div>
        </div>
      </div>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.open-session-btn').forEach(btn => {
    btn.addEventListener('click', () => openBoard(btn.dataset.id));
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
  container.querySelectorAll('.rename-session-btn').forEach(btn => {
    btn.addEventListener('click', () => renameSession(btn.dataset.id, btn.dataset.label));
  });
  container.querySelectorAll('.restore-session-btn').forEach(btn => {
    btn.addEventListener('click', () => restoreSession(btn.dataset.id, btn.dataset.label));
  });
  container.querySelectorAll('.purge-session-btn').forEach(btn => {
    btn.addEventListener('click', () => purgeSession(btn.dataset.id, btn.dataset.label));
  });

  if (window.lucide) lucide.createIcons({ nodes: Array.from(container.querySelectorAll('[data-lucide]')) });
}

async function renameSession(sessionId, currentLabel) {
  const name = prompt('Rename this board:', currentLabel ?? '');
  if (name === null) return;               // cancelled
  const trimmed = name.trim();
  if (!trimmed || trimmed === currentLabel) return;  // empty or unchanged

  const { error } = await supabase
    .from('placement_sessions')
    .update({ label: trimmed })
    .eq('id', sessionId)
    .eq('school_id', _profile.school_id);

  if (error) {
    console.error('Rename session error:', error);
    alert('Failed to rename the board. Check the console for details.');
    return;
  }

  await renderSessionList();
}

async function confirmDeleteSession(sessionId, label) {
  const confirmed = await showConfirmModal({
    title:   `Move "${label}" to Trash?`,
    body:    'The board and all its placements will be hidden but not permanently deleted. You can restore it from the Trash view.',
    okLabel: 'Move to Trash',
    danger:  false,
  });
  if (!confirmed) return;

  const { error } = await supabase
    .from('placement_sessions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('school_id', _profile.school_id);

  if (error) {
    console.error('Delete session error:', error);
    alert('Failed to move session to trash. Check the console for details.');
    return;
  }

  await renderSessionList();
}

async function restoreSession(sessionId, label) {
  const { error } = await supabase
    .from('placement_sessions')
    .update({ deleted_at: null })
    .eq('id', sessionId)
    .eq('school_id', _profile.school_id);

  if (error) {
    console.error('Restore session error:', error);
    alert('Failed to restore session. Check the console for details.');
    return;
  }

  await renderSessionList();
}

async function purgeSession(sessionId, label) {
  const confirmed = await showConfirmModal({
    title:   `Permanently delete "${label}"?`,
    body:    'This will remove the board and all its placements forever. This cannot be undone.',
    okLabel: 'Delete Forever',
    danger:  true,
  });
  if (!confirmed) return;

  const { error } = await supabase
    .from('placement_sessions')
    .delete()
    .eq('id', sessionId)
    .eq('school_id', _profile.school_id);

  if (error) {
    console.error('Purge session error:', error);
    alert('Failed to permanently delete session. Check the console for details.');
    return;
  }

  await renderSessionList();
}

async function archiveSession(id, archive) {
  const { error } = await supabase
    .from('placement_sessions')
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq('id', id)
    .eq('school_id', _profile.school_id);
  if (error) { console.error('Archive session error:', error); return; }
  await renderSessionList();
}

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
    .not('teacher_id', 'is', null)
    .order('sort_order');
  if (tErr) { alert('Failed to load session teachers.'); return; }

  const { data: newSession, error: sErr } = await supabase
    .from('placement_sessions')
    .insert({
      school_id:         _profile.school_id,
      academic_year:     newYear.trim(),
      incoming_grade:    original.incoming_grade,
      target_grade:      original.incoming_grade,
      label:             original.label,
      status:            'draft',
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

  openBoard(newSession.id);
}

function nextAcademicYear(year) {
  const parts = year.split('-');
  if (parts.length === 2) {
    const start = parseInt(parts[0], 10);
    if (!isNaN(start)) return `${start + 1}-${start + 2}`;
  }
  return year;
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE FORM
// ═══════════════════════════════════════════════════════════════════════

export async function showCreateForm() {
  showPlacementView('placementCreateFormView');
  populateCreateFormYears();
  populateGradeSelect();
  _selectedTeacherIds = new Set();
  const searchEl = document.getElementById('placementStaffSearch');
  if (searchEl) searchEl.value = '';
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

function populateGradeSelect() {
  const sel = document.getElementById('placementIncomingGrade');
  if (!sel) return;
  // The board manages a single grade: the students' actual (post-promotion)
  // grade level. Every configured grade is selectable, including the top grade.
  const grades = _schoolConfig?.grade_levels ?? GRADE_ORDER;
  sel.innerHTML = '<option value="">— Select grade —</option>';
  grades.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = gradeLabel(g);
    sel.appendChild(opt);
  });
}

async function loadEmployeesForForm() {
  const container = document.getElementById('placementTeacherCheckboxes');
  if (!container) return;
  container.innerHTML = '<p class="muted" style="font-size:13px;">Loading…</p>';

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
    campusFilter.addEventListener('change', () => renderEmployeeCheckboxes(campusFilter.value));
  }

  const sortSelect = document.getElementById('placementStaffSort');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      const campusId = document.getElementById('placementCampusFilter')?.value ?? '';
      renderEmployeeCheckboxes(campusId);
    });
  }

  const searchInput = document.getElementById('placementStaffSearch');
  if (searchInput) {
    searchInput.value = '';
    searchInput.addEventListener('input', () => {
      const campusId = document.getElementById('placementCampusFilter')?.value ?? '';
      renderEmployeeCheckboxes(campusId);
    });
  }

  const { data, error } = await supabase
    .from('employees')
    .select('id, first_name, last_name, position, campus_id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .order('last_name');

  if (error) {
    container.innerHTML = '<p class="muted" style="font-size:13px;">Failed to load employees.</p>';
    return;
  }

  _formEmployees = data || [];
  renderEmployeeCheckboxes('');
}

function renderEmployeeCheckboxes(campusId) {
  const container = document.getElementById('placementTeacherCheckboxes');
  if (!container) return;

  const sortBy     = document.getElementById('placementStaffSort')?.value ?? 'last_name';
  const searchTerm = (document.getElementById('placementStaffSearch')?.value ?? '').trim().toLowerCase();

  let filtered = campusId
    ? _formEmployees.filter(e => e.campus_id === campusId)
    : [..._formEmployees];

  if (searchTerm) {
    filtered = filtered.filter(e =>
      e.first_name.toLowerCase().includes(searchTerm) ||
      e.last_name.toLowerCase().includes(searchTerm) ||
      (e.position ?? '').toLowerCase().includes(searchTerm)
    );
  }

  filtered.sort((a, b) => {
    if (sortBy === 'first_name') return a.first_name.localeCompare(b.first_name);
    if (sortBy === 'position')   return (a.position ?? '').localeCompare(b.position ?? '');
    return a.last_name.localeCompare(b.last_name);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<p class="muted" style="font-size:13px;">${searchTerm ? 'No employees match your search.' : 'No employees found.'}</p>`;
    return;
  }

  container.innerHTML = '';
  filtered.forEach(emp => {
    const label = document.createElement('label');
    label.className = 'placement-teacher-check';
    label.innerHTML = `
      <input type="checkbox" value="${emp.id}" data-name="${esc(emp.first_name + ' ' + emp.last_name)}"${_selectedTeacherIds.has(emp.id) ? ' checked' : ''}>
      <div class="placement-teacher-check-info">
        <span class="placement-teacher-check-name">${esc(emp.last_name)}, ${esc(emp.first_name)}</span>
        ${emp.position ? `<span class="placement-teacher-check-type">${esc(emp.position)}</span>` : ''}
      </div>
    `;
    const cb = label.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      if (cb.checked) _selectedTeacherIds.add(emp.id);
      else _selectedTeacherIds.delete(emp.id);
    });
    container.appendChild(label);
  });
}

export async function submitCreateForm() {
  const year     = document.getElementById('placementYear')?.value;
  const grade    = document.getElementById('placementIncomingGrade')?.value;
  const labelInput = document.getElementById('placementLabel')?.value.trim();

  if (!year || !grade) {
    alert('Please select a year and grade.');
    return;
  }

  const label  = labelInput || `${gradeLabel(grade)} Placement`;

  const checked = _formEmployees
    .filter(e => _selectedTeacherIds.has(e.id))
    .map((e, i) => ({ id: e.id, name: `${e.first_name} ${e.last_name}`, sort_order: i }));

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
      school_id:         _profile.school_id,
      academic_year:     year,
      incoming_grade:    grade,
      target_grade:      grade,
      label,
      status:            'draft',
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

  const { data: gradeStudents } = await supabase
    .from('students')
    .select('id')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .eq('grade_level', grade);

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

  openBoard(session.id);
}

export function getFormEmployees() {
  return _formEmployees;
}

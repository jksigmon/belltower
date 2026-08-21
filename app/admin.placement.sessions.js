
import { supabase } from './admin.supabase.js?v=2';
import { esc, GRADE_ORDER, gradeLabel, invalidateSchoolConfigCache } from './admin.shared.js?v=3';

export function showConfirmModal({ title, body, okLabel = 'Delete', danger = true }) {
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
let _showAllYears = false;
let _formEmployees = [];
let _selectedTeacherIds = new Set();
let _periods      = [];   // schedule_periods for this school, active only

/* A board is "live" once it has been applied to the world: a committed
   homeroom board has written students.homeroom_teacher_id, a published
   section board is visible to teachers. The two differ in what that means
   for editing -- a published section stays fully editable, a committed
   homeroom does not -- so callers check isLive() plus the kind, never
   `status === 'committed'` on its own. */
export function isLive(session) {
  return session?.status === 'committed' || session?.status === 'published';
}

export function isSection(session) {
  return session?.session_kind === 'section';
}

/* Schools with uses_homerooms = false have no homeroom to commit to, so
   every board there is a section. */
export function homeroomBoardsAllowed(schoolConfig) {
  return schoolConfig?.uses_homerooms !== false;
}

export async function loadPeriods(schoolId) {
  const { data, error } = await supabase
    .from('schedule_periods')
    .select('id, label, short_label, grade_levels, sort_order')
    .eq('school_id', schoolId)
    .is('archived_at', null)
    .order('sort_order');
  if (error) { console.error('Failed to load periods', error); return []; }
  _periods = data ?? [];
  return _periods;
}

export function getPeriods() { return _periods; }

/* NULL grade_levels means the period applies to every grade (e.g. a
   school-wide Advisory). */
export function periodsForGrade(grade) {
  if (!grade) return _periods;
  return _periods.filter(p => !p.grade_levels?.length || p.grade_levels.includes(grade));
}

export function periodLabel(periodId) {
  return _periods.find(p => p.id === periodId)?.label ?? null;
}

function showPlacementView(id) {
  ['placementSessionListView', 'placementCreateFormView', 'placementBoardView', 'placementGridView'].forEach(v => {
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

export async function initSessions(profile, schoolConfig) {
  _profile      = profile;
  _schoolConfig = schoolConfig;
  // Awaited by the caller: periodLabel() is read during the first board
  // paint, so resolving this later would drop the period chip until the
  // next render.
  await loadPeriods(profile.school_id);
}

export function setShowArchived(val) {
  _showArchived = val;
}

export function setShowDeleted(val) {
  _showDeleted = val;
}

export function setShowAllYears(val) {
  _showAllYears = val;
}

// ═══════════════════════════════════════════════════════════════════════
// SESSION LIST
// ═══════════════════════════════════════════════════════════════════════

export async function showSessionList() {
  showPlacementView('placementSessionListView');
  await Promise.all([renderSessionList(), renderCurrentYearControl()]);
}

// ═══════════════════════════════════════════════════════════════════════
// CURRENT ACADEMIC YEAR
// ═══════════════════════════════════════════════════════════════════════
// schools.current_academic_year is what every schedule read surface (My
// Roster tabs, Student Lookup, the admin grid) filters on to show this
// year's classes instead of every year ever committed or published. The
// migration backfills it from each school's newest board, but a school
// created after that backfill -- or one whose boards all got trashed --
// can end up with it null, which would make every schedule view silently
// render empty with no clue why. Surfacing it here, on the page that
// already owns academic_year end to end, means an admin builds a board
// and can set the year in the same breath.

async function distinctAcademicYears() {
  const { data } = await supabase
    .from('placement_sessions')
    .select('academic_year')
    .eq('school_id', _profile.school_id)
    .is('deleted_at', null);

  const years = new Set((data ?? []).map(r => r.academic_year).filter(Boolean));
  // Always offer this year and next, even for a school with no boards yet.
  const now = new Date().getFullYear();
  years.add(`${now}-${now + 1}`);
  years.add(`${now + 1}-${now + 2}`);
  return [...years].sort().reverse();
}

export async function renderCurrentYearControl() {
  const wrap = document.getElementById('currentYearControl');
  if (!wrap) return;

  const current = _schoolConfig?.current_academic_year ?? null;

  if (!current) {
    wrap.innerHTML = `
      <div class="placement-year-warning">
        <i data-lucide="triangle-alert" style="width:14px;height:14px;flex-shrink:0;"></i>
        <span>No current year set — schedules won't show to teachers until this is set.</span>
        <button class="btn btn-sm btn-primary" id="setCurrentYearBtn" style="height:26px;padding:0 10px;">Set current year</button>
      </div>`;
  } else {
    wrap.innerHTML = `
      <div class="placement-year-chip-row">
        <span class="muted" style="font-size:12px;">Current year:</span>
        <span class="placement-year-chip">${esc(current.replace('-', '–'))}</span>
        <button class="psc-icon-btn" id="setCurrentYearBtn" title="Change current year">
          <i data-lucide="pencil" style="width:12px;height:12px;"></i>
        </button>
      </div>`;
  }
  if (window.lucide) lucide.createIcons({ nodes: [wrap] });
  document.getElementById('setCurrentYearBtn')?.addEventListener('click', openCurrentYearEditor);
}

async function openCurrentYearEditor() {
  const wrap = document.getElementById('currentYearControl');
  if (!wrap) return;

  const years = await distinctAcademicYears();
  const current = _schoolConfig?.current_academic_year ?? '';

  wrap.innerHTML = `
    <div class="placement-year-chip-row">
      <span class="muted" style="font-size:12px;">Current year:</span>
      <select id="currentYearSelect" class="form-input" style="height:28px;font-size:12px;padding:0 6px;width:auto;">
        ${years.map(y => `<option value="${esc(y)}" ${y === current ? 'selected' : ''}>${esc(y.replace('-', '–'))}</option>`).join('')}
      </select>
      <button class="btn btn-sm btn-primary" id="saveCurrentYearBtn" style="height:26px;padding:0 10px;">Save</button>
      <button class="btn btn-sm btn-outline" id="cancelCurrentYearBtn" style="height:26px;padding:0 10px;">Cancel</button>
    </div>`;

  document.getElementById('saveCurrentYearBtn')?.addEventListener('click', async () => {
    const value = document.getElementById('currentYearSelect')?.value;
    if (!value) return;
    const { error } = await supabase
      .from('schools')
      .update({ current_academic_year: value })
      .eq('id', _profile.school_id);
    if (error) { alert('Failed to save the current year: ' + error.message); return; }

    if (_schoolConfig) _schoolConfig.current_academic_year = value;
    invalidateSchoolConfigCache(_profile.school_id);
    // The session list defaults to filtering by this value -- without
    // re-rendering it too, changing the year here would look like it did
    // nothing until the admin navigated away and back.
    await Promise.all([renderCurrentYearControl(), renderSessionList()]);
  });
  document.getElementById('cancelCurrentYearBtn')?.addEventListener('click', renderCurrentYearControl);
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
    .select('id, label, academic_year, incoming_grade, target_grade, status, created_at, committed_at, target_class_size, archived_at, deleted_at, sort_order, session_kind, period_id, published_at')
    .eq('school_id', _profile.school_id)
    .order('sort_order', { ascending: true });

  // Defaults to the current year so the list matches "I set the year, now
  // I see this year's boards" rather than an ever-growing all-time list
  // that only a small chip distinguishes. Falls back to unfiltered when no
  // current year is set yet -- same principle as everywhere else this
  // field is read: an unset year should never mean "show nothing."
  //
  // Deliberately NOT applied to Trash: recovering an accidentally-deleted
  // board is rare and deliberate, and year-filtering it risks "Trash is
  // empty" being a lie when an older board is sitting in there.
  const currentYear = _schoolConfig?.current_academic_year;
  const yearFiltered = !_showDeleted && !_showAllYears && !!currentYear;

  if (_showDeleted) {
    query = query.not('deleted_at', 'is', null);
  } else {
    query = query.is('deleted_at', null);
    if (!_showArchived) query = query.is('archived_at', null);
    if (yearFiltered) query = query.eq('academic_year', currentYear);
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
          : yearFiltered
            ? `<p style="font-weight:600;margin:0 0 4px;">No boards for ${esc(currentYear.replace('-','–'))}.</p><p class="muted" style="font-size:13px;margin:0;">Check "Show all years" if you're looking for an older board, or create a new session for this year.</p>`
            : '<p style="font-weight:600;margin:0 0 4px;">No placement sessions yet.</p><p class="muted" style="font-size:13px;margin:0;">Create a session to start placing students for the upcoming year.</p>'
        }
      </div>`;
    return;
  }

  container.innerHTML = '';
  data.forEach(s => {
    const row = document.createElement('div');
    const committed = s.status === 'committed';
    const published = s.status === 'published';
    const section   = isSection(s);
    const archived  = !!s.archived_at;
    const deleted   = !!s.deleted_at;

    row.className = 'placement-session-card' +
      (committed ? ' placement-session-card--committed' : '') +
      (published ? ' placement-session-card--published' : '') +
      (archived  ? ' placement-session-card--archived'  : '') +
      (deleted   ? ' placement-session-card--deleted'   : '');

    const reorderable = !deleted;
    if (reorderable) {
      row.draggable = true;
      row.dataset.id = s.id;
    }

    const shortDate = d => new Date(d).toLocaleDateString([], { month:'short', day:'numeric', year:'numeric' });
    const dateLabel = deleted
      ? 'Deleted '   + shortDate(s.deleted_at)
      : committed && s.committed_at
        ? 'Committed ' + shortDate(s.committed_at)
        : published && s.published_at
          ? 'Published ' + shortDate(s.published_at)
          : 'Created '   + shortDate(s.created_at);

    const periodName = s.period_id ? periodLabel(s.period_id) : null;

    row.innerHTML = `
      <div class="placement-session-card-accent"></div>
      <div class="placement-session-card-body">
        ${reorderable ? `<div class="placement-session-drag-handle" title="Drag to reorder">
          <i data-lucide="grip-vertical" style="width:16px;height:16px;"></i>
        </div>` : ''}
        <div class="placement-session-card-left">
          <div class="placement-session-label">${esc(s.label)}</div>
          <div class="placement-session-meta">
            <span class="placement-year-chip">${esc(s.academic_year.replace('-','–'))}</span>
            <span class="placement-grade-chip placement-grade-chip--to">${gradeLabel(s.incoming_grade)}</span>
            <span class="placement-kind-chip placement-kind-chip--${section ? 'section' : 'homeroom'}">${section ? 'Section' : 'Homeroom'}</span>
            ${periodName ? `<span class="placement-period-chip">${esc(periodName)}</span>` : ''}
            ${archived ? '<span class="placement-grade-chip" style="background:#f1f5f9;color:#64748b;">Archived</span>' : ''}
            ${deleted  ? '<span class="placement-grade-chip" style="background:#fef2f2;color:#dc2626;">Deleted</span>' : ''}
          </div>
        </div>
        <div class="placement-session-card-right">
          <div class="placement-session-card-status">
            ${deleted
              ? `<span class="placement-status-badge" style="background:#fef2f2;color:#dc2626;">Trash</span>`
              : published
                ? `<span class="placement-status-badge badge-published">Published</span>`
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
              ${(!committed && !published && !archived) ? `<button class="psc-icon-btn change-kind-session-btn" data-id="${s.id}" title="Change board type">
                <i data-lucide="repeat" style="width:14px;height:14px;"></i>
              </button>` : ''}
              <button class="psc-icon-btn clone-session-btn" data-idx="${data.indexOf(s)}" title="Clone to a new year">
                <i data-lucide="copy" style="width:14px;height:14px;"></i>
              </button>
              <button class="psc-icon-btn archive-session-btn" data-id="${s.id}" data-archived="${archived}" title="${archived ? 'Unarchive' : 'Archive'} session">
                <i data-lucide="${archived ? 'archive-restore' : 'archive'}" style="width:14px;height:14px;"></i>
              </button>
              ${!committed && !published && !archived ? `<button class="psc-icon-btn psc-icon-btn--danger delete-session-btn" data-id="${s.id}" data-label="${esc(s.label)}" title="Move to trash">
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
  container.querySelectorAll('.change-kind-session-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const session = data.find(s => s.id === btn.dataset.id);
      if (session) openChangeKindModal(session);
    });
  });
  container.querySelectorAll('.restore-session-btn').forEach(btn => {
    btn.addEventListener('click', () => restoreSession(btn.dataset.id, btn.dataset.label));
  });
  container.querySelectorAll('.purge-session-btn').forEach(btn => {
    btn.addEventListener('click', () => purgeSession(btn.dataset.id, btn.dataset.label));
  });

  wireSessionReorder(container);

  if (window.lucide) lucide.createIcons({ nodes: Array.from(container.querySelectorAll('[data-lucide]')) });
}

function wireSessionReorder(container) {
  let draggedRow = null;

  container.querySelectorAll('.placement-session-card[draggable="true"]').forEach(row => {
    row.addEventListener('dragstart', () => {
      draggedRow = row;
      row.classList.add('placement-session-card--dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('placement-session-card--dragging');
      draggedRow = null;
    });
    row.addEventListener('dragover', e => {
      if (!draggedRow || draggedRow === row) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.parentNode.insertBefore(draggedRow, before ? row : row.nextSibling);
    });
    row.addEventListener('drop', e => e.preventDefault());
  });

  container.addEventListener('dragend', () => persistSessionOrder(container));
}

async function persistSessionOrder(container) {
  const ids = Array.from(container.querySelectorAll('.placement-session-card[data-id]')).map(r => r.dataset.id);
  if (ids.length < 2) return;

  const updates = ids.map((id, i) =>
    supabase.from('placement_sessions').update({ sort_order: i }).eq('id', id).eq('school_id', _profile.school_id)
  );
  const results = await Promise.all(updates);
  if (results.some(r => r.error)) {
    console.error('Failed to save session order:', results.find(r => r.error).error);
  }
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

/* Lets a still-draft board switch between homeroom and section, and set
   or change its period -- the piece that was missing for converting an
   EXISTING Core/Block board built before this feature shipped. Only
   reachable while draft (the button is hidden otherwise); the DB trigger
   enforces the same rule server-side, so a stale button click after
   someone else committed the board in another tab still fails safely
   with a readable error rather than corrupting anything. */
export function openChangeKindModal(session, onSaved) {
  const modal    = document.getElementById('changeKindModal');
  const homeroom = document.getElementById('changeKindHomeroom');
  const section  = document.getElementById('changeKindSection');
  if (!modal || !homeroom || !section) return;

  homeroom.checked = session.session_kind !== 'section';
  section.checked  = session.session_kind === 'section';

  const sync = () => {
    populateChangeKindPeriods(session.incoming_grade, session.period_id);
    const isSec = section.checked;
    const hint = document.getElementById('changeKindHint');
    if (hint) {
      hint.textContent = isSec
        ? 'Publishing this board shows it to teachers as part of the student’s schedule. It does not change anyone’s homeroom.'
        : 'Committing this board sets each student’s homeroom teacher, which drives dismissal, rosters, and compliance reporting.';
      hint.className = `placement-kind-hint placement-kind-hint--${isSec ? 'section' : 'homeroom'}`;
    }
    const periodLbl = document.getElementById('changeKindPeriodLabel');
    if (periodLbl) periodLbl.innerHTML = isSec
      ? 'Period'
      : 'Period <span class="muted" style="font-weight:400;">(optional)</span>';
  };
  homeroom.onchange = sync;
  section.onchange  = sync;
  sync();

  modal.hidden = false;

  const confirmBtn = document.getElementById('changeKindConfirmBtn');
  const cancelBtn  = document.getElementById('changeKindCancelBtn');
  const cleanup = () => { modal.hidden = true; };

  // .onclick, not addEventListener: this modal is a single shared instance
  // reopened per card, and addEventListener here would stack a new handler
  // on every open -- the second board converted would also re-save the
  // first one's values.
  cancelBtn.onclick = cleanup;
  confirmBtn.onclick = async () => {
    const newKind  = section.checked ? 'section' : 'homeroom';
    const periodId = document.getElementById('changeKindPeriod')?.value || null;

    if (newKind === 'section' && !periodId) {
      alert('Pick a period for this section board. Teachers need it to know where the class sits in the day.');
      return;
    }

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Saving…';
    const { error } = await supabase
      .from('placement_sessions')
      .update({ session_kind: newKind, period_id: periodId })
      .eq('id', session.id)
      .eq('school_id', _profile.school_id);
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Save';

    if (error) {
      alert(error.message || 'Failed to change the board type.');
      return;
    }
    cleanup();
    // From the session list, refresh the list. From an open board (the
    // board-view toolbar button), the caller passes its own callback to
    // update the board in place instead -- there's no list on screen to
    // refresh, and reloading the whole board is unnecessary for a change
    // that only touched two columns on placement_sessions.
    if (onSaved) await onSaved(newKind, periodId);
    else await renderSessionList();
  };
}

function populateChangeKindPeriods(grade, selectedPeriodId) {
  const sel = document.getElementById('changeKindPeriod');
  if (!sel) return;
  const list = periodsForGrade(grade);
  sel.innerHTML = '<option value="">— None —</option>' +
    list.map(p => `<option value="${esc(p.id)}" ${p.id === selectedPeriodId ? 'selected' : ''}>${esc(p.label)}</option>`).join('');
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

async function nextTopSortOrder() {
  const { data } = await supabase
    .from('placement_sessions')
    .select('sort_order')
    .eq('school_id', _profile.school_id)
    .order('sort_order', { ascending: true })
    .limit(1);
  return data?.length ? data[0].sort_order - 1 : 0;
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
      sort_order:        await nextTopSortOrder(),
      // Without these the clone of a section board comes back as a homeroom
      // board, and committing it would rewrite every student's homeroom.
      session_kind:      original.session_kind ?? 'homeroom',
      period_id:         original.period_id ?? null,
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
// PERIODS
// ═══════════════════════════════════════════════════════════════════════

export async function openPeriodsModal() {
  await loadPeriods(_profile.school_id);
  renderPeriodsList();
  renderPeriodGradePicker();
  const labelEl = document.getElementById('newPeriodLabel');
  if (labelEl) labelEl.value = '';
  document.getElementById('periodsModal').hidden = false;
}

function renderPeriodGradePicker() {
  const wrap = document.getElementById('newPeriodGrades');
  if (!wrap) return;
  const grades = _schoolConfig?.grade_levels ?? GRADE_ORDER;
  wrap.innerHTML = grades.map(g =>
    `<label class="placement-grade-pick"><input type="checkbox" value="${esc(g)}"> ${esc(gradeLabel(g))}</label>`
  ).join('');
}

function renderPeriodsList() {
  const wrap = document.getElementById('periodsList');
  if (!wrap) return;

  if (!_periods.length) {
    wrap.innerHTML = '<p class="muted" style="font-size:13px;margin:0;">No periods yet. Add your first one below.</p>';
    return;
  }

  wrap.innerHTML = _periods.map(p => {
    const scope = p.grade_levels?.length
      ? p.grade_levels.map(g => gradeLabel(g)).join(', ')
      : 'All grades';
    return `
      <div class="placement-period-row">
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:14px;">${esc(p.label)}</div>
          <div class="muted" style="font-size:12px;">${esc(scope)}</div>
        </div>
        <button class="psc-icon-btn psc-icon-btn--danger archive-period-btn" data-id="${p.id}" data-label="${esc(p.label)}" title="Remove period">
          <i data-lucide="trash-2" style="width:14px;height:14px;"></i>
        </button>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.archive-period-btn').forEach(btn =>
    btn.addEventListener('click', () => archivePeriod(btn.dataset.id, btn.dataset.label))
  );
  if (window.lucide) lucide.createIcons({ nodes: [wrap] });
}

export async function addPeriod() {
  const labelEl = document.getElementById('newPeriodLabel');
  const label   = labelEl?.value.trim();
  if (!label) { alert('Give the period a name.'); return; }

  const grades = [...document.querySelectorAll('#newPeriodGrades input:checked')].map(c => c.value);

  const { error } = await supabase.from('schedule_periods').insert({
    school_id:    _profile.school_id,
    label,
    grade_levels: grades.length ? grades : null,
    sort_order:   _periods.length,
  });

  if (error) {
    alert(error.code === '23505'
      ? `There is already a period called “${label}”.`
      : 'Failed to add the period: ' + error.message);
    return;
  }

  labelEl.value = '';
  document.querySelectorAll('#newPeriodGrades input:checked').forEach(c => { c.checked = false; });
  await loadPeriods(_profile.school_id);
  renderPeriodsList();
}

/* Archived rather than deleted: placement_sessions.period_id is ON DELETE
   SET NULL, so a hard delete would silently strip the period off every
   board that used it -- including published ones, which would then be
   sections with nowhere to sit in the day. */
async function archivePeriod(id, label) {
  const { count } = await supabase
    .from('placement_sessions')
    .select('id', { count: 'exact', head: true })
    .eq('school_id', _profile.school_id)
    .eq('period_id', id)
    .is('deleted_at', null);

  const inUse = count ?? 0;
  const ok = await showConfirmModal({
    title: 'Remove Period',
    body: inUse
      ? `“${label}” is used by ${inUse} board${inUse !== 1 ? 's' : ''}. Removing it hides it from new boards; those boards keep their period.`
      : `Remove “${label}”?`,
    okLabel: 'Remove',
  });
  if (!ok) return;

  const { error } = await supabase
    .from('schedule_periods')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id);

  if (error) { alert('Failed to remove the period.'); return; }
  await loadPeriods(_profile.school_id);
  renderPeriodsList();
}

// ═══════════════════════════════════════════════════════════════════════
// GRID — every live board this year, by period × grade
// ═══════════════════════════════════════════════════════════════════════
// A quick-scan view of the schedule as a whole, the way an admin actually
// thinks about it: which grades have which classes in which period, and
// is anything missing. Rows are periods (Homeroom first, since it's the
// one slot every K-7 board defaults into), columns are grades.

export async function showGrid() {
  showPlacementView('placementGridView');
  await renderGrid();
}

export async function renderGrid() {
  const wrap = document.getElementById('placementGridWrap');
  if (!wrap) return;

  const year = _schoolConfig?.current_academic_year;
  if (!year) {
    wrap.innerHTML = `<p class="muted" style="padding:20px 0;">Set a current academic year on the sessions list first — the grid reads live boards for that year.</p>`;
    return;
  }

  wrap.innerHTML = `<p class="muted" style="padding:20px 0;">Loading…</p>`;

  const { data: sessions, error } = await supabase
    .from('placement_sessions')
    .select('id, label, incoming_grade, session_kind, period_id, status')
    .eq('school_id', _profile.school_id)
    .eq('academic_year', year)
    .in('status', ['committed', 'published'])
    .is('deleted_at', null)
    .is('archived_at', null);

  if (error) { wrap.innerHTML = `<p class="muted" style="padding:20px 0;">Failed to load the grid.</p>`; return; }

  if (!sessions?.length) {
    wrap.innerHTML = `<p class="muted" style="padding:20px 0;">No committed or published boards for ${esc(year.replace('-', '–'))} yet.</p>`;
    return;
  }

  // One query for every visible board's headcount, grouped client-side --
  // cheaper than a per-session count query, and the row count here is
  // bounded by one school's live rosters, not the whole database.
  const sessionIds = sessions.map(s => s.id);
  const { data: assignments } = await supabase
    .from('placement_assignments')
    .select('session_id, teacher_id, assigned_col_id')
    .in('session_id', sessionIds);

  const countBySession = {};
  (assignments ?? []).forEach(a => {
    if (a.teacher_id == null && a.assigned_col_id == null) return;
    countBySession[a.session_id] = (countBySession[a.session_id] ?? 0) + 1;
  });

  const grades = _schoolConfig?.grade_levels ?? GRADE_ORDER;

  // Homeroom row: homeroom-kind boards with no period (the common case).
  // A homeroom that doubles as a period ("Core 1 & HR") sorts into that
  // period's own row instead, via period_id -- not duplicated into both.
  const homeroomRow = { key: 'homeroom', label: 'Homeroom', sessions: sessions.filter(s => s.session_kind === 'homeroom' && !s.period_id) };
  const periodRows = _periods.map(p => ({ key: p.id, label: p.label, sessions: sessions.filter(s => s.period_id === p.id) }));
  const rows = [homeroomRow, ...periodRows].filter(r => r.sessions.length > 0);

  if (!rows.length) {
    wrap.innerHTML = `<p class="muted" style="padding:20px 0;">No committed or published boards for ${esc(year.replace('-', '–'))} yet.</p>`;
    return;
  }

  const cell = (row, grade) => {
    const cellSessions = row.sessions.filter(s => s.incoming_grade === grade);
    if (!cellSessions.length) return `<td class="placement-grid-cell placement-grid-cell--empty">—</td>`;
    return `<td class="placement-grid-cell">${cellSessions.map(s => `
      <button type="button" class="placement-grid-pill placement-grid-pill--${s.status}" data-id="${s.id}">
        <span class="placement-grid-pill-label">${esc(s.label)}</span>
        <span class="placement-grid-pill-count">${countBySession[s.id] ?? 0} students</span>
      </button>`).join('')}</td>`;
  };

  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="admin-table placement-grid-table">
        <thead><tr><th>Period</th>${grades.map(g => `<th>${esc(gradeLabel(g))}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map(row => `<tr><td class="placement-grid-row-label">${esc(row.label)}</td>${grades.map(g => cell(row, g)).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;

  wrap.querySelectorAll('.placement-grid-pill').forEach(btn =>
    btn.addEventListener('click', () => openBoard(btn.dataset.id))
  );
}

// ═══════════════════════════════════════════════════════════════════════
// CREATE FORM
// ═══════════════════════════════════════════════════════════════════════

export async function showCreateForm() {
  showPlacementView('placementCreateFormView');
  populateCreateFormYears();
  populateGradeSelect();
  await loadPeriods(_profile.school_id);
  setupBoardKindControls();
  _selectedTeacherIds = new Set();
  const searchEl = document.getElementById('placementStaffSearch');
  if (searchEl) searchEl.value = '';
  await loadEmployeesForForm();
}

/* Board type + period. At a school with uses_homerooms = false there is no
   homeroom to commit to, so the choice is meaningless -- the whole control
   is hidden and every board is created as a section. */
function setupBoardKindControls() {
  const wrap      = document.getElementById('placementKindWrap');
  const homeroom  = document.getElementById('placementKindHomeroom');
  const section   = document.getElementById('placementKindSection');
  const gradeSel  = document.getElementById('placementIncomingGrade');
  const allowed   = homeroomBoardsAllowed(_schoolConfig);

  if (wrap) wrap.hidden = !allowed;
  if (homeroom) homeroom.checked = allowed;
  if (section)  section.checked  = !allowed;

  const sync = () => {
    populatePeriodSelect(gradeSel?.value ?? '');
    const isSec = !!section?.checked;
    const hint  = document.getElementById('placementKindHint');
    if (hint) {
      hint.textContent = isSec
        ? 'Publishing this board shows it to teachers as part of the student’s schedule. It does not change anyone’s homeroom.'
        : 'Committing this board sets each student’s homeroom teacher, which drives dismissal, rosters, and compliance reporting.';
      hint.className = `placement-kind-hint placement-kind-hint--${isSec ? 'section' : 'homeroom'}`;
    }
    // A period is what makes a section addressable in a schedule, so it is
    // required there. On a homeroom board it stays optional -- it only
    // matters when the homeroom doubles as a period ("Core 1 & HR").
    const periodLbl = document.getElementById('placementPeriodLabel');
    if (periodLbl) periodLbl.innerHTML = isSec
      ? 'Period'
      : 'Period <span class="muted" style="font-weight:400;">(optional)</span>';
  };

  homeroom?.addEventListener('change', sync);
  section?.addEventListener('change', sync);
  gradeSel?.addEventListener('change', () => populatePeriodSelect(gradeSel.value));
  sync();
}

function populatePeriodSelect(grade) {
  const sel = document.getElementById('placementPeriod');
  if (!sel) return;
  const prev = sel.value;
  const list = periodsForGrade(grade);
  sel.innerHTML = '<option value="">— None —</option>';
  list.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
  if (prev && list.some(p => p.id === prev)) sel.value = prev;

  const empty = document.getElementById('placementPeriodEmpty');
  if (empty) empty.hidden = list.length > 0;
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

  const sessionKind = document.getElementById('placementKindSection')?.checked ? 'section' : 'homeroom';
  const periodId    = document.getElementById('placementPeriod')?.value || null;

  // A section with no period cannot be placed in a schedule -- it would
  // publish and then show up nowhere, which reads as the feature being broken.
  if (sessionKind === 'section' && !periodId) {
    alert('Pick a period for this section board. Teachers need it to know where the class sits in the day.');
    return;
  }

  const label  = labelInput ||
    (sessionKind === 'section' && periodId
      ? `${gradeLabel(grade)} ${periodLabel(periodId)}`
      : `${gradeLabel(grade)} Placement`);

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
      sort_order:        await nextTopSortOrder(),
      session_kind:      sessionKind,
      period_id:         periodId,
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

  // Loading the whole grade is right for a homeroom board and for cores,
  // where every student in the grade is placed somewhere. It is wrong for
  // an elective, where only the students who signed up belong on the board
  // -- so that case starts empty and students are added individually.
  const startEmpty = document.getElementById('placementStartEmpty')?.checked;

  if (!startEmpty) {
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

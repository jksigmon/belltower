
import { supabase } from './admin.supabase.js';

/* ─── Grade progression ─────────────────────────────────────── */
const GRADE_ORDER = ['PK', 'K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];

function nextGrade(grade) {
  const idx = GRADE_ORDER.indexOf(grade);
  if (idx < 0 || idx >= GRADE_ORDER.length - 1) return null;
  return GRADE_ORDER[idx + 1];
}

function isTerminalGrade(grade) {
  return grade === '12';
}

function gradeLabel(grade) {
  if (!grade) return 'Unknown';
  if (grade === 'PK') return 'Pre-K';
  if (grade === 'K') return 'Kindergarten';
  const n = parseInt(grade);
  if (!isNaN(n)) {
    const v = n % 100;
    const suffix = (v >= 11 && v <= 13) ? 'th' : (['th','st','nd','rd'][v % 10] || 'th');
    return `${n}${suffix} Grade`;
  }
  return `Grade ${grade}`;
}

/* ─── Module state ──────────────────────────────────────────── */
let _profile = null;
let _students = [];
let _actionMap = {};   // studentId → 'promote' | 'retain' | 'graduate'
let _initialized = false;

/* ─── Draft persistence ─────────────────────────────────────── */
function draftKey() {
  const campusId = document.getElementById('promotionCampus')?.value || 'all';
  return `promo_draft_${_profile.school_id}_${campusId}`;
}

function saveDraft() {
  const year = document.getElementById('promotionAcademicYear')?.value ?? '';
  const campusId = document.getElementById('promotionCampus')?.value || '';
  const draft = { savedAt: new Date().toISOString(), year, campusId, students: _students, actionMap: _actionMap };
  try { localStorage.setItem(draftKey(), JSON.stringify(draft)); } catch (_) {}
}

function loadDraftFromStorage() {
  try {
    const raw = localStorage.getItem(draftKey());
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch (_) {}
}

function checkAndShowDraftBanner() {
  const banner = document.getElementById('promoDraftBanner');
  if (!banner) return;
  const draft = loadDraftFromStorage();
  if (draft?.students?.length) {
    document.getElementById('promoDraftDate').textContent =
      new Date(draft.savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const sel = document.getElementById('promotionCampus');
    const opt = sel?.options[sel.selectedIndex];
    document.getElementById('promoDraftCampusLabel').textContent =
      opt?.value ? opt.text : 'All Campuses';
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function restoreDraft() {
  const draft = loadDraftFromStorage();
  if (!draft) return;
  _students  = draft.students;
  _actionMap = draft.actionMap;
  const yearSel = document.getElementById('promotionAcademicYear');
  if (yearSel && draft.year) yearSel.value = draft.year;
  const label = document.getElementById('promoYearLabel');
  if (label) label.textContent = (draft.year ?? '').replace('-', '–');
  document.getElementById('promoDraftBanner').hidden = true;
  renderPreview();
  document.getElementById('promotionInitial').hidden = true;
  document.getElementById('promotionPreview').hidden = false;
}

/* ─── Entry point ───────────────────────────────────────────── */
export async function initPromotionSection(profile) {
  _profile = profile;

  if (!profile.is_superadmin && !profile.can_manage_placement) {
    document.getElementById('promotionPreview').innerHTML =
      '<p class="muted" style="padding:1rem;">You do not have permission to manage grade promotion.</p>';
    return;
  }

  populateYearSelect();
  await populateCampusSelect();

  if (!_initialized) {
    _initialized = true;
    wireEvents();
  }

  checkAndShowDraftBanner();
  await loadPromotionLog();
}

/* ─── Year select ───────────────────────────────────────────── */
function populateYearSelect() {
  const sel = document.getElementById('promotionAcademicYear');
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

/* ─── Campus select ─────────────────────────────────────────── */
async function populateCampusSelect() {
  const sel = document.getElementById('promotionCampus');
  if (!sel) return;
  const { data } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', _profile.school_id)
    .order('name');
  sel.innerHTML = '<option value="">All Campuses</option>';
  (data ?? []).forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
}

/* ─── Event wiring ──────────────────────────────────────────── */
function wireEvents() {
  document.getElementById('loadPromotionPreviewBtn')
    ?.addEventListener('click', loadPromotionPreview);

  document.getElementById('runPromotionBtn')
    ?.addEventListener('click', confirmAndRun);

  document.getElementById('promotionCampus')
    ?.addEventListener('change', () => {
      // If preview is showing, hide it — campus change invalidates the current load
      if (!document.getElementById('promotionPreview')?.hidden) {
        document.getElementById('promotionPreview').hidden = true;
        document.getElementById('promotionInitial').hidden = false;
        _students = [];
        _actionMap = {};
      }
      checkAndShowDraftBanner();
    });

  document.getElementById('promoDraftRestore')
    ?.addEventListener('click', restoreDraft);

  document.getElementById('promoDraftDiscard')
    ?.addEventListener('click', () => {
      clearDraft();
      document.getElementById('promoDraftBanner').hidden = true;
    });
}

/* ─── Load preview ──────────────────────────────────────────── */
async function loadPromotionPreview() {
  const btn = document.getElementById('loadPromotionPreviewBtn');
  btn.disabled = true;
  btn.textContent = 'Loading…';

  let query = supabase
    .from('students')
    .select('id, first_name, last_name, grade_level, student_number')
    .eq('school_id', _profile.school_id)
    .eq('active', true)
    .order('last_name');

  const campusId = document.getElementById('promotionCampus')?.value;
  if (campusId) query = query.eq('campus_id', campusId);

  const { data, error } = await query;

  btn.disabled = false;
  btn.textContent = 'Load Preview';

  if (error) {
    console.error('Promotion preview load error:', error);
    return;
  }

  _students = data ?? [];
  _actionMap = {};

  _students.forEach(s => {
    if (!s.grade_level) return; // null-grade students get no default action — they'll be skipped
    _actionMap[s.id] = isTerminalGrade(s.grade_level) ? 'graduate' : 'promote';
  });

  // Update run button year label
  const year = document.getElementById('promotionAcademicYear')?.value ?? '';
  const label = document.getElementById('promoYearLabel');
  if (label) label.textContent = year.replace('-', '–');

  saveDraft();

  renderPreview();
  document.getElementById('promotionInitial').hidden = true;
  document.getElementById('promotionPreview').hidden = false;
}

/* ─── Render preview ────────────────────────────────────────── */
function renderPreview() {
  updateSummaryChips();

  // Null-grade warning
  const nullStudents = _students.filter(s => !s.grade_level);
  const nullWarn  = document.getElementById('promotionNullWarning');
  const nullCount = document.getElementById('promotionNullCount');
  if (nullWarn)  nullWarn.hidden  = nullStudents.length === 0;
  if (nullCount) nullCount.textContent = nullStudents.length;

  const container = document.getElementById('promotionGradeGroups');
  container.innerHTML = '';

  // Group students by grade
  const groups = {};
  _students.forEach(s => {
    const g = s.grade_level ?? 'Unknown';
    if (!groups[g]) groups[g] = [];
    groups[g].push(s);
  });

  // Sort grades by defined order, unknowns last
  const sortedGrades = Object.keys(groups).sort((a, b) => {
    const ai = GRADE_ORDER.indexOf(a);
    const bi = GRADE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  sortedGrades.forEach(grade => {
    container.appendChild(buildGradeGroup(grade, groups[grade]));
  });
}

function buildGradeGroup(grade, students) {
  const isUnknown = grade === 'Unknown';
  const terminal  = !isUnknown && isTerminalGrade(grade);
  const next      = isUnknown ? null : nextGrade(grade);

  const wrap = document.createElement('div');
  wrap.className = 'promo-grade-group';

  const header = document.createElement('div');
  header.className = 'promo-grade-header';
  header.innerHTML = `
    <span class="grade-badge${isUnknown ? ' grade-badge-warn' : ''}">${isUnknown ? '?' : grade}</span>
    <span class="promo-grade-name">${gradeLabel(grade === 'Unknown' ? null : grade)}</span>
    ${isUnknown ? '<span class="promo-skip-badge">Will be skipped</span>' : ''}
    <span class="promo-grade-count muted">${students.length} student${students.length !== 1 ? 's' : ''}</span>
    ${!isUnknown ? `
    <div class="promo-bulk-actions">
      ${terminal
        ? `<button class="promo-bulk-btn" data-bulk-action="graduate">All Graduate</button>
           <button class="promo-bulk-btn" data-bulk-action="retain">All Retain</button>`
        : `<button class="promo-bulk-btn" data-bulk-action="promote">All Promote</button>
           <button class="promo-bulk-btn" data-bulk-action="retain">All Retain</button>`
      }
    </div>` : ''}
  `;

  const tbody = document.createElement('tbody');

  if (!isUnknown) {
    header.querySelectorAll('.promo-bulk-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.bulkAction;
        students.forEach(s => { _actionMap[s.id] = action; });
        tbody.querySelectorAll('tr').forEach(tr => {
          refreshRowSegment(tr, tr.dataset.studentId, terminal, next);
        });
        updateSummaryChips();
        saveDraft();
      });
    });
  }

  const table = document.createElement('table');
  table.className = 'promo-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th>
        <th>Student #</th>
        <th>${isUnknown ? 'Status' : 'Action'}</th>
      </tr>
    </thead>
  `;

  students.forEach(s => {
    const tr = buildStudentRow(s, terminal, next, isUnknown);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrap.appendChild(header);
  wrap.appendChild(table);
  return wrap;
}

function buildStudentRow(s, terminal, next, isUnknown) {
  const tr = document.createElement('tr');
  tr.dataset.studentId = s.id;
  if (isUnknown) tr.classList.add('promo-row-warn');

  const nameTd = document.createElement('td');
  nameTd.textContent = `${s.last_name}, ${s.first_name}`;

  const numTd = document.createElement('td');
  numTd.className = 'muted';
  numTd.textContent = s.student_number ?? '—';

  const actionTd = document.createElement('td');
  if (isUnknown) {
    actionTd.innerHTML = '<span class="promo-skip-label">No grade assigned — will be skipped</span>';
  } else {
    actionTd.appendChild(buildSegment(s.id, terminal, next));
  }

  tr.appendChild(nameTd);
  tr.appendChild(numTd);
  tr.appendChild(actionTd);
  return tr;
}

function buildSegment(studentId, terminal, next) {
  const wrap = document.createElement('div');
  wrap.className = 'promo-segmented';

  const options = terminal
    ? [
        { action: 'graduate', label: 'Graduate' },
        { action: 'retain',   label: 'Retain in 12th' },
      ]
    : [
        { action: 'promote', label: next ? `→ ${gradeLabel(next)}` : 'Promote' },
        { action: 'retain',  label: 'Retain' },
      ];

  options.forEach(({ action, label }) => {
    const btn = document.createElement('button');
    btn.className = 'promo-seg-btn';
    btn.textContent = label;
    btn.dataset.segAction = action;
    btn.classList.toggle('active', _actionMap[studentId] === action);

    btn.addEventListener('click', () => {
      _actionMap[studentId] = action;
      wrap.querySelectorAll('.promo-seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.segAction === action)
      );
      updateSummaryChips();
      saveDraft();
    });

    wrap.appendChild(btn);
  });

  return wrap;
}

function refreshRowSegment(tr, studentId, terminal, next) {
  const actionTd = tr.querySelector('td:last-child');
  if (!actionTd) return;
  actionTd.innerHTML = '';
  actionTd.appendChild(buildSegment(studentId, terminal, next));
}

/* ─── Summary chips ─────────────────────────────────────────── */
function updateSummaryChips() {
  let promoting = 0, retaining = 0, graduating = 0;
  Object.values(_actionMap).forEach(a => {
    if (a === 'promote') promoting++;
    else if (a === 'retain') retaining++;
    else if (a === 'graduate') graduating++;
  });
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('promCount',   promoting);
  set('retainCount', retaining);
  set('gradCount',   graduating);
  set('totalCount',  promoting + retaining + graduating);
}

/* ─── Confirm + run ─────────────────────────────────────────── */
async function confirmAndRun() {
  const year = document.getElementById('promotionAcademicYear')?.value;
  if (!year) return;

  let promoting = 0, retaining = 0, graduating = 0;
  Object.values(_actionMap).forEach(a => {
    if (a === 'promote') promoting++;
    else if (a === 'retain') retaining++;
    else if (a === 'graduate') graduating++;
  });

  const nullCount = _students.filter(s => !s.grade_level).length;

  const confirmed = confirm(
    `Run Year-End Promotion for ${year.replace('-', '–')}?\n\n` +
    `  • ${promoting} students promoted to next grade\n` +
    `  • ${retaining} students retained in current grade\n` +
    `  • ${graduating} students graduated (marked inactive)\n` +
    (nullCount ? `  • ${nullCount} student(s) SKIPPED — no grade level assigned\n` : '') +
    `\nThis will update all student records immediately.`
  );
  if (!confirmed) return;

  await runPromotion(year);
}

async function runPromotion(year) {
  const btn = document.getElementById('runPromotionBtn');
  btn.disabled = true;
  btn.textContent = 'Running…';

  const graduationYear = parseInt(year.split('-')[1]);
  const errors = [];

  // Snapshot for audit log (include null-grade students with action 'skipped')
  const snapshot = _students.map(s => ({
    id: s.id,
    grade_level: s.grade_level,
    action: s.grade_level ? (_actionMap[s.id] ?? 'skipped') : 'skipped',
  }));

  // Explicitly exclude null-grade students from all action lists
  const toPromote  = _students.filter(s => s.grade_level && _actionMap[s.id] === 'promote');
  const toRetain   = _students.filter(s => s.grade_level && _actionMap[s.id] === 'retain');
  const toGraduate = _students.filter(s => s.grade_level && _actionMap[s.id] === 'graduate');

  // Promote — batch by next grade value
  const promoteByNextGrade = {};
  toPromote.forEach(s => {
    const ng = nextGrade(s.grade_level);
    if (!ng) return;
    if (!promoteByNextGrade[ng]) promoteByNextGrade[ng] = [];
    promoteByNextGrade[ng].push(s.id);
  });

  for (const [ng, ids] of Object.entries(promoteByNextGrade)) {
    const { error } = await supabase
      .from('students')
      .update({ grade_level: ng, retained: false })
      .in('id', ids);
    if (error) errors.push(error);
  }

  // Retain
  if (toRetain.length) {
    const { error } = await supabase
      .from('students')
      .update({ retained: true })
      .in('id', toRetain.map(s => s.id));
    if (error) errors.push(error);
  }

  // Graduate
  if (toGraduate.length) {
    const { error } = await supabase
      .from('students')
      .update({ active: false, graduation_year: graduationYear, retained: false })
      .in('id', toGraduate.map(s => s.id));
    if (error) errors.push(error);
  }

  if (errors.length) {
    console.error('Promotion errors:', errors);
    alert('Some updates failed. Check the console for details.');
    btn.disabled = false;
    btn.textContent = 'Run Promotion';
    return;
  }

  // Write audit log
  await supabase.from('student_promotion_log').insert({
    school_id:       _profile.school_id,
    academic_year:   year,
    run_by:          _profile.user_id,
    promoted_count:  toPromote.length,
    retained_count:  toRetain.length,
    graduated_count: toGraduate.length,
    snapshot,
  });

  clearDraft();

  // Reset to initial state
  _students = [];
  _actionMap = {};
  document.getElementById('promotionPreview').hidden = true;
  document.getElementById('promotionInitial').hidden = false;

  btn.disabled = false;
  btn.textContent = 'Run Promotion';

  await loadPromotionLog();
  alert(`Done! ${toPromote.length} promoted · ${toRetain.length} retained · ${toGraduate.length} graduated.`);
}

/* ─── Past runs log ─────────────────────────────────────────── */
async function loadPromotionLog() {
  const container = document.getElementById('promotionLogEntries');
  if (!container) return;

  const { data, error } = await supabase
    .from('student_promotion_log')
    .select('id, academic_year, run_at, promoted_count, retained_count, graduated_count')
    .eq('school_id', _profile.school_id)
    .order('run_at', { ascending: false })
    .limit(10);

  if (error || !data || data.length === 0) {
    container.innerHTML = '<p class="muted" style="font-size:13px; padding:4px 0;">No promotion runs yet.</p>';
    return;
  }

  container.innerHTML = data.map(log => `
    <div class="promo-log-entry">
      <div class="promo-log-year">${log.academic_year.replace('-', '–')}</div>
      <div class="promo-log-stats">
        <span class="promo-log-stat ok">${log.promoted_count} promoted</span>
        <span class="promo-log-stat warn">${log.retained_count} retained</span>
        <span class="promo-log-stat muted">${log.graduated_count} graduated</span>
      </div>
      <div class="promo-log-date muted">${new Date(log.run_at).toLocaleDateString()}</div>
    </div>
  `).join('');
}

// Student picker modal for custom field trip rosters.
//
// Selection lives in a Set of student ids, independent of the search and
// grade filters, so narrowing the list never loses earlier picks. The caller
// decides what "apply" means (stage in the trip drawer vs. save right away).

import { esc, GRADE_ORDER } from './admin.shared.js?v=4';
import { fetchAllRows } from './field-trip-roster.js?v=1';

const PICKER_SELECT = 'id, first_name, last_name, grade_level, employees!left(first_name, last_name)';
const CHIP_PREVIEW_LIMIT = 40;

let allStudents = null;   // cached for the page session
let selected = new Set();
let gradeFilter = new Set();
let onApply = null;
let gradeOrder = [];

const el = id => document.getElementById(id);
const fullName = s => `${s.last_name ?? ''}, ${s.first_name ?? ''}`;

async function ensureStudents(supabase, schoolId) {
  if (allStudents) return null;
  const { data, error } = await fetchAllRows(() => supabase.from('students').select(PICKER_SELECT)
    .eq('school_id', schoolId).eq('active', true)
    .order('last_name', { ascending: true }).order('id', { ascending: true }));
  if (error) return error;
  allStudents = data.map(s => ({
    ...s,
    homeroom: s.employees ? `${s.employees.first_name} ${s.employees.last_name}` : '',
    haystack: `${s.first_name} ${s.last_name} ${s.last_name} ${s.first_name} ${s.employees ? `${s.employees.first_name} ${s.employees.last_name}` : ''}`.toLowerCase(),
  }));
  return null;
}

function filtered() {
  const q = el('ftPickerSearch').value.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const onlySel = el('ftPickerSelectedOnly').checked;
  return allStudents.filter(s => {
    if (gradeFilter.size && !gradeFilter.has(s.grade_level)) return false;
    if (onlySel && !selected.has(s.id)) return false;
    return terms.every(t => s.haystack.includes(t));
  });
}

function renderGradeChips() {
  const present = new Set(allStudents.map(s => s.grade_level).filter(Boolean));
  // Students can carry a grade the school config omits (e.g. PK), so rank by
  // the standard order first and fall back to the configured order.
  const rank = g => { const i = GRADE_ORDER.indexOf(g); return i >= 0 ? i : 100 + Math.max(0, gradeOrder.indexOf(g)); };
  const ordered = [...present].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  el('ftPickerGrades').innerHTML = ordered.map(g =>
    `<button type="button" class="ft-picker-chip${gradeFilter.has(g) ? ' on' : ''}" data-grade="${esc(g)}">${esc(g)}</button>`).join('');
}

function renderList() {
  const rows = filtered();
  const list = el('ftPickerList');
  if (!rows.length) {
    list.innerHTML = `<div class="muted" style="padding:32px 16px;text-align:center;font-size:13px;">No students match.</div>`;
  } else {
    list.innerHTML = rows.map(s => `
      <label class="ft-picker-row">
        <input type="checkbox" data-id="${esc(s.id)}" ${selected.has(s.id) ? 'checked' : ''}>
        <span class="ft-picker-name">${esc(fullName(s))}</span>
        <span class="ft-picker-meta">${esc(s.grade_level ?? '')}${s.homeroom ? ` · ${esc(s.homeroom)}` : ''}</span>
      </label>`).join('');
  }
  el('ftPickerShownCount').textContent = `${rows.length} shown`;
  renderSelectedSummary();
}

function renderSelectedSummary() {
  el('ftPickerSelectedCount').textContent = `${selected.size} selected`;
  const byId = new Map(allStudents.map(s => [s.id, s]));
  const picks = [...selected].map(id => byId.get(id)).filter(Boolean)
    .sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const shown = picks.slice(0, CHIP_PREVIEW_LIMIT);
  el('ftPickerChips').innerHTML = picks.length
    ? shown.map(s => `<span class="ft-picker-sel">${esc(s.first_name)} ${esc(s.last_name)}<button type="button" data-remove="${esc(s.id)}" aria-label="Remove ${esc(s.first_name)} ${esc(s.last_name)}">&times;</button></span>`).join('')
      + (picks.length > shown.length ? `<span class="muted" style="font-size:12px;align-self:center;">+${picks.length - shown.length} more (use "Selected only" to review)</span>` : '')
    : `<span class="muted" style="font-size:12px;">Nobody selected yet.</span>`;
}

function close() {
  el('ftPickerOverlay').classList.remove('open');
  onApply = null;
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  const rerender = () => renderList();
  el('ftPickerSearch').addEventListener('input', rerender);
  el('ftPickerSelectedOnly').addEventListener('change', rerender);
  el('ftPickerGrades').addEventListener('click', e => {
    const b = e.target.closest('[data-grade]');
    if (!b) return;
    gradeFilter.has(b.dataset.grade) ? gradeFilter.delete(b.dataset.grade) : gradeFilter.add(b.dataset.grade);
    renderGradeChips();
    renderList();
  });
  el('ftPickerList').addEventListener('change', e => {
    const cb = e.target.closest('input[data-id]');
    if (!cb) return;
    cb.checked ? selected.add(cb.dataset.id) : selected.delete(cb.dataset.id);
    // With "Selected only" on, an unchecked row should leave the view.
    if (el('ftPickerSelectedOnly').checked && !cb.checked) renderList(); else renderSelectedSummary();
  });
  el('ftPickerChips').addEventListener('click', e => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    selected.delete(b.dataset.remove);
    renderList();
  });
  el('ftPickerSelectShown').addEventListener('click', () => { filtered().forEach(s => selected.add(s.id)); renderList(); });
  el('ftPickerClearShown').addEventListener('click', () => { filtered().forEach(s => selected.delete(s.id)); renderList(); });
  el('ftPickerCancelBtn').addEventListener('click', close);
  el('ftPickerApplyBtn').addEventListener('click', () => {
    const cb = onApply;
    const ids = new Set(selected);
    close();
    cb?.(ids);
  });
  el('ftPickerOverlay').addEventListener('mousedown', e => { if (e.target === el('ftPickerOverlay')) close(); });
}

export async function openStudentPicker(supabase, { schoolId, gradeLevels = [], initialIds = [], apply }) {
  wire();
  gradeOrder = gradeLevels;
  selected = new Set(initialIds);
  gradeFilter = new Set();
  onApply = apply;
  el('ftPickerSearch').value = '';
  el('ftPickerSelectedOnly').checked = false;
  el('ftPickerList').innerHTML = `<div class="muted" style="padding:32px 16px;text-align:center;font-size:13px;">Loading students...</div>`;
  el('ftPickerOverlay').classList.add('open');

  const err = await ensureStudents(supabase, schoolId);
  if (err) {
    el('ftPickerList').innerHTML = `<div style="padding:32px 16px;text-align:center;font-size:13px;color:#b91c1c;">Failed to load students. Close and try again.</div>`;
    return;
  }
  const known = new Set(allStudents.map(s => s.id));
  selected = new Set([...selected].filter(id => known.has(id)));
  renderGradeChips();
  renderList();
  el('ftPickerSearch').focus();
}

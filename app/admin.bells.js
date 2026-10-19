// admin.bells.js
// Bell schedule editor: schedules, their day types and periods, and the
// weekly pattern. The bell page itself (app/bells.html) never reads these
// tables at ring time; it polls the bell_board edge function for a
// resolved timeline.
import { supabase } from './admin.supabase.js?v=2';
import { esc, dbError, showToast, fmtTime } from './admin.shared.js?v=4';
import { TONES, DEFAULT_TONE, toneLabel, ringAt } from './bell-tones.js?v=2';

let profile = null;
let initialized = false;
let campuses = [];
let schedules = [];

let currentSchedule = null;
let dayTypes = [];
let periods = [];
let weekdays = {};          // dow -> day_type_id
let activeDayTypeId = null;

let editingScheduleId = null;
let editingDayTypeId = null;
let editingPeriodId = null;

// Displayed Monday-first; values are Postgres extract(dow) numbers.
const WEEK = [
  { dow: 1, label: 'Monday' },
  { dow: 2, label: 'Tuesday' },
  { dow: 3, label: 'Wednesday' },
  { dow: 4, label: 'Thursday' },
  { dow: 5, label: 'Friday' },
  { dow: 6, label: 'Saturday' },
  { dow: 0, label: 'Sunday' },
];

const KIND_LABELS = { class: 'Class', homeroom: 'Homeroom', lunch: 'Lunch', break: 'Break', other: 'Other' };

/* ===============================
   ENTRY POINT
================================ */
export async function initBellsSection(p) {
  profile = p;

  if (!profile.is_superadmin && profile.role !== 'admin' && !profile.can_manage_bells) {
    document.getElementById('bellsRoot').innerHTML =
      '<p class="muted" style="padding:40px;">You are not authorized to manage bell schedules.</p>';
    return;
  }

  if (!initialized) {
    wireEvents();
    initialized = true;
  }

  showListView();
  await loadCampuses();
  await loadSchedules();
}

/* ===============================
   SCHEDULE LIST
================================ */
async function loadCampuses() {
  const { data, error } = await supabase
    .from('campuses')
    .select('id, name')
    .eq('school_id', profile.school_id)
    .order('name');

  if (error) { console.error('bells loadCampuses', error); return; }
  campuses = data ?? [];
}

async function loadSchedules() {
  const { data, error } = await supabase
    .from('bell_schedules')
    .select('id, name, grade_label, campus_id, is_active, sort_order')
    .eq('school_id', profile.school_id)
    .order('sort_order')
    .order('name');

  if (error) { dbError(error, 'Failed to load bell schedules'); return; }
  schedules = data ?? [];
  renderScheduleTable();
}

function bellPageUrl(scheduleId) {
  return `/bells.html?schedule=${encodeURIComponent(scheduleId)}`;
}

function renderScheduleTable() {
  const tbody = document.querySelector('#bellSchedulesTable tbody');
  if (!tbody) return;

  if (!schedules.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="staff-cell-muted" style="padding:16px;">No bell schedules yet. Add one to get started: it comes with a Regular day type on Monday through Friday, ready for your periods.</td></tr>`;
    return;
  }

  const campusLookup = Object.fromEntries(campuses.map(c => [c.id, c.name]));

  tbody.innerHTML = schedules.map(s => `
    <tr>
      <td><strong>${esc(s.name)}</strong></td>
      <td class="staff-cell-muted">${esc(s.grade_label || '')}</td>
      <td class="staff-cell-muted">${esc(s.campus_id ? (campusLookup[s.campus_id] ?? 'Unknown') : 'All campuses')}</td>
      <td>${s.is_active ? '<span class="module-pill">Active</span>' : '<span class="staff-cell-muted">Inactive</span>'}</td>
      <td class="staff-cell-actions">
        <a class="btn btn-sm" href="${esc(bellPageUrl(s.id))}" target="_blank" rel="noopener">Open bell page</a>
        <button class="btn btn-sm btn-primary bell-manage-btn" data-id="${esc(s.id)}">Manage</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.bell-manage-btn').forEach(btn =>
    btn.addEventListener('click', () => openSchedule(btn.dataset.id)));
}

function showListView() {
  currentSchedule = null;
  document.getElementById('bellsListView').style.display = '';
  document.getElementById('bellsDetailView').style.display = 'none';
}

/* ===============================
   SCHEDULE DRAWER
================================ */
function populateCampusSelect(selectedId) {
  const sel = document.getElementById('bellScheduleCampusInput');
  sel.innerHTML = '<option value="">All campuses</option>' +
    campuses.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = selectedId || '';
}

function openAddScheduleDrawer() {
  editingScheduleId = null;
  document.getElementById('bellScheduleDrawerTitle').textContent = 'Add Schedule';
  document.getElementById('bellScheduleNameInput').value = '';
  document.getElementById('bellScheduleGradesInput').value = '';
  populateCampusSelect('');
  document.getElementById('bellScheduleActiveRow').style.display = 'none';
  document.getElementById('bellScheduleDeleteBtn').style.display = 'none';
  window.openDrawer?.('bellScheduleDrawer');
}

function openEditScheduleDrawer() {
  const s = currentSchedule;
  if (!s) return;
  editingScheduleId = s.id;
  document.getElementById('bellScheduleDrawerTitle').textContent = 'Edit Schedule';
  document.getElementById('bellScheduleNameInput').value = s.name;
  document.getElementById('bellScheduleGradesInput').value = s.grade_label || '';
  populateCampusSelect(s.campus_id);
  document.getElementById('bellScheduleActiveInput').checked = !!s.is_active;
  document.getElementById('bellScheduleActiveRow').style.display = '';
  document.getElementById('bellScheduleDeleteBtn').style.display = '';
  window.openDrawer?.('bellScheduleDrawer');
}

async function saveSchedule() {
  const name = document.getElementById('bellScheduleNameInput').value.trim();
  const grade_label = document.getElementById('bellScheduleGradesInput').value.trim() || null;
  const campus_id = document.getElementById('bellScheduleCampusInput').value || null;

  if (!name) { showToast('Give the schedule a name.', 'warn'); return; }

  const btn = document.getElementById('bellScheduleSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    if (editingScheduleId) {
      const is_active = document.getElementById('bellScheduleActiveInput').checked;
      const { error } = await supabase
        .from('bell_schedules')
        .update({ name, grade_label, campus_id, is_active, updated_at: new Date().toISOString() })
        .eq('id', editingScheduleId)
        .eq('school_id', profile.school_id);
      if (error) { dbError(error, 'Failed to save schedule'); return; }

      window.closeDrawer?.('bellScheduleDrawer');
      await loadSchedules();
      if (currentSchedule?.id === editingScheduleId) {
        currentSchedule = schedules.find(s => s.id === editingScheduleId) ?? currentSchedule;
        renderDetailHeader();
      }
      return;
    }

    const { data: created, error } = await supabase
      .from('bell_schedules')
      .insert({ school_id: profile.school_id, name, grade_label, campus_id, sort_order: schedules.length })
      .select('id')
      .single();
    if (error) { dbError(error, 'Failed to add schedule'); return; }

    // Seed a Regular day type on Monday through Friday so the first
    // thing left to do is enter periods.
    const { data: dt, error: dtErr } = await supabase
      .from('bell_day_types')
      .insert({ schedule_id: created.id, name: 'Regular', sort_order: 0 })
      .select('id')
      .single();
    if (dtErr) {
      dbError(dtErr, 'Schedule added, but the Regular day type could not be created');
    } else {
      const { error: wdErr } = await supabase
        .from('bell_schedule_weekdays')
        .insert([1, 2, 3, 4, 5].map(dow => ({ schedule_id: created.id, dow, day_type_id: dt.id })));
      if (wdErr) dbError(wdErr, 'Schedule added, but the weekly pattern could not be set');
    }

    window.closeDrawer?.('bellScheduleDrawer');
    await loadSchedules();
    await openSchedule(created.id);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function deleteSchedule() {
  if (!editingScheduleId) return;
  if (!confirm('Delete this bell schedule, including all of its day types and periods? Bell pages using it will stop ringing.')) return;

  const { error } = await supabase
    .from('bell_schedules')
    .delete()
    .eq('id', editingScheduleId)
    .eq('school_id', profile.school_id);
  if (error) { dbError(error, 'Failed to delete schedule'); return; }

  window.closeDrawer?.('bellScheduleDrawer');
  editingScheduleId = null;
  showListView();
  await loadSchedules();
}

/* ===============================
   SCHEDULE DETAIL
================================ */
async function openSchedule(id) {
  const s = schedules.find(x => x.id === id);
  if (!s) return;
  currentSchedule = s;
  activeDayTypeId = null;

  document.getElementById('bellsListView').style.display = 'none';
  document.getElementById('bellsDetailView').style.display = '';
  renderDetailHeader();
  await loadDetail();
}

function renderDetailHeader() {
  const s = currentSchedule;
  document.getElementById('bellDetailTitle').textContent =
    s.grade_label ? `${s.name} (${s.grade_label})` : s.name;
  document.getElementById('bellOpenPageLink').href = bellPageUrl(s.id);
}

async function loadDetail() {
  const scheduleId = currentSchedule.id;

  const [dtRes, wdRes] = await Promise.all([
    supabase.from('bell_day_types').select('id, name, sort_order')
      .eq('schedule_id', scheduleId).order('sort_order').order('name'),
    supabase.from('bell_schedule_weekdays').select('dow, day_type_id')
      .eq('schedule_id', scheduleId),
  ]);

  if (dtRes.error) { dbError(dtRes.error, 'Failed to load day types'); return; }
  if (wdRes.error) { dbError(wdRes.error, 'Failed to load the weekly pattern'); return; }
  if (currentSchedule?.id !== scheduleId) return;

  dayTypes = dtRes.data ?? [];
  weekdays = Object.fromEntries((wdRes.data ?? []).map(r => [r.dow, r.day_type_id]));

  const ids = dayTypes.map(d => d.id);
  if (ids.length) {
    const { data, error } = await supabase
      .from('bell_periods')
      .select('id, day_type_id, name, kind, start_time, end_time, ring_start, ring_end, tone')
      .in('day_type_id', ids)
      .order('start_time');
    if (error) { dbError(error, 'Failed to load periods'); return; }
    if (currentSchedule?.id !== scheduleId) return;
    periods = data ?? [];
  } else {
    periods = [];
  }

  if (!dayTypes.some(d => d.id === activeDayTypeId)) activeDayTypeId = dayTypes[0]?.id ?? null;

  renderWeekGrid();
  renderDayTypeTabs();
  renderPeriods();
}

/* ===============================
   WEEKLY PATTERN
================================ */
function renderWeekGrid() {
  const grid = document.getElementById('bellWeekGrid');
  const options = '<option value="">No bells</option>' +
    dayTypes.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');

  grid.innerHTML = WEEK.map(w => `
    <label class="bell-week-day">
      <span>${w.label}</span>
      <select class="form-input bell-week-select" data-dow="${w.dow}">${options}</select>
    </label>
  `).join('');

  grid.querySelectorAll('.bell-week-select').forEach(sel => {
    sel.value = weekdays[sel.dataset.dow] ?? '';
    sel.addEventListener('change', () => saveWeekday(sel));
  });
}

async function saveWeekday(sel) {
  const dow = Number(sel.dataset.dow);
  const dayTypeId = sel.value || null;
  const scheduleId = currentSchedule.id;
  const previous = weekdays[dow] ?? '';

  sel.disabled = true;
  const { error } = dayTypeId
    ? await supabase.from('bell_schedule_weekdays')
        .upsert({ schedule_id: scheduleId, dow, day_type_id: dayTypeId }, { onConflict: 'schedule_id,dow' })
    : await supabase.from('bell_schedule_weekdays')
        .delete().eq('schedule_id', scheduleId).eq('dow', dow);
  sel.disabled = false;

  if (error) {
    sel.value = previous;
    dbError(error, 'Failed to save the weekly pattern');
    return;
  }

  if (dayTypeId) weekdays[dow] = dayTypeId; else delete weekdays[dow];
  renderDayTypeTabs();
  renderPeriods();
}

/* ===============================
   DAY TYPES
================================ */
function daysUsing(dayTypeId) {
  return WEEK.filter(w => weekdays[w.dow] === dayTypeId).map(w => w.label.slice(0, 3));
}

function renderDayTypeTabs() {
  const wrap = document.getElementById('bellDayTypeTabs');

  if (!dayTypes.length) {
    wrap.innerHTML = '<p class="staff-cell-muted" style="margin:0;">No day types yet. Add one to start entering periods.</p>';
    return;
  }

  wrap.innerHTML = dayTypes.map(d => `
    <button type="button" class="bell-daytype-tab${d.id === activeDayTypeId ? ' active' : ''}" data-id="${esc(d.id)}">
      ${esc(d.name)}
      <span class="bell-daytype-count">${periods.filter(p => p.day_type_id === d.id).length}</span>
    </button>
  `).join('');

  wrap.querySelectorAll('.bell-daytype-tab').forEach(btn =>
    btn.addEventListener('click', () => {
      activeDayTypeId = btn.dataset.id;
      renderDayTypeTabs();
      renderPeriods();
    }));
}

function openAddDayTypeDrawer() {
  editingDayTypeId = null;
  document.getElementById('bellDayTypeDrawerTitle').textContent = 'Add Day Type';
  document.getElementById('bellDayTypeNameInput').value = '';
  const copySel = document.getElementById('bellDayTypeCopyInput');
  copySel.innerHTML = '<option value="">Blank (no periods)</option>' +
    dayTypes.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  copySel.value = activeDayTypeId || '';
  document.getElementById('bellDayTypeCopyRow').style.display = dayTypes.length ? '' : 'none';
  document.getElementById('bellDayTypeDeleteBtn').style.display = 'none';
  window.openDrawer?.('bellDayTypeDrawer');
}

function openRenameDayTypeDrawer() {
  const d = dayTypes.find(x => x.id === activeDayTypeId);
  if (!d) return;
  editingDayTypeId = d.id;
  document.getElementById('bellDayTypeDrawerTitle').textContent = 'Edit Day Type';
  document.getElementById('bellDayTypeNameInput').value = d.name;
  document.getElementById('bellDayTypeCopyRow').style.display = 'none';
  document.getElementById('bellDayTypeDeleteBtn').style.display = '';
  window.openDrawer?.('bellDayTypeDrawer');
}

async function saveDayType() {
  const name = document.getElementById('bellDayTypeNameInput').value.trim();
  if (!name) { showToast('Give the day type a name.', 'warn'); return; }

  const btn = document.getElementById('bellDayTypeSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    if (editingDayTypeId) {
      const { error } = await supabase.from('bell_day_types').update({ name }).eq('id', editingDayTypeId);
      if (error) { dbError(error, 'Failed to rename day type'); return; }
    } else {
      const copyFrom = document.getElementById('bellDayTypeCopyInput').value;
      const { data: created, error } = await supabase
        .from('bell_day_types')
        .insert({ schedule_id: currentSchedule.id, name, sort_order: dayTypes.length })
        .select('id')
        .single();
      if (error) { dbError(error, 'Failed to add day type'); return; }

      const source = copyFrom ? periods.filter(p => p.day_type_id === copyFrom) : [];
      if (source.length) {
        const { error: copyErr } = await supabase.from('bell_periods').insert(source.map(p => ({
          day_type_id: created.id,
          name: p.name,
          kind: p.kind,
          start_time: p.start_time,
          end_time: p.end_time,
          ring_start: p.ring_start,
          ring_end: p.ring_end,
          tone: p.tone,
        })));
        if (copyErr) dbError(copyErr, 'Day type added, but its periods could not be copied');
      }
      activeDayTypeId = created.id;
    }

    window.closeDrawer?.('bellDayTypeDrawer');
    await loadDetail();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

async function deleteDayType() {
  if (!editingDayTypeId) return;
  const used = daysUsing(editingDayTypeId);
  const warning = used.length
    ? `This day type runs on ${used.join(', ')}. Deleting it leaves those days with no bells. Delete it and its periods?`
    : 'Delete this day type and its periods?';
  if (!confirm(warning)) return;

  const { error } = await supabase.from('bell_day_types').delete().eq('id', editingDayTypeId);
  if (error) { dbError(error, 'Failed to delete day type'); return; }

  window.closeDrawer?.('bellDayTypeDrawer');
  editingDayTypeId = null;
  activeDayTypeId = null;
  await loadDetail();
}

/* ===============================
   PERIODS
================================ */
// Postgres returns "HH:MM:SS"; time inputs give "HH:MM". Compare on HH:MM.
const hhmm = t => (t || '').slice(0, 5);

function renderPeriods() {
  const body = document.getElementById('bellDayTypeBody');
  const d = dayTypes.find(x => x.id === activeDayTypeId);
  if (!d) { body.style.display = 'none'; return; }
  body.style.display = '';

  const used = daysUsing(d.id);
  document.getElementById('bellDayTypeSummary').textContent = used.length
    ? `Runs on ${used.join(', ')}`
    : 'Not on the weekly pattern. It only runs when applied to a specific date.';

  const rows = periods.filter(p => p.day_type_id === d.id);
  const tbody = document.querySelector('#bellPeriodsTable tbody');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="staff-cell-muted" style="padding:16px;">No periods yet. Add the first one to start ringing bells on this day type.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map((p, i) => {
    const overlaps = i > 0 && hhmm(p.start_time) < hhmm(rows[i - 1].end_time);
    const bells = [p.ring_start && 'Start', p.ring_end && 'End'].filter(Boolean).join(' and ') || 'Silent';
    return `
      <tr>
        <td>${esc(p.name)}${overlaps ? ' <span class="bell-overlap-flag" title="Starts before the previous period ends">Overlaps</span>' : ''}</td>
        <td class="staff-cell-muted">${esc(KIND_LABELS[p.kind] ?? p.kind)}</td>
        <td class="staff-cell-muted">${esc(fmtTime(p.start_time))}</td>
        <td class="staff-cell-muted">${esc(fmtTime(p.end_time))}</td>
        <td class="staff-cell-muted">${esc(bells)}</td>
        <td class="staff-cell-muted">${p.ring_start || p.ring_end ? esc(toneLabel(p.tone)) : ''}</td>
        <td class="staff-cell-actions">
          <button class="btn btn-sm bell-period-edit-btn" data-id="${esc(p.id)}">Edit</button>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.bell-period-edit-btn').forEach(btn =>
    btn.addEventListener('click', () => openEditPeriodDrawer(btn.dataset.id)));
}

function populateToneSelect(selected) {
  const sel = document.getElementById('bellPeriodToneInput');
  sel.innerHTML = TONES.map(t =>
    `<option value="${esc(t.key)}">${esc(t.label)}${t.key === DEFAULT_TONE ? ' (default)' : ''}</option>`).join('');
  sel.value = TONES.some(t => t.key === selected) ? selected : DEFAULT_TONE;
}

// Plays the selected sound through this computer so an admin can hear it
// before saving. Runs from the button click, which is the user gesture
// browsers require before a page may make sound.
let previewCtx = null;
let previewNodes = [];
function previewTone() {
  try {
    previewCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = previewCtx;
    const tone = document.getElementById('bellPeriodToneInput').value;
    const play = () => {
      previewNodes.forEach(n => { try { n.stop(); } catch { /* already finished */ } });
      previewNodes = ringAt(ctx, ctx.currentTime + 0.05, tone);
    };
    if (ctx.state === 'running') play();
    else ctx.resume().then(play).catch(() => {});

    // A context that never starts fails silently (no error, no sound):
    // usually no working audio output, or the browser's audio is stuck.
    setTimeout(() => {
      if (ctx.state !== 'running') {
        showToast('This browser has not started audio. Check the sound output device, or restart the browser.', 'warn');
      }
    }, 1200);
  } catch (err) {
    console.error('bell preview', err);
    showToast('This browser could not play the preview.', 'warn');
  }
}

function openAddPeriodDrawer() {
  if (!activeDayTypeId) return;
  editingPeriodId = null;
  const rows = periods.filter(p => p.day_type_id === activeDayTypeId);
  const last = rows[rows.length - 1];

  document.getElementById('bellPeriodDrawerTitle').textContent = 'Add Period';
  document.getElementById('bellPeriodNameInput').value = '';
  document.getElementById('bellPeriodKindInput').value = 'class';
  // Most days run back to back, so start where the last period ended.
  document.getElementById('bellPeriodStartInput').value = last ? hhmm(last.end_time) : '';
  document.getElementById('bellPeriodEndInput').value = '';
  document.getElementById('bellPeriodRingStartInput').checked = true;
  document.getElementById('bellPeriodRingEndInput').checked = true;
  populateToneSelect(DEFAULT_TONE);
  document.getElementById('bellPeriodDeleteBtn').style.display = 'none';
  window.openDrawer?.('bellPeriodDrawer');
}

function openEditPeriodDrawer(id) {
  const p = periods.find(x => x.id === id);
  if (!p) return;
  editingPeriodId = id;
  document.getElementById('bellPeriodDrawerTitle').textContent = 'Edit Period';
  document.getElementById('bellPeriodNameInput').value = p.name;
  document.getElementById('bellPeriodKindInput').value = p.kind;
  document.getElementById('bellPeriodStartInput').value = hhmm(p.start_time);
  document.getElementById('bellPeriodEndInput').value = hhmm(p.end_time);
  document.getElementById('bellPeriodRingStartInput').checked = !!p.ring_start;
  document.getElementById('bellPeriodRingEndInput').checked = !!p.ring_end;
  populateToneSelect(p.tone);
  document.getElementById('bellPeriodDeleteBtn').style.display = '';
  window.openDrawer?.('bellPeriodDrawer');
}

async function savePeriod() {
  const row = {
    name: document.getElementById('bellPeriodNameInput').value.trim(),
    kind: document.getElementById('bellPeriodKindInput').value,
    start_time: document.getElementById('bellPeriodStartInput').value,
    end_time: document.getElementById('bellPeriodEndInput').value,
    ring_start: document.getElementById('bellPeriodRingStartInput').checked,
    ring_end: document.getElementById('bellPeriodRingEndInput').checked,
    tone: document.getElementById('bellPeriodToneInput').value || DEFAULT_TONE,
  };

  if (!row.name || !row.start_time || !row.end_time) {
    showToast('Name, start time, and end time are required.', 'warn');
    return;
  }
  if (row.end_time <= row.start_time) {
    showToast('End time must be after the start time.', 'warn');
    return;
  }

  const btn = document.getElementById('bellPeriodSaveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const { error } = editingPeriodId
    ? await supabase.from('bell_periods').update(row).eq('id', editingPeriodId)
    : await supabase.from('bell_periods').insert({ ...row, day_type_id: activeDayTypeId });

  btn.disabled = false;
  btn.textContent = 'Save';

  if (error) { dbError(error, 'Failed to save period'); return; }

  window.closeDrawer?.('bellPeriodDrawer');
  await loadDetail();
}

async function deletePeriod() {
  if (!editingPeriodId) return;
  if (!confirm('Delete this period?')) return;

  const { error } = await supabase.from('bell_periods').delete().eq('id', editingPeriodId);
  if (error) { dbError(error, 'Failed to delete period'); return; }

  window.closeDrawer?.('bellPeriodDrawer');
  editingPeriodId = null;
  await loadDetail();
}

/* ===============================
   EVENTS
================================ */
function wireEvents() {
  const on = (id, handler) => document.getElementById(id)?.addEventListener('click', handler);
  const closer = drawer => () => window.closeDrawer?.(drawer);

  on('bellAddScheduleBtn', openAddScheduleDrawer);
  on('bellBackBtn', async () => { showListView(); await loadSchedules(); });
  on('bellEditScheduleBtn', openEditScheduleDrawer);

  on('bellScheduleSaveBtn', saveSchedule);
  on('bellScheduleDeleteBtn', deleteSchedule);
  on('bellScheduleCancelBtn', closer('bellScheduleDrawer'));
  on('bellScheduleCloseBtn', closer('bellScheduleDrawer'));

  on('bellAddDayTypeBtn', openAddDayTypeDrawer);
  on('bellRenameDayTypeBtn', openRenameDayTypeDrawer);
  on('bellDayTypeSaveBtn', saveDayType);
  on('bellDayTypeDeleteBtn', deleteDayType);
  on('bellDayTypeCancelBtn', closer('bellDayTypeDrawer'));
  on('bellDayTypeCloseBtn', closer('bellDayTypeDrawer'));

  on('bellAddPeriodBtn', openAddPeriodDrawer);
  on('bellPeriodSaveBtn', savePeriod);
  on('bellPeriodTonePreviewBtn', previewTone);
  // Picking a sound plays it, so comparing them does not take two clicks each.
  document.getElementById('bellPeriodToneInput')?.addEventListener('change', previewTone);
  on('bellPeriodDeleteBtn', deletePeriod);
  on('bellPeriodCancelBtn', closer('bellPeriodDrawer'));
  on('bellPeriodCloseBtn', closer('bellPeriodDrawer'));
}

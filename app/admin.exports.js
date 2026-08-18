
// admin.exports.js
import { supabase } from './admin.supabase.js?v=2';
import { loadSchoolConfig, gradeLabel, GRADE_ORDER } from './admin.shared.js?v=3';
import { printRosters, saveRostersPdf, toRosterStudent, ROSTER_SELECT } from './roster-print.js?v=5';

let currentProfile;
let schoolConfig = null;
let initialized = false;

/* ===============================
   ENTRY POINT
================================ */
export async function initExportsSection(profile) {
  currentProfile = profile;

  if (!currentProfile.can_export_data) {
    alert('You are not authorized to export data.');
    return;
  }

  if (!schoolConfig) schoolConfig = await loadSchoolConfig(profile.school_id);

  if (!initialized) {
    wireExportEvents();
    await initRosterPrinting();
    initialized = true;
  }
}

/* ===============================
   EVENT WIRING
================================ */
function wireExportEvents() {
  document
    .getElementById('exportClassPlacement')
    ?.addEventListener('click', e =>
      runExport('class_placement', {}, e.currentTarget)
    );

  document
    .getElementById('exportTeacherRosters')
    ?.addEventListener('click', e =>
      runExport('teacher_rosters', {}, e.currentTarget)
    );

  document
    .getElementById('exportGradeRosters')
    ?.addEventListener('click', e =>
      runExport('grade_rosters', {}, e.currentTarget)
    );

  document
    .getElementById('exportBusAssignments')
    ?.addEventListener('click', e =>
      runExport('bus_assignments', {}, e.currentTarget)
    );

  document
    .getElementById('exportContactLists')
    ?.addEventListener('click', e => {
      const split =
        document.getElementById('contactSplitSelect')?.value;

      runExport(
        'contact_lists',
        { split: split || undefined },
        e.currentTarget
      );
    });
}


/* ===============================
   EXPORT HANDLER
================================ */

async function runExport(type, options = {}, buttonEl = null) {
  try {
    // ✅ UI feedback
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.dataset.originalText = buttonEl.textContent;
      buttonEl.textContent = 'Generating…';
      document.body.style.cursor = 'progress';
    }

    const { data, error } = await supabase.functions.invoke(
      'admin_export',
      {
        body: {
          type,
          ...options
        }
      }
    );

    if (error) {
      console.error(error);
      alert('Export failed.');
      return;
    }

    if (!data?.file_base64 || !data?.filename) {
      alert('Export returned no file.');
      return;
    }

    downloadBase64File(
      data.file_base64,
      data.filename,
      data.mime_type ||
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );

  } catch (err) {
    console.error('Export error', err);
    alert('Export error.');
  } finally {
    // ✅ Always restore UI
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = buttonEl.dataset.originalText;
    }
    document.body.style.cursor = '';
  }
}


/* ===============================
   ROSTER PRINTING
================================ */

let homeroomTeachers = [];   // { id, first_name, last_name }

function usesHomerooms() {
  return schoolConfig?.uses_homerooms !== false;
}

function gradeList() {
  return schoolConfig?.grade_levels?.length ? schoolConfig.grade_levels : GRADE_ORDER;
}

async function initRosterPrinting() {
  const groupBySel = document.getElementById('rosterGroupBy');
  const scopeSel   = document.getElementById('rosterScope');
  const printBtn   = document.getElementById('printRosters');
  if (!groupBySel || !scopeSel || !printBtn) return;

  if (usesHomerooms()) {
    const { data, error } = await supabase
      .from('employees')
      .select('id, first_name, last_name')
      .eq('school_id', currentProfile.school_id)
      .eq('active', true)
      .eq('is_teacher', true)
      .order('last_name');

    if (error) console.error('Failed to load homeroom teachers', error);
    homeroomTeachers = data ?? [];
  } else {
    // No homerooms at this school — grade is the only grouping that means anything.
    groupBySel.querySelector('option[value="teacher"]')?.remove();
    groupBySel.value = 'grade';
  }

  populateRosterScope();
  groupBySel.addEventListener('change', populateRosterScope);
  printBtn.addEventListener('click', e => runRosterOutput('print', e.currentTarget));
  document.getElementById('saveRostersPdf')
    ?.addEventListener('click', e => runRosterOutput('pdf', e.currentTarget));
}

function populateRosterScope() {
  const groupBy  = document.getElementById('rosterGroupBy')?.value ?? 'grade';
  const scopeSel = document.getElementById('rosterScope');
  if (!scopeSel) return;

  scopeSel.innerHTML = '';

  if (groupBy === 'teacher') {
    scopeSel.appendChild(new Option('All homerooms', ''));
    homeroomTeachers.forEach(t =>
      scopeSel.appendChild(new Option(`${t.last_name}, ${t.first_name}`, t.id))
    );
  } else {
    scopeSel.appendChild(new Option('All grades', ''));
    gradeList().forEach(g => scopeSel.appendChild(new Option(gradeLabel(g), g)));
  }
}

// mode: 'print' opens the print dialog, 'pdf' downloads a file. Both read the
// same controls and run the same query — only the final hand-off differs.
async function runRosterOutput(mode, buttonEl) {
  const groupBy    = document.getElementById('rosterGroupBy')?.value ?? 'grade';
  const scope      = document.getElementById('rosterScope')?.value ?? '';
  const activeOnly = document.getElementById('rosterActiveOnly')?.checked !== false;

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.dataset.originalText = buttonEl.textContent;
    buttonEl.textContent = 'Building…';
  }

  try {
    let query = supabase
      .from('students')
      .select(ROSTER_SELECT)
      .eq('school_id', currentProfile.school_id)
      .order('last_name', { ascending: true })
      .order('first_name', { ascending: true });

    if (activeOnly) query = query.eq('active', true);
    if (scope) {
      query = groupBy === 'teacher'
        ? query.eq('homeroom_teacher_id', scope)
        : query.eq('grade_level', scope);
    }

    const { data, error } = await query;
    if (error) {
      console.error('Roster load failed', error);
      alert('Could not load students for the roster.');
      return;
    }

    const groups = groupBy === 'teacher'
      ? groupByTeacher(data ?? [])
      : groupByGrade(data ?? []);

    const payload = {
      groups,
      schoolName: schoolConfig?.name ?? '',
      subtitle: activeOnly ? '' : 'Includes inactive students'
    };

    if (mode === 'pdf') await saveRostersPdf(payload);
    else printRosters(payload);
  } catch (err) {
    // Without this the click handler's promise rejects unhandled and the only
    // trace is a console error the user never sees.
    console.error('Roster output failed', err);
    alert('Could not build the roster. See the browser console for details.');
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = buttonEl.dataset.originalText;
    }
  }
}

function groupByTeacher(rows) {
  const teacherName = new Map(
    homeroomTeachers.map(t => [t.id, `${t.last_name}, ${t.first_name}`])
  );

  const byTeacher = new Map();
  rows.forEach(r => {
    // Students with no homeroom assigned can't appear on a homeroom roster.
    if (!r.homeroom_teacher_id) return;
    if (!byTeacher.has(r.homeroom_teacher_id)) byTeacher.set(r.homeroom_teacher_id, []);
    byTeacher.get(r.homeroom_teacher_id).push(toRosterStudent(r));
  });

  return [...byTeacher.entries()]
    .map(([id, students]) => ({
      label: teacherName.get(id) ?? 'Unassigned homeroom',
      sublabel: 'Homeroom',
      students
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function groupByGrade(rows) {
  const order = gradeList();

  const byGrade = new Map();
  rows.forEach(r => {
    const key = r.grade_level ?? '';
    if (!byGrade.has(key)) byGrade.set(key, []);
    byGrade.get(key).push(toRosterStudent(r));
  });

  return [...byGrade.entries()]
    .map(([grade, students]) => ({
      label: grade ? gradeLabel(grade) : 'No grade assigned',
      sublabel: '',
      students,
      rank: grade ? order.indexOf(grade) : Number.MAX_SAFE_INTEGER
    }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank, ...g }) => g);
}

/* ===============================
   FILE DOWNLOAD
================================ */
function downloadBase64File(base64, filename, mime) {
  const link = document.createElement('a');
  link.href = `data:${mime};base64,${base64}`;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

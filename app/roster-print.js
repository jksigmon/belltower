// roster-print.js
//
// Shared printable class-roster renderer. Two callers feed it the same
// shape so an admin-printed roster and a teacher-printed one come out
// identical on paper:
//   - admin.exports.js  → any teacher / any grade, school-wide
//   - staff.html        → the signed-in teacher's own homeroom
//
// Guardian contact data is opt-in per print: the default columns stay to
// roster facts (name, grade, carline tag, bus group), and a caller only gets
// guardian names/phones when it passes `columns` including 'guardians' (and
// supplies student.guardians). Rosters get left on desks and clipboards, so
// family PII never rides along by default.
import { esc, gradeLabel } from './admin.shared.js?v=4';

/**
 * Formats a student's display name as "Last, First" with a preferred
 * name appended when it differs from the legal first name.
 */
function studentName(s) {
  const base = `${s.last_name ?? ''}, ${s.first_name ?? ''}`.replace(/^, |, $/, '').trim();
  const preferred = (s.preferred_name ?? '').trim();
  if (preferred && preferred.toLowerCase() !== (s.first_name ?? '').trim().toLowerCase()) {
    return `${base} ("${preferred}")`;
  }
  return base || '—';
}

/** Shared meta line so the printed sheet and the PDF read identically. */
function metaLine(group, subtitle, generatedAt) {
  const n = group.students.length;
  return [
    group.sublabel || null,
    `${n} ${n === 1 ? 'student' : 'students'}`,
    subtitle || null,
    generatedAt
  ].filter(Boolean).join(' · ');
}

function generatedOn() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

/**
 * Every optional roster column, in print order. '#' and Student are always
 * present and aren't listed. Callers pass a subset of these keys as `columns`;
 * with none given, the legacy default applies (see resolveColumns).
 *
 *   text   - one-line value (PDF cell, Excel cell)
 *   lines  - optional multi-line value for the printed sheet / PDF
 */
function guardianLines(s) {
  return (s.guardians ?? []).map(g => `${g.name}: ${g.phone || 'no number'}`);
}

export const ROSTER_COLUMNS = [
  { key: 'grade',      label: 'Grade',            xlsxWidth: 10,
    text: s => s.grade_level ? gradeLabel(s.grade_level) : '' },
  { key: 'teacher',    label: 'Homeroom Teacher', xlsxWidth: 22,
    text: s => s.teacher ?? '' },
  { key: 'carline_tag', label: 'Carline Tag',     xlsxWidth: 12,
    text: s => s.carline_tag ?? '' },
  { key: 'bus_group',  label: 'Bus Group',        xlsxWidth: 18,
    text: s => s.bus_group ?? '' },
  { key: 'guardians',  label: 'Guardian Contacts', xlsxWidth: 40,
    text: s => guardianLines(s).join('; '),
    lines: s => guardianLines(s) },
  { key: 'notes',      label: 'Notes',            xlsxWidth: 24, blank: true,
    text: () => '' },
  { key: 'check',      label: '',                 xlsxWidth: 6,  tick: true,
    text: () => '' }
];

/** Legacy column set, used when a caller doesn't choose columns. */
const DEFAULT_COLUMN_KEYS = ['grade', 'carline_tag', 'bus_group', 'check'];

/** Turns a `columns` key list (or the legacy showTeacher flag) into ordered column defs. */
function resolveColumns(columns, showTeacher) {
  const keys = Array.isArray(columns)
    ? columns
    : [...DEFAULT_COLUMN_KEYS.slice(0, 1), ...(showTeacher ? ['teacher'] : []), ...DEFAULT_COLUMN_KEYS.slice(1)];
  const wanted = new Set(keys);
  return ROSTER_COLUMNS.filter(c => wanted.has(c.key));
}

function cellHtml(col, s) {
  if (col.tick) return '<td class="tick"><span class="box"></span></td>';
  if (col.blank) return '<td class="notes"></td>';
  if (col.lines) {
    const lines = col.lines(s);
    return `<td>${lines.length ? lines.map(l => `<span class="line">${esc(l)}</span>`).join('') : '—'}</td>`;
  }
  const v = col.text(s);
  return `<td>${v ? esc(v) : '—'}</td>`;
}

function rosterTable(students, cols) {
  if (!students.length) {
    return '<p class="empty">No students assigned.</p>';
  }

  return `<table>
  <thead>
    <tr>
      <th class="num">#</th>
      <th>Student</th>
      ${cols.map(c => `<th${c.tick ? ' class="tick"' : ''}>${esc(c.label)}</th>`).join('')}
    </tr>
  </thead>
  <tbody>
    ${students.map((s, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="name">${esc(studentName(s))}</td>
      ${cols.map(c => cellHtml(c, s)).join('')}
    </tr>`).join('')}
  </tbody>
</table>`;
}

/**
 * Opens a print window containing one roster per group, page-broken.
 *
 * @param {object}   opts
 * @param {Array}    opts.groups     - [{ label, sublabel?, students: [] }]
 *                                     student: { first_name, last_name, preferred_name,
 *                                                grade_level, carline_tag, bus_group,
 *                                                teacher }
 * @param {string}   [opts.schoolName]
 * @param {string}   [opts.subtitle]    - shown under each group heading
 * @param {boolean}  [opts.showTeacher] - adds a Homeroom Teacher column. Set it
 *                                        when grouping by grade; grouping by
 *                                        teacher already names them in the heading.
 *                                        Ignored when `columns` is given.
 * @param {string[]} [opts.columns]     - explicit column keys from ROSTER_COLUMNS
 *                                        (grade, teacher, carline_tag, bus_group,
 *                                        guardians, notes, check). Overrides the
 *                                        default set and showTeacher.
 * @returns {boolean} false if the pop-up was blocked
 */
export function printRosters({ groups = [], schoolName = '', subtitle = '', showTeacher = false, columns } = {}) {
  if (!groups.length) {
    alert('No students match that selection.');
    return false;
  }

  const generatedAt = generatedOn();
  const cols = resolveColumns(columns, showTeacher);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>Class Rosters</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; padding: 32px; }
  .roster { break-after: page; }
  .roster:last-child { break-after: auto; }
  .roster-head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 14px; }
  .school { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 4px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; }
  /* Repeat the header row when a large class spills onto a second sheet */
  thead { display: table-header-group; }
  th, td { text-align: left; padding: 7px 8px; font-size: 13px; border-bottom: 1px solid #e5e7eb; }
  th { color: #6b7280; font-weight: 600; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; }
  td.name { font-weight: 600; }
  .num  { width: 32px; color: #9ca3af; }
  .tick { width: 40px; text-align: center; }
  .tick .box { display: inline-block; width: 14px; height: 14px; border: 1.5px solid #9ca3af; border-radius: 3px; }
  .line { display: block; white-space: nowrap; }
  td.notes { min-width: 120px; }
  .empty { font-size: 13px; color: #6b7280; font-style: italic; }
  tr { break-inside: avoid; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
${groups.map(g => `<section class="roster">
  <div class="roster-head">
    ${schoolName ? `<div class="school">${esc(schoolName)}</div>` : ''}
    <h1>${esc(g.label)}</h1>
    <div class="meta">${esc(metaLine(g, subtitle, generatedAt))}</div>
  </div>
  ${rosterTable(g.students, cols)}
</section>`).join('')}
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Please allow pop-ups to print rosters.');
    return false;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  return true;
}

/**
 * Prints one student's day -- Homeroom, then each period -- from Student
 * Lookup. A distinct function rather than routing through printRosters():
 * that one prints CLASS rosters (a list of students, one row each); this
 * prints a single student's SCHEDULE (a list of periods, one row each).
 * Same row shape as the request in Student Lookup itself and no reason to
 * force one table renderer to serve two different kinds of document.
 *
 * @param {object} opts
 * @param {object} opts.student - { first_name, last_name, preferred_name, grade_level }
 * @param {Array}  opts.rows    - [{ period, class, teacher }]
 * @param {string} [opts.schoolName]
 * @returns {boolean} false if the pop-up was blocked or there's no student
 */
export function printStudentSchedule({ student, rows = [], schoolName = '' } = {}) {
  if (!student) return false;

  const generatedAt = generatedOn();
  const name = studentName(student);
  const grade = student.grade_level ? gradeLabel(student.grade_level) : '';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>${esc(name)} — Schedule</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111827; padding: 32px; }
  .sched-head { border-bottom: 2px solid #111827; padding-bottom: 8px; margin-bottom: 14px; }
  .school { font-size: 12px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 4px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 8px; font-size: 13px; border-bottom: 1px solid #e5e7eb; }
  th { color: #6b7280; font-weight: 600; text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.04em; }
  td.period { color: #6b7280; width: 160px; }
  td.class { font-weight: 600; }
  .empty { font-size: 13px; color: #6b7280; font-style: italic; }
  tr { break-inside: avoid; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <div class="sched-head">
    ${schoolName ? `<div class="school">${esc(schoolName)}</div>` : ''}
    <h1>${esc(name)}</h1>
    <div class="meta">${[grade, generatedAt].filter(Boolean).join(' · ')}</div>
  </div>
  ${rows.length ? `<table>
    <thead><tr><th>Period</th><th>Class</th><th>Teacher</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="period">${esc(r.period)}</td>
      <td class="class">${esc(r.class)}</td>
      <td>${esc(r.teacher)}</td>
    </tr>`).join('')}</tbody>
  </table>` : '<p class="empty">No schedule on file for this student.</p>'}
</body>
</html>`;

  const win = window.open('', '_blank');
  if (!win) {
    alert('Please allow pop-ups to print.');
    return false;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  return true;
}

/* ===============================
   PDF OUTPUT
================================ */

// jsPDF is fetched on first use — no bundler here, and rosters are rare
// enough that paying the download only when someone saves one is right.
//
// The ESM builds are the primary path. The UMD bundles decide what to do by
// sniffing globals (define/exports/module) and self-attach the autotable
// plugin inside a try/catch that swallows every failure, so when anything on
// the page perturbs that, the plugin loads but never attaches and the only
// symptom is "doc.autoTable is not a function" much later. ESM has no branch
// detection and no global side effects, so the attach is deterministic.
// Both hosts are already allowlisted in vercel.json's script-src-elem.
const JSPDF_ESM     = 'https://esm.sh/jspdf@2.5.2';
const AUTOTABLE_ESM = 'https://esm.sh/jspdf-autotable@3.8.4';
const JSPDF_SRC     = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
const AUTOTABLE_SRC = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js';

const scriptPromises = {};

function loadScript(src) {
  // Keyed by src so two rapid clicks share one in-flight load rather than
  // injecting a second tag while the first is still downloading.
  if (!scriptPromises[src]) {
    scriptPromises[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => {
        delete scriptPromises[src];   // let a later attempt retry
        reject(new Error(`Failed to load ${src}`));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromises[src];
}

/** Grabs autotable's applyPlugin from wherever the UMD build parked it. */
function umdAutoTablePlugin() {
  const candidate = window.applyPlugin ?? window.jspdf?.applyPlugin;
  return typeof candidate === 'function' ? candidate : null;
}

// Both loaders resolve to { JsPDF, autoTable }, where autoTable is called as
// autoTable(doc, options). The ESM build exposes autotable's standalone
// (doc, options) form as its default export, so that path never patches a
// prototype at all — which is what made the UMD path fragile.
async function loadViaEsm() {
  const [core, plugin] = await Promise.all([
    import(/* @vite-ignore */ JSPDF_ESM),
    import(/* @vite-ignore */ AUTOTABLE_ESM)
  ]);

  const JsPDF = core.jsPDF ?? core.default?.jsPDF ?? core.default;
  const runAutoTable = plugin.default;

  if (typeof JsPDF !== 'function') throw new Error('jsPDF ESM build exposed no constructor.');
  if (typeof runAutoTable !== 'function') throw new Error('jspdf-autotable ESM build exposed no table function.');

  return { JsPDF, autoTable: (doc, options) => runAutoTable(doc, options) };
}

// Fallback: the UMD bundles, with the plugin attached explicitly rather than
// trusting the bundle's swallowed self-attach.
async function loadViaUmd() {
  if (!window.jspdf?.jsPDF) await loadScript(JSPDF_SRC);

  const JsPDF = window.jspdf?.jsPDF;
  if (!JsPDF) throw new Error('jsPDF loaded but did not register itself.');

  if (!JsPDF.API.autoTable) await loadScript(AUTOTABLE_SRC);

  if (!JsPDF.API.autoTable) {
    const applyPlugin = umdAutoTablePlugin();
    if (!applyPlugin) throw new Error('jspdf-autotable loaded but could not attach to jsPDF.');
    applyPlugin(JsPDF);
  }

  return { JsPDF, autoTable: (doc, options) => doc.autoTable(options) };
}

let jsPdfPromise = null;

export function loadJsPdf() {
  // Cached so repeated clicks reuse one load instead of refetching.
  if (!jsPdfPromise) {
    jsPdfPromise = loadViaEsm().catch(async esmErr => {
      console.warn('jsPDF ESM load failed, falling back to UMD', esmErr);
      return loadViaUmd();
    }).catch(err => {
      jsPdfPromise = null;   // let the next click retry from scratch
      throw err;
    });
  }
  return jsPdfPromise;
}

function sanitizeFilename(str) {
  return String(str ?? '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'Roster';
}

/**
 * Saves the same roster layout as a PDF file. Takes the identical
 * arguments as printRosters, plus an optional filename.
 *
 * @returns {Promise<boolean>} false if nothing was saved
 */
export async function saveRostersPdf({
  groups = [], schoolName = '', subtitle = '', showTeacher = false, columns, filename
} = {}) {
  if (!groups.length) {
    alert('No students match that selection.');
    return false;
  }

  const cols = resolveColumns(columns, showTeacher);

  let JsPDF, autoTable;
  try {
    ({ JsPDF, autoTable } = await loadJsPdf());
  } catch (err) {
    console.error('PDF library failed to load', err);
    alert('Could not load the PDF tool. Check your connection and try again, or use Print and choose "Save as PDF".');
    return false;
  }

  const generatedAt = generatedOn();
  const doc = new JsPDF({ unit: 'pt', format: 'letter' });
  const margin = 40;
  const rightEdge = doc.internal.pageSize.getWidth() - margin;

  // Derived rather than hard-coded: the tick-box column index shifts with
  // whichever optional columns are on (-1 when the checkbox column is off).
  const head = ['#', 'Student', ...cols.map(c => c.label)];
  const tickCol = cols.findIndex(c => c.tick) === -1 ? -1 : cols.findIndex(c => c.tick) + 2;
  const notesCol = cols.findIndex(c => c.blank) === -1 ? -1 : cols.findIndex(c => c.blank) + 2;

  groups.forEach((g, i) => {
    if (i > 0) doc.addPage();

    let y = margin + 8;

    if (schoolName) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(107, 114, 128);
      doc.text(schoolName.toUpperCase(), margin, y);
      y += 15;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(17, 24, 39);
    doc.text(String(g.label ?? ''), margin, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(107, 114, 128);
    doc.text(metaLine(g, subtitle, generatedAt), margin, y);
    y += 8;

    doc.setDrawColor(17, 24, 39);
    doc.setLineWidth(1.2);
    doc.line(margin, y, rightEdge, y);
    y += 8;

    const body = g.students.length
      ? g.students.map((s, n) => [
          n + 1,
          studentName(s),
          ...cols.map(c => {
            if (c.tick || c.blank) return '';
            const lines = c.lines ? c.lines(s) : null;
            if (lines) return lines.length ? lines.join('\n') : '—';
            return c.text(s) || '—';
          })
        ])
      : [[{
          content: 'No students assigned.',
          colSpan: head.length,
          styles: { fontStyle: 'italic', textColor: [107, 114, 128] }
        }]];

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [head],
      body,
      theme: 'grid',
      styles: {
        fontSize: 9.5,
        cellPadding: 5,
        lineColor: [229, 231, 235],
        lineWidth: 0.5,
        textColor: [17, 24, 39]
      },
      headStyles: {
        fontSize: 7.5,
        fontStyle: 'bold',
        textColor: [107, 114, 128],
        fillColor: [249, 250, 251]
      },
      columnStyles: {
        0: { cellWidth: 26, textColor: [156, 163, 175] },
        1: { fontStyle: 'bold' },
        ...(tickCol > -1 ? { [tickCol]: { cellWidth: 34 } } : {}),
        ...(notesCol > -1 ? { [notesCol]: { minCellWidth: 80 } } : {})
      },
      // Draw the tick box centered in the last column, matching the
      // printed sheet's empty check-off square.
      didDrawCell: data => {
        if (tickCol < 0 || data.section !== 'body' || data.column.index !== tickCol) return;
        if (!g.students.length) return;
        const size = 9;
        const x = data.cell.x + (data.cell.width - size) / 2;
        const boxY = data.cell.y + (data.cell.height - size) / 2;
        doc.setDrawColor(156, 163, 175);
        doc.setLineWidth(0.8);
        doc.roundedRect(x, boxY, size, size, 1.5, 1.5);
      }
    });
  });

  const name = filename
    ?? (groups.length === 1
      ? `${sanitizeFilename(groups[0].label)}-Roster.pdf`
      : 'Class-Rosters.pdf');

  doc.save(name);
  return true;
}

/* ===============================
   EXCEL OUTPUT
================================ */

// Same lazy-load reasoning as jsPDF above: rosters are exported rarely, so the
// spreadsheet library is only fetched when someone actually asks for one. Same
// version the admin_export edge function uses, so the two paths can't drift.
const XLSX_ESM = 'https://esm.sh/xlsx@0.18.5';
const XLSX_SRC = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

let xlsxPromise = null;

function loadXlsx() {
  if (!xlsxPromise) {
    xlsxPromise = import(/* @vite-ignore */ XLSX_ESM)
      .then(mod => {
        const lib = mod.utils ? mod : mod.default;
        if (!lib?.utils) throw new Error('xlsx ESM build exposed no utils.');
        return lib;
      })
      .catch(async esmErr => {
        console.warn('xlsx ESM load failed, falling back to UMD', esmErr);
        await loadScript(XLSX_SRC);
        if (!window.XLSX?.utils) throw new Error('xlsx loaded but did not register itself.');
        return window.XLSX;
      })
      .catch(err => {
        xlsxPromise = null;   // let the next click retry from scratch
        throw err;
      });
  }
  return xlsxPromise;
}

/**
 * Excel sheet names are capped at 31 characters, may not contain : \ / ? * [ ],
 * may not be blank, and must be unique within the workbook. A teacher name like
 * "O'Brien-Nakashima, Christopher" or two grades that truncate to the same 31
 * characters would otherwise make book_append_sheet throw mid-export.
 */
function sheetName(label, used) {
  let base = String(label ?? '').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Roster';

  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` (${n++})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * Saves the same roster selection as an .xlsx workbook — one sheet per group.
 *
 * Names are split into separate last/first columns rather than the single
 * "Last, First" cell the printed sheet uses: a spreadsheet gets sorted and
 * filtered, and the other exports on this page split them the same way.
 *
 * Takes the same arguments as printRosters, plus an optional filename.
 *
 * @returns {Promise<boolean>} false if nothing was saved
 */
export async function saveRostersXlsx({
  groups = [], subtitle = '', showTeacher = false, columns, filename
} = {}) {
  if (!groups.length) {
    alert('No students match that selection.');
    return false;
  }

  const cols = resolveColumns(columns, showTeacher);

  let XLSX;
  try {
    XLSX = await loadXlsx();
  } catch (err) {
    console.error('Spreadsheet library failed to load', err);
    alert('Could not load the Excel tool. Check your connection and try again.');
    return false;
  }

  const wb = XLSX.utils.book_new();
  const used = new Set();

  // Header order and column widths kept as one list so an added column can't
  // land the widths on the wrong columns.
  const sheetCols = [
    { header: '#',                  width: 4,  get: (s, i) => i + 1 },
    { header: 'Student Last Name',  width: 18, get: s => s.last_name ?? '' },
    { header: 'Student First Name', width: 18, get: s => s.first_name ?? '' },
    { header: 'Preferred Name',     width: 16, get: s => s.preferred_name ?? '' },
    // The checkbox column means nothing in a spreadsheet; the rest follow the
    // same selection as the printed sheet.
    ...cols.filter(c => !c.tick).map(c => ({
      header: c.label, width: c.xlsxWidth, get: s => c.text(s)
    }))
  ];

  groups.forEach(g => {
    const rows = g.students.map((s, i) =>
      Object.fromEntries(sheetCols.map(c => [c.header, c.get(s, i)]))
    );

    // json_to_sheet on an empty array writes a sheet with no header row at all,
    // which reads as a corrupt-looking blank tab. Give it the headers explicitly.
    const ws = rows.length
      ? XLSX.utils.json_to_sheet(rows, { header: sheetCols.map(c => c.header) })
      : XLSX.utils.aoa_to_sheet([sheetCols.map(c => c.header)]);

    ws['!cols'] = sheetCols.map(c => ({ wch: c.width }));

    XLSX.utils.book_append_sheet(wb, ws, sheetName(g.label, used));
  });

  const name = filename
    ?? (groups.length === 1
      ? `${sanitizeFilename(groups[0].label)}-Roster.xlsx`
      : 'Class-Rosters.xlsx');

  // subtitle ("Includes inactive students") has no home in a grid; it's folded
  // into the filename so the file is still self-describing on disk.
  const finalName = subtitle
    ? name.replace(/\.xlsx$/, '-with-inactive.xlsx')
    : name;

  XLSX.writeFile(wb, finalName);
  return true;
}

/**
 * Maps a raw Supabase students row (with families/bus_groups joined) to
 * the flat shape printRosters expects. Shared so both callers select the
 * same columns and get the same output.
 */
export function toRosterStudent(row) {
  const t = row.employees;
  return {
    id:             row.id,
    family_id:      row.family_id ?? null,
    first_name:     row.first_name,
    last_name:      row.last_name,
    preferred_name: row.preferred_name,
    grade_level:    row.grade_level,
    carline_tag:    row.families?.carline_tag_number ?? null,
    bus_group:      row.bus_groups?.name ?? null,
    // Read off the FK rather than the legacy students.homeroom_teacher text
    // column, which isn't kept in sync with homeroom_teacher_id.
    teacher:        t ? `${t.last_name ?? ''}, ${t.first_name ?? ''}`.replace(/^, |, $/, '').trim() : null
  };
}

/** Column list both callers pass to .select() — keeps the two queries in sync. */
export const ROSTER_SELECT = `
  id,
  first_name,
  last_name,
  preferred_name,
  grade_level,
  homeroom_teacher_id,
  family_id,
  active,
  families(carline_tag_number),
  bus_groups(name),
  employees:homeroom_teacher_id(first_name, last_name)
`;

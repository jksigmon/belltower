// roster-print.js
//
// Shared printable class-roster renderer. Two callers feed it the same
// shape so an admin-printed roster and a teacher-printed one come out
// identical on paper:
//   - admin.exports.js  → any teacher / any grade, school-wide
//   - staff.html        → the signed-in teacher's own homeroom
//
// Deliberately carries no guardian contact data: rosters are printed and
// left on desks, clipboards, and buses, so they stay to roster facts
// (name, grade, carline tag, bus group) rather than family PII.
import { esc, gradeLabel } from './admin.shared.js?v=3';

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

function rosterTable(students) {
  if (!students.length) {
    return '<p class="empty">No students assigned.</p>';
  }

  return `<table>
  <thead>
    <tr>
      <th class="num">#</th>
      <th>Student</th>
      <th>Grade</th>
      <th>Carline Tag</th>
      <th>Bus Group</th>
      <th class="tick"></th>
    </tr>
  </thead>
  <tbody>
    ${students.map((s, i) => `<tr>
      <td class="num">${i + 1}</td>
      <td class="name">${esc(studentName(s))}</td>
      <td>${s.grade_level ? esc(gradeLabel(s.grade_level)) : '—'}</td>
      <td>${s.carline_tag ? esc(s.carline_tag) : '—'}</td>
      <td>${s.bus_group ? esc(s.bus_group) : '—'}</td>
      <td class="tick"><span class="box"></span></td>
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
 *                                                grade_level, carline_tag, bus_group }
 * @param {string}   [opts.schoolName]
 * @param {string}   [opts.subtitle] - shown under each group heading
 * @returns {boolean} false if the pop-up was blocked
 */
export function printRosters({ groups = [], schoolName = '', subtitle = '' } = {}) {
  if (!groups.length) {
    alert('No students match that selection.');
    return false;
  }

  const generatedAt = generatedOn();

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
  ${rosterTable(g.students)}
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

function loadJsPdf() {
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
export async function saveRostersPdf({ groups = [], schoolName = '', subtitle = '', filename } = {}) {
  if (!groups.length) {
    alert('No students match that selection.');
    return false;
  }

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
          s.grade_level ? gradeLabel(s.grade_level) : '—',
          s.carline_tag || '—',
          s.bus_group || '—',
          ''
        ])
      : [[{
          content: 'No students assigned.',
          colSpan: 6,
          styles: { fontStyle: 'italic', textColor: [107, 114, 128] }
        }]];

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['#', 'Student', 'Grade', 'Carline Tag', 'Bus Group', '']],
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
        5: { cellWidth: 34 }
      },
      // Draw the tick box centered in the last column, matching the
      // printed sheet's empty check-off square.
      didDrawCell: data => {
        if (data.section !== 'body' || data.column.index !== 5) return;
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

/**
 * Maps a raw Supabase students row (with families/bus_groups joined) to
 * the flat shape printRosters expects. Shared so both callers select the
 * same columns and get the same output.
 */
export function toRosterStudent(row) {
  return {
    first_name:     row.first_name,
    last_name:      row.last_name,
    preferred_name: row.preferred_name,
    grade_level:    row.grade_level,
    carline_tag:    row.families?.carline_tag_number ?? null,
    bus_group:      row.bus_groups?.name ?? null
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
  active,
  families(carline_tag_number),
  bus_groups(name)
`;

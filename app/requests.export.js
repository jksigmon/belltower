import { downloadCSV, fmtShortDate, toLocalISODate } from './admin.shared.js?v=3';

/**
 * CSV export for request submissions, shared by the admin panel's Requests
 * tab and the standalone Request Manager page.
 *
 * Answers are stored EAV (staff_request_responses, one row per field), so a
 * spreadsheet needs them pivoted into columns. Column order is discovered
 * from the data: fields are collected in sort_order within each submission,
 * in the order submissions appear, so a single-form export comes out in the
 * form's own field order.
 *
 * Exporting several forms at once unions their fields. Two forms that both
 * have a "Notes" field share one column — which is usually what you want in
 * a combined sheet, and the Form column disambiguates.
 *
 * Nothing here queries the database: it formats rows already fetched under
 * RLS, so an export can never contain a submission the user can't see.
 */

const META_HEADER = ['Form', 'Submitted By', 'Email', 'Submitted', 'Status', 'Manager Notes'];

// Mirrors statusLabel() in the calling modules: a form can rename its
// terminal states ("Approved", "Ordered", …), so fall back to the generic
// label only when the form hasn't set one.
function statusLabelFor(sub) {
  const cat = sub.request_categories ?? {};
  switch (sub.status) {
    case 'pending':   return 'Pending';
    case 'in_review': return 'In Review';
    case 'resolved':  return cat.resolved_label || 'Resolved';
    case 'denied':    return cat.denied_label   || 'Denied';
    case 'completed': return 'Completed';
    default:          return sub.status ?? '';
  }
}

function sortedResponses(sub) {
  return [...(sub.staff_request_responses ?? [])].sort(
    (a, b) => (a.request_category_fields?.sort_order ?? 0)
            - (b.request_category_fields?.sort_order ?? 0)
  );
}

/**
 * Pivot submissions into { header, rows } ready for downloadCSV.
 */
export function buildSubmissionsCSV(submissions) {
  // Discover field columns in a stable order.
  const fieldLabels = [];
  const seen = new Set();
  for (const sub of submissions) {
    for (const r of sortedResponses(sub)) {
      const label = r.request_category_fields?.label;
      if (!label || seen.has(label)) continue;
      seen.add(label);
      fieldLabels.push(label);
    }
  }

  const rows = submissions.map(sub => {
    const byLabel = new Map();
    for (const r of sortedResponses(sub)) {
      const label = r.request_category_fields?.label;
      if (!label) continue;
      // A duplicate label within one form would collide; keep the first
      // non-empty answer rather than letting a later blank overwrite it.
      if (byLabel.has(label) && !r.value) continue;
      byLabel.set(label, r.value ?? '');
    }

    return [
      sub.request_categories?.name ?? '',
      sub.profiles?.display_name ?? sub.profiles?.email ?? 'Unknown',
      sub.profiles?.email ?? '',
      fmtShortDate(sub.created_at),
      statusLabelFor(sub),
      sub.manager_notes ?? '',
      ...fieldLabels.map(label => byLabel.get(label) ?? ''),
    ];
  });

  return { header: [...META_HEADER, ...fieldLabels], rows };
}

function safeFilePart(s) {
  return String(s ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'requests';
}

/**
 * Export a list of submissions. `contextName` names the form filter in effect
 * (a form name, or "All Forms") and `statusName` the status filter; both go
 * into the filename, so a file exported under the default "Open" filter can't
 * be mistaken for a complete history. Returns false if there was nothing
 * to export.
 */
export function exportSubmissions(submissions, contextName = 'All Forms', statusName = '') {
  if (!submissions?.length) return false;
  const { header, rows } = buildSubmissionsCSV(submissions);
  // Local date, not toISOString() — an evening export shouldn't be stamped
  // with tomorrow's date.
  const stamp = toLocalISODate(new Date());
  const status = statusName ? `-${safeFilePart(statusName)}` : '';
  downloadCSV(`${safeFilePart(contextName)}${status}-submissions-${stamp}.csv`, header, rows);
  return true;
}

/**
 * Export a single submission. Same column layout as the bulk export, so the
 * row pastes cleanly into a sheet built from one.
 */
export function exportOneSubmission(sub) {
  if (!sub) return false;
  const who = sub.profiles?.display_name ?? sub.profiles?.email ?? 'submission';
  const { header, rows } = buildSubmissionsCSV([sub]);
  const when = sub.created_at ? toLocalISODate(new Date(sub.created_at)) : '';
  downloadCSV(
    `${safeFilePart(sub.request_categories?.name)}-${safeFilePart(who)}-${when}.csv`,
    header,
    rows
  );
  return true;
}

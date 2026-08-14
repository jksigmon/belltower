import { supabase } from './admin.supabase.js?v=2';
import { esc, dbError } from './admin.shared.js?v=3';
import { SUPABASE_URL } from './config.js';

let profile = null;

export async function initIcSyncSection(currentProfile) {
  profile = currentProfile;

  document.getElementById('icPreviewBtn').addEventListener('click', () => runSync(true));
  document.getElementById('icRunBtn').addEventListener('click', () => {
    if (confirm('Run the Infinite Campus sync now? This applies any previously-approved matches and enabled field updates, and adds anything new to the review queue for you to approve. It will not create or overwrite anything without prior approval.')) {
      runSync(false);
    }
  });
  document.getElementById('icExportBtn').addEventListener('click', exportDiffReport);

  document.getElementById('icReviewTabPending').addEventListener('click', () => switchReviewTab('pending'));
  document.getElementById('icReviewTabRejected').addEventListener('click', () => switchReviewTab('rejected'));

  await Promise.all([loadRuns(), loadReviewQueue(), loadDataGaps(), loadFieldDiffs(), loadFieldSettings()]);
}

function switchReviewTab(status) {
  reviewStatusFilter = status;
  document.getElementById('icReviewTabPending').className = status === 'pending' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
  document.getElementById('icReviewTabRejected').className = status === 'rejected' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-outline';
  loadReviewQueue();
}

const FIELD_SETTINGS_META = [
  ['sync_grade_level', 'Grade'],
  ['sync_date_of_birth', 'Date of Birth'],
  ['sync_student_number', 'Student #'],
  ['sync_email', 'Guardian Email'],
  ['sync_phone', 'Guardian Phone'],
];

async function loadFieldSettings() {
  const body = document.getElementById('icFieldSettingsBody');
  const { data: row, error } = await supabase
    .from('ic_sync_field_settings')
    .select('*')
    .eq('school_id', profile.school_id)
    .maybeSingle();

  if (error) {
    body.innerHTML = `<p class="muted" style="font-size:13px;">Failed to load settings: ${esc(error.message)}</p>`;
    return;
  }

  const settings = row ?? Object.fromEntries(FIELD_SETTINGS_META.map(([key]) => [key, false]));

  body.innerHTML = FIELD_SETTINGS_META.map(
    ([key, label]) => `
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
        <input type="checkbox" data-field-setting="${key}" ${settings[key] ? 'checked' : ''}>
        ${esc(label)}
      </label>
    `
  ).join('');

  body.querySelectorAll('[data-field-setting]').forEach((cb) =>
    cb.addEventListener('change', () => saveFieldSetting(cb.dataset.fieldSetting, cb.checked))
  );
}

async function saveFieldSetting(key, value) {
  const { error } = await supabase
    .from('ic_sync_field_settings')
    .upsert(
      { school_id: profile.school_id, [key]: value, updated_at: new Date().toISOString() },
      { onConflict: 'school_id' }
    );
  if (error) dbError(error, 'Failed to save field setting');
}

async function exportDiffReport() {
  const btn = document.getElementById('icExportBtn');
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Exporting…';

  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/sync_infinite_campus`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ export: true }),
    }
  );

  btn.disabled = false;
  btn.textContent = originalLabel;

  if (!res.ok) {
    alert('Export failed. Check the console for details.');
    console.error('IC export failed:', await res.text());
    return;
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ic-diff-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function runSync(dryRun) {
  const previewBtn = document.getElementById('icPreviewBtn');
  const runBtn = document.getElementById('icRunBtn');
  previewBtn.disabled = true;
  runBtn.disabled = true;
  const busyBtn = dryRun ? previewBtn : runBtn;
  const originalLabel = busyBtn.textContent;
  busyBtn.textContent = dryRun ? 'Previewing…' : 'Running…';

  const { data, error } = await supabase.functions.invoke('sync_infinite_campus', {
    body: { dry_run: dryRun },
  });

  previewBtn.disabled = false;
  runBtn.disabled = false;
  busyBtn.textContent = originalLabel;

  if (error) {
    dbError(error, dryRun ? 'Preview failed' : 'Sync failed');
    await loadRuns();
    return;
  }

  if (dryRun) renderPreview(data);
  else document.getElementById('icPreviewPanel').hidden = true;

  await Promise.all([loadRuns(), loadReviewQueue(), loadDataGaps(), loadFieldDiffs()]);
}

function renderPreview(data) {
  const panel = document.getElementById('icPreviewPanel');
  const body = document.getElementById('icPreviewBody');
  panel.hidden = false;

  const c = data.counts || {};
  const s = data.samples || {};

  body.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:14px;">
      ${statTile('Students to create', c.students_created)}
      ${statTile('Students to update', c.students_updated)}
      ${statTile('Students to deactivate', c.students_deactivated)}
      ${statTile('Guardians to create', c.guardians_created)}
      ${statTile('Guardians to update', c.guardians_updated)}
      ${statTile('Families to create', c.families_created)}
      ${statTile('Students needing review', c.students_awaiting_review)}
      ${statTile('Guardians needing review', c.guardians_awaiting_review)}
    </div>
    ${sampleList('New students', s.students_created)}
    ${sampleList('Students being deactivated', s.students_deactivated)}
    ${sampleList('New guardians', s.guardians_created)}
    <p class="muted" style="font-size:12px;margin-top:10px;">
      This is a preview only — nothing has changed yet. Click "Run Sync Now" to apply.
    </p>
  `;
}

function statTile(label, value) {
  return `
    <div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
      <div style="font-size:20px;font-weight:700;">${value ?? 0}</div>
      <div class="muted" style="font-size:12px;">${esc(label)}</div>
    </div>
  `;
}

function sampleList(label, items) {
  if (!items || !items.length) return '';
  return `
    <div style="margin-top:10px;">
      <div style="font-size:12px;font-weight:600;color:var(--text-secondary);">${esc(label)}</div>
      <div class="ic-sample-list">${items.map(esc).join('<br>')}</div>
    </div>
  `;
}

const REVIEW_PAGE_SIZE = 50;
const selectedCandidateIds = new Set();
let reviewStatusFilter = 'pending';

async function loadReviewQueue() {
  const wrap = document.getElementById('icReviewQueueWrap');
  const countEl = document.getElementById('icReviewCount');
  const rejectedCountEl = document.getElementById('icRejectedCount');
  selectedCandidateIds.clear();

  const { data: candidates, error, count } = await supabase
    .from('ic_reconciliation_candidates')
    .select('*', { count: 'exact' })
    .eq('school_id', profile.school_id)
    .eq('status', reviewStatusFilter)
    .order(reviewStatusFilter === 'rejected' ? 'reviewed_at' : 'created_at', { ascending: false })
    .limit(REVIEW_PAGE_SIZE);

  if (error) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">Failed to load review queue: ${esc(error.message)}</p>`;
    return;
  }

  if (reviewStatusFilter === 'pending') {
    countEl.textContent = count ? `(${count})` : '';
  } else {
    rejectedCountEl.textContent = count ? `(${count})` : '';
  }

  if (!candidates?.length) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">${reviewStatusFilter === 'rejected' ? "Nothing rejected — you're not sitting on anything you meant to come back to." : 'Nothing needs review right now.'}</p>`;
    return;
  }

  const mode = reviewStatusFilter;
  const bulkBar = mode === 'rejected'
    ? `
    <div style="display:flex;align-items:center;gap:10px;margin:10px 0;">
      <button class="btn btn-sm btn-primary" data-bulk-restore disabled>Restore Selected to Review</button>
      <span class="muted ic-selected-count" style="font-size:12px;"></span>
    </div>
  `
    : `
    <div style="display:flex;align-items:center;gap:10px;margin:10px 0;">
      <button class="btn btn-sm btn-primary" data-bulk-approve disabled>Approve Selected</button>
      <button class="btn btn-sm btn-outline" data-bulk-reject disabled>Reject Selected</button>
      <span class="muted ic-selected-count" style="font-size:12px;"></span>
    </div>
  `;

  wrap.innerHTML = `
    ${bulkBar}
    <table class="admin-table">
      <thead>
        <tr>
          <th style="width:32px;"><input type="checkbox" id="icSelectAllCheckbox"></th>
          <th>Type</th>
          <th colspan="2">Existing → Incoming from Infinite Campus (changed fields highlighted)</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${candidates.map((c) => candidateRowHtml(c, mode)).join('')}
      </tbody>
    </table>
    ${count > REVIEW_PAGE_SIZE ? `<p class="muted" style="font-size:12px;margin-top:8px;">Showing ${REVIEW_PAGE_SIZE} of ${count}.</p>` : ''}
    ${bulkBar}
  `;

  wrap.querySelectorAll('[data-approve]').forEach((btn) =>
    btn.addEventListener('click', () => reviewCandidates([btn.dataset.approve], 'approved'))
  );
  wrap.querySelectorAll('[data-reject]').forEach((btn) =>
    btn.addEventListener('click', () => reviewCandidates([btn.dataset.reject], 'rejected'))
  );
  wrap.querySelectorAll('[data-restore]').forEach((btn) =>
    btn.addEventListener('click', () => reviewCandidates([btn.dataset.restore], 'pending'))
  );
  wireFamilyOverrideControls(wrap);
  wrap.querySelectorAll('[data-field-override]').forEach((cb) =>
    cb.addEventListener('change', () => {
      const id = cb.dataset.fieldOverride;
      const key = cb.dataset.fieldKey;
      if (!fieldOverrideSelections.has(id)) fieldOverrideSelections.set(id, new Set());
      const set = fieldOverrideSelections.get(id);
      if (cb.checked) set.add(key);
      else set.delete(key);
    })
  );

  const rowCheckboxes = [...wrap.querySelectorAll('[data-select-id]')];
  const selectAll = document.getElementById('icSelectAllCheckbox');
  const bulkApproveBtns = [...wrap.querySelectorAll('[data-bulk-approve]')];
  const bulkRejectBtns = [...wrap.querySelectorAll('[data-bulk-reject]')];
  const bulkRestoreBtns = [...wrap.querySelectorAll('[data-bulk-restore]')];
  const selectedCountEls = [...wrap.querySelectorAll('.ic-selected-count')];

  const updateBulkButtons = () => {
    const n = selectedCandidateIds.size;
    bulkApproveBtns.forEach((btn) => (btn.disabled = n === 0));
    bulkRejectBtns.forEach((btn) => (btn.disabled = n === 0));
    bulkRestoreBtns.forEach((btn) => (btn.disabled = n === 0));
    selectedCountEls.forEach((el) => (el.textContent = n ? `${n} selected` : ''));
  };

  rowCheckboxes.forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCandidateIds.add(cb.dataset.selectId);
      else selectedCandidateIds.delete(cb.dataset.selectId);
      selectAll.checked = rowCheckboxes.every((c) => c.checked);
      updateBulkButtons();
    })
  );
  selectAll.addEventListener('change', () => {
    rowCheckboxes.forEach((cb) => {
      cb.checked = selectAll.checked;
      if (selectAll.checked) selectedCandidateIds.add(cb.dataset.selectId);
      else selectedCandidateIds.delete(cb.dataset.selectId);
    });
    updateBulkButtons();
  });

  bulkApproveBtns.forEach((btn) =>
    btn.addEventListener('click', () => reviewCandidates([...selectedCandidateIds], 'approved'))
  );
  bulkRejectBtns.forEach((btn) =>
    btn.addEventListener('click', () => reviewCandidates([...selectedCandidateIds], 'rejected'))
  );
  bulkRestoreBtns.forEach((btn) =>
    btn.addEventListener('click', () => reviewCandidates([...selectedCandidateIds], 'pending'))
  );
}

// Fields worth showing per entity type: [label, key]. Deliberately excludes internal
// bookkeeping (id, school_id, ic_sourced_id, family_id, last_synced_at) — only fields
// that actually change what's stored about the person.
// [label, getter, fieldKey] — fieldKey is null for fields that never auto-apply
// regardless of settings (Name, Active), so no override checkbox makes sense for them.
const STUDENT_COMPARE_FIELDS = [
  ['Name', (r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), null],
  ['Grade', (r) => r.grade_level ?? '—', 'grade_level'],
  ['Student #', (r) => r.student_number ?? '—', 'student_number'],
  ['DOB', (r) => r.birthdate ?? '—', 'birthdate'],
  ['Active', (r) => (r.active === undefined ? '—' : r.active ? 'Yes' : 'No'), null],
];
const GUARDIAN_COMPARE_FIELDS = [
  ['Name', (r) => `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(), null],
  ['Email', (r) => r.email ?? '—', 'email'],
  ['Phone', (r) => r.phone ?? '—', 'phone'],
];

// candidateId -> Set of field keys the reviewer has opted to pull in for that one
// record specifically, independent of the global Field Sync Settings.
const fieldOverrideSelections = new Map();

function compareFieldsHtml(candidateId, existing, proposed, fields) {
  const selected = fieldOverrideSelections.get(candidateId) ?? new Set();
  return `
    <table class="ic-compare-table">
      ${fields
        .map(([label, get, fieldKey]) => {
          const existingVal = get(existing);
          const proposedVal = get(proposed);
          const changed = existingVal !== proposedVal;
          const checkbox =
            changed && fieldKey
              ? `<input type="checkbox" data-field-override="${candidateId}" data-field-key="${fieldKey}" ${selected.has(fieldKey) ? 'checked' : ''} style="margin-right:4px;" title="Pull in Infinite Campus's value for this field on this record only">`
              : '';
          return `
            <tr>
              <td style="padding-right:4px;">${checkbox}</td>
              <td class="muted" style="padding-right:8px;white-space:nowrap;">${esc(label)}</td>
              <td style="${changed ? 'color:var(--primary);font-weight:600;' : ''}">${esc(String(existingVal))}</td>
              <td style="padding:0 6px;">→</td>
              <td style="${changed ? 'color:var(--primary);font-weight:600;' : ''}">${esc(String(proposedVal))}</td>
            </tr>
          `;
        })
        .join('')}
    </table>
    ${fields.some(([, get, key], i) => key && get(existing) !== get(proposed)) ? '<p class="muted" style="font-size:11px;margin:4px 0 0;">Check a highlighted field to pull in IC\'s value for this record only — leaves everyone else and the global setting untouched.</p>' : ''}
  `;
}

// candidateId -> family id chosen as an override for the auto-suggested match
const familyOverrideTarget = new Map();

// Rejected rows get a single "Restore to Review" action instead of Approve/Reject —
// there's nothing to approve directly from here, just a way back into the normal flow.
function actionCellHtml(c, mode, approveLabel, rejectLabel) {
  if (mode === 'rejected') {
    return `<button class="btn btn-sm btn-outline" data-restore="${c.id}">Restore to Review</button>`;
  }
  return `
    <button class="btn btn-sm btn-primary" data-approve="${c.id}">${approveLabel}</button>
    <button class="btn btn-sm btn-outline" data-reject="${c.id}">${rejectLabel}</button>
  `;
}

function familyRowHtml(c, mode) {
  const existing = c.existing_data || {};
  const proposed = c.proposed_data || {};
  const overrideId = familyOverrideTarget.get(c.id);

  const existingLine = overrideId
    ? `<span class="muted">(overridden — see below)</span>`
    : `${esc(existing.family_name ?? '(unnamed)')} — #${esc(existing.carline_tag_number ?? '—')} · ${existing.student_count ?? 0} student(s), ${existing.guardian_count ?? 0} guardian(s)`;
  const proposedLine = `New household "${esc(proposed.family_name ?? '')}" for: ${esc((proposed.students ?? []).join(', '))}`;

  return `
    <tr>
      <td><input type="checkbox" data-select-id="${c.id}"></td>
      <td>Family</td>
      <td colspan="2">
        <div style="font-size:13px;margin-bottom:6px;"><strong>Existing:</strong> ${existingLine}</div>
        <div style="font-size:13px;margin-bottom:8px;"><strong>Incoming:</strong> ${proposedLine}</div>
        <button class="btn btn-sm btn-outline" data-change-target="${c.id}">Change target family…</button>
        <div data-family-search-panel="${c.id}" hidden style="margin-top:8px;">
          <input type="search" data-family-search="${c.id}" class="form-input" placeholder="Search families by name…" style="width:260px;height:32px;font-size:13px;">
          <div data-family-search-results="${c.id}" style="margin-top:6px;font-size:13px;"></div>
        </div>
      </td>
      <td style="white-space:nowrap;">
        ${actionCellHtml(c, mode, 'Approve', 'Reject')}
      </td>
    </tr>
  `;
}

function newRecordRowHtml(c, mode) {
  const proposed = c.proposed_data || {};
  const isStudent = c.entity_type === 'student';
  const summary = isStudent
    ? `${proposed.first_name ?? ''} ${proposed.last_name ?? ''} — Grade ${proposed.grade_level ?? '—'}, Student # ${proposed.student_number ?? '—'}`
    : `${proposed.first_name ?? ''} ${proposed.last_name ?? ''} — ${proposed.email ?? 'no email'}, ${proposed.phone ?? 'no phone'}`;

  return `
    <tr>
      <td><input type="checkbox" data-select-id="${c.id}"></td>
      <td style="text-transform:capitalize;">${esc(c.entity_type)} <span class="muted" style="font-size:11px;">(new)</span></td>
      <td colspan="2" style="font-size:13px;">New in Infinite Campus, not yet in Belltower: ${esc(summary)}</td>
      <td style="white-space:nowrap;">
        ${actionCellHtml(c, mode, 'Accept', "Don't add")}
      </td>
    </tr>
  `;
}

function deactivateRowHtml(c, mode) {
  const existing = c.existing_data || {};
  const name = `${existing.first_name ?? ''} ${existing.last_name ?? ''}`.trim();

  return `
    <tr>
      <td><input type="checkbox" data-select-id="${c.id}"></td>
      <td>Student <span class="muted" style="font-size:11px;">(deactivate?)</span></td>
      <td colspan="2" style="font-size:13px;">
        <strong>${esc(name)}</strong> is no longer in Infinite Campus's roster. Approve to mark inactive in Belltower; reject to keep active (e.g. if this looks like a data glitch on IC's side).
      </td>
      <td style="white-space:nowrap;">
        ${actionCellHtml(c, mode, 'Deactivate', 'Keep active')}
      </td>
    </tr>
  `;
}

function candidateRowHtml(c, mode = 'pending') {
  if (c.entity_type === 'family') return familyRowHtml(c, mode);
  if (c.match_reason === 'new_record') return newRecordRowHtml(c, mode);
  if (c.match_reason === 'deactivate') return deactivateRowHtml(c, mode);

  const existing = c.existing_data || {};
  const proposed = c.proposed_data || {};
  const isStudent = c.entity_type === 'student';
  const fields = isStudent ? STUDENT_COMPARE_FIELDS : GUARDIAN_COMPARE_FIELDS;

  return `
    <tr>
      <td><input type="checkbox" data-select-id="${c.id}"></td>
      <td style="text-transform:capitalize;">${esc(c.entity_type)}</td>
      <td colspan="2">${compareFieldsHtml(c.id, existing, proposed, fields)}</td>
      <td style="white-space:nowrap;">
        ${actionCellHtml(c, mode, 'Approve', 'Reject')}
      </td>
    </tr>
  `;
}

function wireFamilyOverrideControls(wrap) {
  wrap.querySelectorAll('[data-change-target]').forEach((btn) => {
    const id = btn.dataset.changeTarget;
    btn.addEventListener('click', () => {
      const panel = wrap.querySelector(`[data-family-search-panel="${id}"]`);
      panel.hidden = !panel.hidden;
    });
  });

  wrap.querySelectorAll('[data-family-search]').forEach((input) => {
    const id = input.dataset.familySearch;
    const resultsEl = wrap.querySelector(`[data-family-search-results="${id}"]`);
    let debounceTimer;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const term = input.value.trim();
      if (!term) { resultsEl.innerHTML = ''; return; }
      debounceTimer = setTimeout(async () => {
        const { data: matches } = await supabase
          .from('families')
          .select('id, family_name, carline_tag_number')
          .eq('school_id', profile.school_id)
          .ilike('family_name', `%${term}%`)
          .limit(8);
        resultsEl.innerHTML = (matches ?? [])
          .map(
            (f) =>
              `<div data-pick-family="${f.id}" style="padding:4px 6px;cursor:pointer;border-radius:4px;" onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background=''">${esc(f.family_name ?? '(unnamed)')} — #${esc(f.carline_tag_number)}</div>`
          )
          .join('') || `<span class="muted">No matches</span>`;
        resultsEl.querySelectorAll('[data-pick-family]').forEach((el) =>
          el.addEventListener('click', () => {
            familyOverrideTarget.set(id, el.dataset.pickFamily);
            loadReviewQueue();
          })
        );
      }, 250);
    });
  });
}

async function reviewCandidates(ids, status) {
  if (!ids.length) return;

  // Apply any manually-chosen target family before flipping status — the approve
  // then links to whatever the reviewer actually picked, not the auto-suggestion.
  for (const id of ids) {
    if (!familyOverrideTarget.has(id)) continue;
    const { error: overrideErr } = await supabase
      .from('ic_reconciliation_candidates')
      .update({ existing_record_id: familyOverrideTarget.get(id) })
      .eq('id', id);
    if (overrideErr) {
      dbError(overrideErr, 'Failed to apply target family override');
      return;
    }
    familyOverrideTarget.delete(id);
  }

  // Persist which changed fields the reviewer opted to pull in for this specific
  // record — only relevant on approve, but harmless to write regardless.
  for (const id of ids) {
    if (!fieldOverrideSelections.has(id)) continue;
    const selected = [...fieldOverrideSelections.get(id)];
    if (!selected.length) continue;
    const { error: fieldErr } = await supabase
      .from('ic_reconciliation_candidates')
      .update({ field_overrides: selected })
      .eq('id', id);
    if (fieldErr) {
      dbError(fieldErr, 'Failed to save field selection');
      return;
    }
    fieldOverrideSelections.delete(id);
  }

  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('ic_reconciliation_candidates')
    .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: user?.id ?? null })
    .in('id', ids);

  if (error) {
    dbError(error, 'Failed to update review status');
    return;
  }
  await loadReviewQueue();
}

const FIELD_LABELS = {
  grade_level: 'Grade',
  birthdate: 'Date of birth',
  student_number: 'Student #',
  email: 'Email',
  phone: 'Phone',
  name: 'Name',
  active: 'Active status',
  guardian_link: 'Linked to student',
  family: 'Family',
};

const NON_PULLABLE_DIFF_FIELDS = new Set(['name', 'active', 'guardian_link', 'family']);

async function loadDataGaps() {
  const wrap = document.getElementById('icGapsWrap');
  const countEl = document.getElementById('icGapsCount');

  const { data: gaps, error, count } = await supabase
    .from('ic_data_gaps')
    .select('*', { count: 'exact' })
    .eq('school_id', profile.school_id)
    .is('resolved_at', null)
    .order('first_detected_at', { ascending: true })
    .limit(100);

  if (error) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">Failed to load data gaps: ${esc(error.message)}</p>`;
    return;
  }

  countEl.textContent = count ? `(${count})` : '';

  if (!gaps?.length) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">No known gaps right now.</p>`;
    return;
  }

  const studentIds = gaps.filter((g) => g.entity_type === 'student').map((g) => g.entity_id);
  const guardianIds = gaps.filter((g) => g.entity_type === 'guardian').map((g) => g.entity_id);

  const [{ data: students }, { data: guardians }] = await Promise.all([
    studentIds.length
      ? supabase.from('students').select('id, first_name, last_name').in('id', studentIds)
      : Promise.resolve({ data: [] }),
    guardianIds.length
      ? supabase.from('guardians').select('id, first_name, last_name').in('id', guardianIds)
      : Promise.resolve({ data: [] }),
  ]);

  const nameById = new Map([
    ...(students ?? []).map((s) => [s.id, `${s.first_name} ${s.last_name}`]),
    ...(guardians ?? []).map((g) => [g.id, `${g.first_name} ${g.last_name}`]),
  ]);

  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Name</th>
          <th>Missing field</th>
          <th>Belltower value (preserved)</th>
          <th>First flagged</th>
        </tr>
      </thead>
      <tbody>
        ${gaps.map(gapRowHtml(nameById)).join('')}
      </tbody>
    </table>
    ${count > 100 ? `<p class="muted" style="font-size:12px;margin-top:8px;">Showing 100 of ${count}.</p>` : ''}
  `;
}

function gapRowHtml(nameById) {
  return (g) => {
    const name = nameById.get(g.entity_id) ?? '(unknown)';
    const flagged = new Date(g.first_detected_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `
      <tr>
        <td style="text-transform:capitalize;">${esc(g.entity_type)}</td>
        <td>${esc(name)}</td>
        <td>${esc(FIELD_LABELS[g.field] ?? g.field)}</td>
        <td>${esc(g.belltower_value ?? '—')}</td>
        <td class="muted">${esc(flagged)}</td>
      </tr>
    `;
  };
}

const selectedDiffIds = new Set();

async function loadFieldDiffs() {
  const wrap = document.getElementById('icDiffsWrap');
  const countEl = document.getElementById('icDiffsCount');

  const { data: diffs, error, count } = await supabase
    .from('ic_field_diffs')
    .select('*', { count: 'exact' })
    .eq('school_id', profile.school_id)
    .is('resolved_at', null)
    .order('first_detected_at', { ascending: true })
    .limit(100);

  if (error) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">Failed to load field differences: ${esc(error.message)}</p>`;
    return;
  }

  countEl.textContent = count ? `(${count})` : '';

  if (!diffs?.length) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">No known differences right now.</p>`;
    return;
  }

  const studentIds = diffs.filter((d) => d.entity_type === 'student').map((d) => d.entity_id);
  const guardianIds = diffs.filter((d) => d.entity_type === 'guardian').map((d) => d.entity_id);

  const [{ data: students }, { data: guardians }] = await Promise.all([
    studentIds.length
      ? supabase.from('students').select('id, first_name, last_name').in('id', studentIds)
      : Promise.resolve({ data: [] }),
    guardianIds.length
      ? supabase.from('guardians').select('id, first_name, last_name').in('id', guardianIds)
      : Promise.resolve({ data: [] }),
  ]);

  const nameById = new Map([
    ...(students ?? []).map((s) => [s.id, `${s.first_name} ${s.last_name}`]),
    ...(guardians ?? []).map((g) => [g.id, `${g.first_name} ${g.last_name}`]),
  ]);

  // Selections don't survive a field no longer being open (record disappeared, or
  // was resolved by someone else) — drop anything stale before rendering.
  const pullableIds = new Set(diffs.filter((d) => !NON_PULLABLE_DIFF_FIELDS.has(d.field)).map((d) => d.id));
  for (const id of [...selectedDiffIds]) {
    if (!pullableIds.has(id)) selectedDiffIds.delete(id);
  }

  const bulkBar = `
    <div style="display:flex;align-items:center;gap:10px;margin:10px 0;">
      <button class="btn btn-sm btn-primary" data-bulk-pull disabled>Pull in IC's value for Selected</button>
      <span class="muted ic-diff-selected-count" style="font-size:12px;"></span>
    </div>
  `;

  wrap.innerHTML = `
    ${bulkBar}
    <table class="admin-table">
      <thead>
        <tr>
          <th style="width:32px;"><input type="checkbox" id="icDiffSelectAllCheckbox"></th>
          <th>Type</th>
          <th>Name</th>
          <th>Field</th>
          <th>Belltower value</th>
          <th>Infinite Campus value</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${diffs.map(diffRowHtml(nameById)).join('')}
      </tbody>
    </table>
    ${count > 100 ? `<p class="muted" style="font-size:12px;margin-top:8px;">Showing 100 of ${count}.</p>` : ''}
    ${bulkBar}
  `;

  wrap.querySelectorAll('[data-pull-diff]').forEach((btn) =>
    btn.addEventListener('click', () => applyFieldPull([btn.dataset.pullDiff], btn))
  );

  const rowCheckboxes = [...wrap.querySelectorAll('[data-select-diff]')];
  const selectAll = document.getElementById('icDiffSelectAllCheckbox');
  const bulkPullBtns = [...wrap.querySelectorAll('[data-bulk-pull]')];
  const selectedCountEls = [...wrap.querySelectorAll('.ic-diff-selected-count')];

  const updateBulkButtons = () => {
    const n = selectedDiffIds.size;
    bulkPullBtns.forEach((btn) => (btn.disabled = n === 0));
    selectedCountEls.forEach((el) => (el.textContent = n ? `${n} selected` : ''));
  };

  rowCheckboxes.forEach((cb) => {
    cb.checked = selectedDiffIds.has(cb.dataset.selectDiff);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedDiffIds.add(cb.dataset.selectDiff);
      else selectedDiffIds.delete(cb.dataset.selectDiff);
      selectAll.checked = rowCheckboxes.every((c) => c.checked);
      updateBulkButtons();
    });
  });
  selectAll.checked = rowCheckboxes.length > 0 && rowCheckboxes.every((c) => c.checked);
  selectAll.addEventListener('change', () => {
    rowCheckboxes.forEach((cb) => {
      cb.checked = selectAll.checked;
      if (selectAll.checked) selectedDiffIds.add(cb.dataset.selectDiff);
      else selectedDiffIds.delete(cb.dataset.selectDiff);
    });
    updateBulkButtons();
  });

  bulkPullBtns.forEach((btn) =>
    btn.addEventListener('click', () => applyFieldPull([...selectedDiffIds], btn))
  );

  updateBulkButtons();
}

function diffRowHtml(nameById) {
  return (d) => {
    const name = nameById.get(d.entity_id) ?? '(unknown)';
    // Identity/status/relationship differences are informational only — surfaced here
    // for visibility, but there's no direct pull action for them; handle in the Admin
    // Panel or the review queue instead.
    const pullable = !NON_PULLABLE_DIFF_FIELDS.has(d.field);
    return `
      <tr>
        <td>${pullable ? `<input type="checkbox" data-select-diff="${d.id}">` : ''}</td>
        <td style="text-transform:capitalize;">${esc(d.entity_type)}</td>
        <td>${esc(name)}</td>
        <td>${esc(FIELD_LABELS[d.field] ?? d.field)}</td>
        <td>${esc(d.belltower_value ?? '—')}</td>
        <td>${esc(d.ic_value ?? '—')}</td>
        <td>${pullable ? `<button class="btn-secondary" style="font-size:12px;padding:4px 10px;" data-pull-diff="${d.id}">Pull in IC's value</button>` : ''}</td>
      </tr>
    `;
  };
}

async function applyFieldPull(diffIds, btn) {
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Applying…';

  const { data, error } = await supabase.functions.invoke('sync_infinite_campus', {
    body: { apply_field_pull: diffIds },
  });

  if (error || data?.error || data?.results?.some((r) => !r.ok)) {
    const failCount = data?.results?.filter((r) => !r.ok).length ?? diffIds.length;
    dbError(
      error || new Error(data?.error || `${failCount} of ${diffIds.length} field pull(s) failed`),
      'Failed to apply field pull'
    );
    btn.disabled = false;
    btn.textContent = originalLabel;
  }

  for (const id of diffIds) selectedDiffIds.delete(id);
  await loadFieldDiffs();
}

async function loadRuns() {
  const wrap = document.getElementById('icRunsTableWrap');
  const { data: runs, error } = await supabase
    .from('ic_sync_runs')
    .select('*')
    .eq('school_id', profile.school_id)
    .order('started_at', { ascending: false })
    .limit(25);

  if (error) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">Failed to load sync history: ${esc(error.message)}</p>`;
    return;
  }

  if (!runs?.length) {
    wrap.innerHTML = `<p class="muted" style="font-size:13px;">No sync runs yet.</p>`;
    return;
  }

  wrap.innerHTML = `
    <table class="admin-table">
      <thead>
        <tr>
          <th>Started</th>
          <th>Status</th>
          <th>Students (new / updated / deactivated)</th>
          <th>Guardians (new / updated)</th>
          <th>Families created</th>
          <th>Awaiting review</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${runs.map(rowHtml).join('')}
      </tbody>
    </table>
  `;
}

function rowHtml(run) {
  const started = new Date(run.started_at).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  return `
    <tr>
      <td>${esc(started)}</td>
      <td><span class="ic-status-badge ic-status-${esc(run.status)}">${esc(run.status)}</span></td>
      <td>${run.students_created} / ${run.students_updated} / ${run.students_deactivated}</td>
      <td>${run.guardians_created} / ${run.guardians_updated}</td>
      <td>${run.families_created}</td>
      <td>${(run.students_awaiting_review ?? 0) + (run.guardians_awaiting_review ?? 0)}</td>
      <td class="muted" style="font-size:12px;max-width:220px;">${run.error_message ? esc(run.error_message) : '—'}</td>
    </tr>
  `;
}
